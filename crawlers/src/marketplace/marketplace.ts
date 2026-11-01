import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireUser, requireAdmin, audit } from '../auth/auth.js';
import { StorageBackend } from '../utils/storageBackend.js';
import { CareProvider, ClinicalTrial, Company } from '../models/types.js';
import { Mailer } from '../notify/mailer.js';
import { rateLimit, clientIp } from '../web/rateLimit.js';
import { stripeConfigured, stripePost } from '../billing/stripe.js';
import { logger } from '../utils/logger.js';

/**
 * The marketplace: Neuly connects people to care providers and studies, and
 * the institutions pay for the introductions.
 *
 *  - Every signed-in look at an entity is logged (entity_views) — the
 *    activity log partners see in aggregate.
 *  - A user who wants care, or wants to join a study, submits a lead
 *    (contact details + what they are looking for). The partner is notified.
 *  - An institution claims its listing (entity_claims, admin-approved), sees
 *    its activity and masked leads, and unlocks a lead's contact details
 *    with a one-off Stripe payment (lead_purchases) — or an admin comps it.
 */

export const LEAD_KINDS = ['care_inquiry', 'study_interest'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

/** Entity types that can be claimed and generate leads */
export const CLAIMABLE_TYPES: Record<string, { label: string; leadKind: LeadKind; priceEnv: string; defaultCents: number }> = {
  care_providers: { label: 'Care provider', leadKind: 'care_inquiry', priceEnv: 'LEAD_PRICE_CARE_CENTS', defaultCents: 4900 },
  clinical_trials: { label: 'Clinical study', leadKind: 'study_interest', priceEnv: 'LEAD_PRICE_STUDY_CENTS', defaultCents: 14900 },
  companies: { label: 'Company', leadKind: 'care_inquiry', priceEnv: 'LEAD_PRICE_COMPANY_CENTS', defaultCents: 9900 }
};

export function defaultLeadPriceCents(entityType: string): number {
  const spec = CLAIMABLE_TYPES[entityType];
  if (!spec) return 9900;
  const fromEnv = Number(process.env[spec.priceEnv]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.round(fromEnv) : spec.defaultCents;
}

const requireDb = (_req: Request, res: Response, next: NextFunction) => {
  if (!appDbAvailable()) {
    res.status(503).json({ error: 'This feature requires the Postgres backend (set DATABASE_URL)' });
    return;
  }
  next();
};

function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const clean = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Mask a lead for partners who have not unlocked it. Exported for tests. */
export function maskLead(lead: { contact: Record<string, unknown>; details: Record<string, unknown> }): { contact: Record<string, unknown>; details: Record<string, unknown> } {
  const name = typeof lead.contact.name === 'string' ? lead.contact.name : '';
  const initials = name.split(/\s+/).filter(Boolean).map(w => `${w[0].toUpperCase()}.`).join(' ');
  const email = typeof lead.contact.email === 'string' ? lead.contact.email : '';
  const domain = email.includes('@') ? email.split('@')[1] : undefined;
  return {
    contact: {
      name: initials || 'Anonymous',
      emailDomain: domain,
      location: lead.contact.location,
      phone: lead.contact.phone ? '•••-•••-••••' : undefined
    },
    details: {
      condition: lead.details.condition,
      interest: lead.details.interest,
      ageRange: lead.details.ageRange,
      preferredContact: lead.details.preferredContact,
      // the free-text message is part of what is purchased
      messagePreview: typeof lead.details.message === 'string' ? `${lead.details.message.slice(0, 60)}${lead.details.message.length > 60 ? '…' : ''}` : undefined
    }
  };
}

/** Look up a claimable entity's display title from storage */
async function entityTitle(storage: StorageBackend, entityType: string, entityId: string): Promise<string | null> {
  if (entityType === 'care_providers') {
    const rows = await storage.load<CareProvider>('care_providers');
    return rows.find(r => r.id === entityId)?.name ?? null;
  }
  if (entityType === 'clinical_trials') {
    const rows = await storage.load<ClinicalTrial>('clinical_trials');
    const t = rows.find(r => r.id === entityId || r.nctId.toLowerCase() === entityId.toLowerCase());
    return t ? `${t.nctId} — ${t.title}` : null;
  }
  if (entityType === 'companies') {
    const rows = await storage.load<Company>('companies');
    return rows.find(r => r.id === entityId)?.name ?? null;
  }
  return null;
}

async function approvedClaimsFor(entityType: string, entityId: string) {
  const result = await getAppDb().query(
    `SELECT c.id, c.user_id, c.contact_email, c.notify_email, c.organization, u.email AS user_email
     FROM entity_claims c JOIN users u ON u.id = c.user_id
     WHERE c.entity_type = $1 AND c.entity_id = $2 AND c.status = 'approved'`,
    [entityType, entityId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Tracking + leads (the user side)
// ---------------------------------------------------------------------------

export function trackingRouter(): Router {
  const router = Router();
  router.use(requireDb);

  // Fire-and-forget from the frontend whenever a signed-in user opens an
  // entity. Anonymous views are not stored: everything is behind an account.
  router.post('/view', requireUser, async (req: AuthedRequest, res: Response) => {
    const entityType = clean(req.body?.entityType, 60);
    const entityId = clean(req.body?.entityId, 300);
    if (!entityType || !entityId) return res.status(400).json({ error: 'entityType and entityId are required' });
    await getAppDb().query(
      'INSERT INTO entity_views (user_id, entity_type, entity_id, entity_title) VALUES ($1, $2, $3, $4)',
      [req.user!.id, entityType, entityId, clean(req.body?.entityTitle, 500)]
    ).catch(error => logger.warn(`[track] view insert failed: ${error instanceof Error ? error.message : error}`));
    res.status(202).json({ ok: true });
  });

  return router;
}

export function leadsRouter(storage: StorageBackend, mailer = new Mailer()): Router {
  const router = Router();
  router.use(requireDb);

  const submitLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyFor: req => `leads:${clientIp(req)}`, message: 'Too many requests — try again later' });

  /**
   * Submit a lead. Body: entityType, entityId, kind, contact {name, email,
   * phone, location}, details {message, condition, interest, ageRange,
   * preferredContact}, consent (must be true).
   */
  router.post('/', requireUser, submitLimit, async (req: AuthedRequest, res: Response) => {
    const entityType = clean(req.body?.entityType, 60);
    const entityId = clean(req.body?.entityId, 300);
    const spec = entityType ? CLAIMABLE_TYPES[entityType] : undefined;
    if (!entityType || !entityId || !spec) {
      return res.status(400).json({ error: `entityType must be one of ${Object.keys(CLAIMABLE_TYPES).join(', ')}` });
    }
    const kind: LeadKind = LEAD_KINDS.includes(req.body?.kind) ? req.body.kind : spec.leadKind;
    const c = req.body?.contact ?? {};
    const d = req.body?.details ?? {};
    const contact = {
      name: clean(c.name, 200) ?? req.user!.name ?? null,
      email: clean(c.email, 254) ?? req.user!.email,
      phone: clean(c.phone, 40),
      location: clean(c.location, 200)
    };
    if (!contact.name || !contact.email) return res.status(400).json({ error: 'Name and email are required' });
    if (req.body?.consent !== true) return res.status(400).json({ error: 'Consent to share your details with the provider is required' });
    const details = {
      message: clean(d.message, 2000),
      condition: clean(d.condition, 200),
      interest: clean(d.interest, 200),
      ageRange: clean(d.ageRange, 40),
      preferredContact: clean(d.preferredContact, 40),
      availability: clean(d.availability, 200)
    };

    const title = (await entityTitle(storage, entityType, entityId).catch(() => null)) ?? clean(req.body?.entityTitle, 500);
    if (!title) return res.status(404).json({ error: 'That listing could not be found' });

    const id = `lead_${randomUUID()}`;
    await getAppDb().query(
      `INSERT INTO leads (id, user_id, kind, entity_type, entity_id, entity_title, contact, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.user!.id, kind, entityType, entityId, title, JSON.stringify(contact), JSON.stringify(details)]
    );
    await audit(req.user!.id, 'lead.created', id, { entityType, entityId, kind });

    // Notify claimed partners (masked) and the operator
    try {
      const partners = await approvedClaimsFor(entityType, entityId);
      const masked = maskLead({ contact, details });
      for (const partner of partners.filter(p => p.notify_email)) {
        await mailer.send({
          to: partner.contact_email || partner.user_email,
          subject: `New ${kind === 'study_interest' ? 'study participant' : 'patient'} lead for ${title}`,
          html: [
            `<p>Someone on Neuly just asked to be connected with <strong>${escapeHtml(title)}</strong>.</p>`,
            `<p>${escapeHtml(String(masked.contact.name))}${masked.contact.location ? ` · ${escapeHtml(String(masked.contact.location))}` : ''}${masked.details.condition ? ` · ${escapeHtml(String(masked.details.condition))}` : ''}</p>`,
            `<p><a href="${siteUrl()}/partners">Open your partner dashboard</a> to see the request and unlock their contact details.</p>`
          ].join('\n')
        });
      }
      const admins = (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (admins[0]) {
        await mailer.send({
          to: admins[0],
          subject: `[Neuly] New lead: ${title}`,
          html: `<p>${escapeHtml(kind)} · ${escapeHtml(contact.name)} &lt;${escapeHtml(contact.email)}&gt; → ${escapeHtml(title)}${partners.length === 0 ? ' (listing not claimed yet)' : ''}</p><p><a href="${siteUrl()}/admin">Admin console</a></p>`
        });
      }
    } catch (error) {
      logger.warn(`[leads] notification failed: ${error instanceof Error ? error.message : error}`);
    }

    res.status(201).json({ ok: true, id, message: kind === 'study_interest' ? 'Thanks — the study team will reach out if you may be a fit.' : 'Thanks — the provider will be in touch shortly.' });
  });

  // The user's own requests
  router.get('/mine', requireUser, async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT id, kind, entity_type, entity_id, entity_title, status, created_at FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user!.id]
    );
    res.json({ data: result.rows.map(r => ({ id: r.id, kind: r.kind, entityType: r.entity_type, entityId: r.entity_id, entityTitle: r.entity_title, status: r.status, createdAt: r.created_at })) });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Partners (the institution side)
// ---------------------------------------------------------------------------

export function partnersRouter(storage: StorageBackend): Router {
  const router = Router();
  router.use(requireDb);
  router.use(requireUser);

  // Search claimable listings by name
  router.get('/search', async (req: AuthedRequest, res: Response) => {
    const q = (clean(req.query.q, 100) ?? '').toLowerCase();
    if (q.length < 2) return res.json({ data: [] });
    const [care, trials, companies] = await Promise.all([
      storage.load<CareProvider>('care_providers'),
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<Company>('companies')
    ]);
    const data = [
      ...care.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8).map(c => ({ entityType: 'care_providers', entityId: c.id, title: c.name, subtitle: [c.type, c.location?.city, c.location?.state].filter(Boolean).join(' · ') })),
      ...trials.filter(t => t.title.toLowerCase().includes(q) || t.nctId.toLowerCase() === q || (t.sponsor ?? '').toLowerCase().includes(q)).slice(0, 8).map(t => ({ entityType: 'clinical_trials', entityId: t.id, title: `${t.nctId} — ${t.title}`, subtitle: [t.phase, t.status, t.sponsor].filter(Boolean).join(' · ') })),
      ...companies.filter(c => c.name.toLowerCase().includes(q)).slice(0, 5).map(c => ({ entityType: 'companies', entityId: c.id, title: c.name, subtitle: [c.type, c.stage].filter(Boolean).join(' · ') }))
    ];
    res.json({ data });
  });

  router.post('/claims', async (req: AuthedRequest, res: Response) => {
    const entityType = clean(req.body?.entityType, 60);
    const entityId = clean(req.body?.entityId, 300);
    const organization = clean(req.body?.organization, 200);
    const contactEmail = clean(req.body?.contactEmail, 254) ?? req.user!.email;
    if (!entityType || !CLAIMABLE_TYPES[entityType] || !entityId || !organization) {
      return res.status(400).json({ error: 'entityType, entityId and organization are required' });
    }
    const title = await entityTitle(storage, entityType, entityId).catch(() => null);
    if (!title) return res.status(404).json({ error: 'That listing could not be found' });

    const id = `clm_${randomUUID()}`;
    try {
      await getAppDb().query(
        `INSERT INTO entity_claims (id, user_id, entity_type, entity_id, entity_title, organization, contact_email, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, req.user!.id, entityType, entityId, title, organization, contactEmail, clean(req.body?.message, 1000)]
      );
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) return res.status(409).json({ error: 'You have already claimed this listing' });
      throw error;
    }
    await audit(req.user!.id, 'claim.created', id, { entityType, entityId });
    res.status(201).json({ ok: true, id, status: 'pending', message: 'Claim submitted — we verify every claim by hand, usually within one business day.' });
  });

  /** My claims with headline activity for approved ones */
  router.get('/claims', async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT c.*,
              (SELECT count(*)::int FROM entity_views v WHERE v.entity_type = c.entity_type AND v.entity_id = c.entity_id AND v.viewed_at > now() - interval '30 days') AS views_30d,
              (SELECT count(DISTINCT v.user_id)::int FROM entity_views v WHERE v.entity_type = c.entity_type AND v.entity_id = c.entity_id AND v.viewed_at > now() - interval '30 days') AS viewers_30d,
              (SELECT count(*)::int FROM leads l WHERE l.entity_type = c.entity_type AND l.entity_id = c.entity_id) AS leads_total,
              (SELECT count(*)::int FROM lead_purchases p WHERE p.claim_id = c.id AND p.status IN ('paid', 'comped')) AS leads_unlocked
       FROM entity_claims c WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
      [req.user!.id]
    );
    res.json({
      data: result.rows.map(r => ({
        id: r.id, entityType: r.entity_type, entityId: r.entity_id, entityTitle: r.entity_title,
        organization: r.organization, contactEmail: r.contact_email, status: r.status,
        leadPriceCents: r.lead_price_cents ?? defaultLeadPriceCents(r.entity_type), notifyEmail: r.notify_email,
        createdAt: r.created_at, reviewedAt: r.reviewed_at,
        stats: r.status === 'approved' ? { views30d: r.views_30d, viewers30d: r.viewers_30d, leadsTotal: r.leads_total, leadsUnlocked: r.leads_unlocked } : undefined
      })),
      billingEnabled: stripeConfigured()
    });
  });

  /** Activity log + leads (masked until unlocked) for one approved claim */
  router.get('/claims/:id/activity', async (req: AuthedRequest, res: Response) => {
    const claim = (await getAppDb().query('SELECT * FROM entity_claims WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.id])).rows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'approved') return res.status(403).json({ error: 'This claim is awaiting approval', status: claim.status });

    const [daily, byLocation, leads, totals] = await Promise.all([
      getAppDb().query(
        `SELECT date_trunc('day', viewed_at)::date AS day, count(*)::int AS views, count(DISTINCT user_id)::int AS viewers
         FROM entity_views WHERE entity_type = $1 AND entity_id = $2 AND viewed_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`, [claim.entity_type, claim.entity_id]),
      getAppDb().query(
        `SELECT COALESCE(u.organization, 'Individual') AS segment, count(DISTINCT v.user_id)::int AS viewers
         FROM entity_views v LEFT JOIN users u ON u.id = v.user_id
         WHERE v.entity_type = $1 AND v.entity_id = $2 AND v.viewed_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [claim.entity_type, claim.entity_id]),
      getAppDb().query(
        `SELECT l.id, l.kind, l.contact, l.details, l.status, l.created_at,
                p.status AS purchase_status, p.paid_at
         FROM leads l LEFT JOIN lead_purchases p ON p.lead_id = l.id AND p.claim_id = $3
         WHERE l.entity_type = $1 AND l.entity_id = $2 AND l.status <> 'spam'
         ORDER BY l.created_at DESC LIMIT 200`, [claim.entity_type, claim.entity_id, claim.id]),
      getAppDb().query(
        `SELECT count(*)::int AS views_all, count(DISTINCT user_id)::int AS viewers_all FROM entity_views WHERE entity_type = $1 AND entity_id = $2`,
        [claim.entity_type, claim.entity_id])
    ]);
    const price = claim.lead_price_cents ?? defaultLeadPriceCents(claim.entity_type);
    res.json({
      claim: { id: claim.id, entityType: claim.entity_type, entityId: claim.entity_id, entityTitle: claim.entity_title, organization: claim.organization, leadPriceCents: price },
      totals: { viewsAllTime: totals.rows[0].views_all, viewersAllTime: totals.rows[0].viewers_all, leads: leads.rows.length, unlocked: leads.rows.filter(l => ['paid', 'comped'].includes(l.purchase_status)).length },
      daily: daily.rows.map(r => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day), views: r.views, viewers: r.viewers })),
      segments: byLocation.rows,
      leads: leads.rows.map(l => {
        const unlocked = ['paid', 'comped'].includes(l.purchase_status);
        const shown = unlocked ? { contact: l.contact, details: l.details } : maskLead({ contact: l.contact, details: l.details });
        return { id: l.id, kind: l.kind, status: l.status, createdAt: l.created_at, unlocked, unlockedAt: l.paid_at, priceCents: price, ...shown };
      }),
      billingEnabled: stripeConfigured()
    });
  });

  router.patch('/claims/:id', async (req: AuthedRequest, res: Response) => {
    const claim = (await getAppDb().query('SELECT id FROM entity_claims WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.id])).rows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof req.body?.notifyEmail === 'boolean') { params.push(req.body.notifyEmail); sets.push(`notify_email = $${params.length}`); }
    const contactEmail = clean(req.body?.contactEmail, 254);
    if (contactEmail) { params.push(contactEmail); sets.push(`contact_email = $${params.length}`); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(claim.id);
    await getAppDb().query(`UPDATE entity_claims SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  });

  /**
   * Unlock a lead: creates a Stripe Checkout session (one-off payment) and
   * a pending purchase. The webhook marks it paid; contact details appear
   * in the activity view immediately after.
   */
  router.post('/leads/:leadId/unlock', async (req: AuthedRequest, res: Response) => {
    const claimId = clean(req.body?.claimId, 80);
    if (!claimId) return res.status(400).json({ error: 'claimId is required' });
    const claim = (await getAppDb().query("SELECT * FROM entity_claims WHERE id = $1 AND user_id = $2 AND status = 'approved'", [claimId, req.user!.id])).rows[0];
    if (!claim) return res.status(404).json({ error: 'Approved claim not found' });
    const lead = (await getAppDb().query('SELECT * FROM leads WHERE id = $1 AND entity_type = $2 AND entity_id = $3', [req.params.leadId, claim.entity_type, claim.entity_id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found for this listing' });

    const existing = (await getAppDb().query('SELECT * FROM lead_purchases WHERE lead_id = $1 AND claim_id = $2', [lead.id, claim.id])).rows[0];
    if (existing && ['paid', 'comped'].includes(existing.status)) return res.json({ ok: true, alreadyUnlocked: true });

    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Online payment is not configured yet — email sales@neuly.io and we will unlock the lead for you' });
    }
    const amount = claim.lead_price_cents ?? defaultLeadPriceCents(claim.entity_type);
    const purchaseId = existing?.id ?? `lp_${randomUUID()}`;
    try {
      const session = await stripePost('/checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][price_data][product_data][name]': `Neuly lead: ${lead.entity_title.slice(0, 80)}`,
        'line_items[0][price_data][product_data][description]': `Contact details for a ${lead.kind === 'study_interest' ? 'study participant' : 'patient'} inquiry submitted on Neuly`,
        'line_items[0][quantity]': '1',
        customer_email: req.user!.email,
        client_reference_id: req.user!.id,
        'metadata[kind]': 'lead_unlock',
        'metadata[purchaseId]': purchaseId,
        'metadata[leadId]': lead.id,
        'metadata[claimId]': claim.id,
        'metadata[userId]': req.user!.id,
        success_url: `${siteUrl()}/partners?unlocked=${purchaseId}&claim=${claim.id}`,
        cancel_url: `${siteUrl()}/partners?claim=${claim.id}`
      });
      if (existing) {
        await getAppDb().query('UPDATE lead_purchases SET stripe_session_id = $1, amount_cents = $2 WHERE id = $3', [session.id, amount, purchaseId]);
      } else {
        await getAppDb().query(
          'INSERT INTO lead_purchases (id, lead_id, claim_id, buyer_user_id, amount_cents, stripe_session_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [purchaseId, lead.id, claim.id, req.user!.id, amount, session.id]
        );
      }
      res.json({ url: session.url, amountCents: amount });
    } catch (error) {
      logger.error(`[partners] unlock checkout failed: ${error instanceof Error ? error.message : error}`);
      res.status(502).json({ error: 'Failed to start checkout' });
    }
  });

  return router;
}

/** Called by the Stripe webhook for checkout sessions with metadata.kind = lead_unlock */
export async function markLeadPurchasePaid(session: { id?: string; metadata?: Record<string, string>; amount_total?: number }): Promise<void> {
  const purchaseId = session.metadata?.purchaseId;
  if (!purchaseId) return;
  await getAppDb().query(
    `UPDATE lead_purchases SET status = 'paid', paid_at = now(), stripe_session_id = COALESCE($2, stripe_session_id),
       amount_cents = COALESCE($3, amount_cents)
     WHERE id = $1`,
    [purchaseId, session.id ?? null, typeof session.amount_total === 'number' ? session.amount_total : null]
  );
  await audit(session.metadata?.userId ?? null, 'lead.unlocked', session.metadata?.leadId, { purchaseId, claimId: session.metadata?.claimId });
  logger.info(`[partners] lead purchase ${purchaseId} paid`);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function marketplaceAdminRouter(): Router {
  const router = Router();
  router.use(requireDb);
  router.use(requireAdmin);

  router.get('/overview', async (_req: AuthedRequest, res: Response) => {
    const [claims, leads, revenue, views] = await Promise.all([
      getAppDb().query('SELECT status, count(*)::int AS n FROM entity_claims GROUP BY status'),
      getAppDb().query("SELECT kind, count(*)::int AS n, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7d FROM leads GROUP BY kind"),
      getAppDb().query("SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS paid_cents, count(*) FILTER (WHERE status = 'paid')::int AS paid, count(*) FILTER (WHERE status = 'comped')::int AS comped FROM lead_purchases"),
      getAppDb().query("SELECT count(*)::int AS views_7d, count(DISTINCT user_id)::int AS viewers_7d FROM entity_views WHERE viewed_at > now() - interval '7 days'")
    ]);
    res.json({
      claims: Object.fromEntries(claims.rows.map(r => [r.status, r.n])),
      leads: leads.rows,
      revenue: { paidCents: revenue.rows[0].paid_cents, paidLeads: revenue.rows[0].paid, compedLeads: revenue.rows[0].comped },
      views: views.rows[0],
      prices: Object.fromEntries(Object.keys(CLAIMABLE_TYPES).map(t => [t, defaultLeadPriceCents(t)]))
    });
  });

  router.get('/claims', async (req: AuthedRequest, res: Response) => {
    const status = clean(req.query.status, 20);
    const params: unknown[] = [];
    let where = '';
    if (status) { params.push(status); where = 'WHERE c.status = $1'; }
    const result = await getAppDb().query(
      `SELECT c.*, u.email AS user_email, u.name AS user_name FROM entity_claims c JOIN users u ON u.id = c.user_id ${where} ORDER BY c.created_at DESC LIMIT 200`, params);
    res.json({ data: result.rows.map(r => ({ id: r.id, userEmail: r.user_email, userName: r.user_name, entityType: r.entity_type, entityId: r.entity_id, entityTitle: r.entity_title, organization: r.organization, contactEmail: r.contact_email, message: r.message, status: r.status, leadPriceCents: r.lead_price_cents ?? defaultLeadPriceCents(r.entity_type), createdAt: r.created_at, reviewedAt: r.reviewed_at })) });
  });

  router.patch('/claims/:id', async (req: AuthedRequest, res: Response) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (['pending', 'approved', 'rejected'].includes(req.body?.status)) {
      params.push(req.body.status); sets.push(`status = $${params.length}`);
      params.push(req.user!.id); sets.push(`reviewed_by = $${params.length}`);
      sets.push('reviewed_at = now()');
    }
    if (req.body?.leadPriceCents !== undefined) {
      const cents = req.body.leadPriceCents === null ? null : Math.round(Number(req.body.leadPriceCents));
      if (cents !== null && (!Number.isFinite(cents) || cents < 100)) return res.status(400).json({ error: 'leadPriceCents must be at least 100' });
      params.push(cents); sets.push(`lead_price_cents = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const result = await getAppDb().query(`UPDATE entity_claims SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, status, lead_price_cents`, params);
    if (!result.rows[0]) return res.status(404).json({ error: 'Claim not found' });
    await audit(req.user!.id, 'admin.claim_updated', req.params.id, { status: req.body?.status, leadPriceCents: req.body?.leadPriceCents });
    res.json({ data: result.rows[0] });
  });

  router.get('/leads', async (req: AuthedRequest, res: Response) => {
    const limit = Math.min(500, parseInt(req.query.limit as string) || 100);
    const result = await getAppDb().query(
      `SELECT l.*, u.email AS user_email,
              (SELECT count(*)::int FROM entity_claims c WHERE c.entity_type = l.entity_type AND c.entity_id = l.entity_id AND c.status = 'approved') AS partners,
              (SELECT json_agg(json_build_object('claimId', p.claim_id, 'status', p.status, 'amountCents', p.amount_cents)) FROM lead_purchases p WHERE p.lead_id = l.id) AS purchases
       FROM leads l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT $1`, [limit]);
    res.json({ data: result.rows.map(r => ({ id: r.id, kind: r.kind, entityType: r.entity_type, entityId: r.entity_id, entityTitle: r.entity_title, contact: r.contact, details: r.details, status: r.status, userEmail: r.user_email, partners: r.partners, purchases: r.purchases ?? [], createdAt: r.created_at })) });
  });

  router.patch('/leads/:id', async (req: AuthedRequest, res: Response) => {
    if (!['new', 'contacted', 'closed', 'spam'].includes(req.body?.status)) return res.status(400).json({ error: 'status must be new, contacted, closed or spam' });
    const result = await getAppDb().query('UPDATE leads SET status = $1 WHERE id = $2 RETURNING id', [req.body.status, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  });

  /** Comp a lead to a partner (invoiced offline, or goodwill) */
  router.post('/leads/:id/comp', async (req: AuthedRequest, res: Response) => {
    const claimId = clean(req.body?.claimId, 80);
    if (!claimId) return res.status(400).json({ error: 'claimId is required' });
    const claim = (await getAppDb().query('SELECT * FROM entity_claims WHERE id = $1', [claimId])).rows[0];
    const lead = (await getAppDb().query('SELECT * FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!claim || !lead) return res.status(404).json({ error: 'Claim or lead not found' });
    await getAppDb().query(
      `INSERT INTO lead_purchases (id, lead_id, claim_id, buyer_user_id, amount_cents, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'comped', now())
       ON CONFLICT (lead_id, claim_id) DO UPDATE SET status = 'comped', paid_at = now()`,
      [`lp_${randomUUID()}`, lead.id, claim.id, claim.user_id, claim.lead_price_cents ?? defaultLeadPriceCents(claim.entity_type)]
    );
    await audit(req.user!.id, 'admin.lead_comped', lead.id, { claimId });
    res.json({ ok: true });
  });

  return router;
}

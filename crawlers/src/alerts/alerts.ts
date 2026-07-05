import { Router, Response, NextFunction, Request } from 'express';
import { randomUUID } from 'crypto';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireUser } from '../auth/auth.js';
import { StorageBackend } from '../utils/storageBackend.js';
import { ChangeEvent } from '../models/types.js';
import { Mailer } from '../notify/mailer.js';
import { logger } from '../utils/logger.js';

export interface AlertSubscription {
  id: string;
  userId: string;
  entityType: string | null;
  keyword: string | null;
  lastNotifiedAt: string;
}

/** Pure matcher — exported for tests */
export function matchEvents(subscription: Pick<AlertSubscription, 'entityType' | 'keyword'>, events: ChangeEvent[]): ChangeEvent[] {
  return events.filter(event => {
    if (subscription.entityType && event.entityType !== subscription.entityType) return false;
    if (subscription.keyword) {
      const needle = subscription.keyword.toLowerCase();
      const haystack = `${event.entityTitle} ${event.summary}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function renderAlertEmail(matches: ChangeEvent[], subscription: Pick<AlertSubscription, 'entityType' | 'keyword'>): { subject: string; html: string } {
  const scope = [
    subscription.entityType?.replace(/_/g, ' '),
    subscription.keyword ? `"${subscription.keyword}"` : undefined
  ].filter(Boolean).join(' · ') || 'all data';

  const items = matches
    .map(e => `<li><strong>${escapeHtml(e.summary)}</strong><br><small>${e.detectedAt.slice(0, 10)} · ${e.entityType.replace(/_/g, ' ')}</small></li>`)
    .join('\n');

  return {
    subject: `Neuly alert: ${matches.length} update${matches.length === 1 ? '' : 's'} (${scope})`,
    html: [
      `<h2>Neuly alert — ${escapeHtml(scope)}</h2>`,
      `<p>${matches.length} change${matches.length === 1 ? '' : 's'} since your last notification:</p>`,
      `<ul>${items}</ul>`,
      '<p><small>Manage your alerts in your Neuly account.</small></p>'
    ].join('\n')
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Daily alert dispatch: for each subscription, collect change events
 * since last notification, filter, email, advance the cursor.
 */
export async function runAlertDispatch(storage: StorageBackend, mailer = new Mailer()): Promise<{ sent: number }> {
  if (!appDbAvailable()) {
    logger.warn('[alerts] Skipping dispatch — requires Postgres backend');
    return { sent: 0 };
  }

  const db = getAppDb();
  const result = await db.query(
    `SELECT a.id, a.user_id, a.entity_type, a.keyword, a.last_notified_at, u.email
     FROM alert_subscriptions a JOIN users u ON u.id = a.user_id`
  );

  let sent = 0;
  for (const row of result.rows) {
    const since = row.last_notified_at.toISOString();
    const events = await storage.loadChangeEvents({ since, limit: 500 });
    const matches = matchEvents({ entityType: row.entity_type, keyword: row.keyword }, events);
    if (matches.length === 0) continue;

    try {
      const email = renderAlertEmail(matches, { entityType: row.entity_type, keyword: row.keyword });
      await mailer.send({ to: row.email, ...email });
      await db.query('UPDATE alert_subscriptions SET last_notified_at = now() WHERE id = $1', [row.id]);
      sent++;
    } catch (error) {
      logger.error(`[alerts] Failed to notify ${row.email}: ${error instanceof Error ? error.message : error}`);
    }
  }

  logger.info(`[alerts] Dispatch complete — ${sent} alert emails`);
  return { sent };
}

export function alertsRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!appDbAvailable()) {
      res.status(503).json({ error: 'Alerts require the Postgres backend (set DATABASE_URL)' });
      return;
    }
    next();
  });

  router.get('/', requireUser, async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT id, entity_type, keyword, created_at, last_notified_at
       FROM alert_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json({ data: result.rows });
  });

  router.post('/', requireUser, async (req: AuthedRequest, res: Response) => {
    const entityType = typeof req.body?.entityType === 'string' ? req.body.entityType : null;
    const keyword = typeof req.body?.keyword === 'string' && req.body.keyword.trim()
      ? req.body.keyword.trim().slice(0, 200)
      : null;

    // Free tier: 1 alert; pro and up: unlimited
    if (req.user!.plan === 'free') {
      const count = await getAppDb().query(
        'SELECT count(*)::int AS n FROM alert_subscriptions WHERE user_id = $1',
        [req.user!.id]
      );
      if (count.rows[0].n >= 1) {
        return res.status(403).json({ error: 'The free plan includes 1 alert — upgrade to Pro for unlimited alerts' });
      }
    }

    const id = `alr_${randomUUID()}`;
    await getAppDb().query(
      'INSERT INTO alert_subscriptions (id, user_id, entity_type, keyword) VALUES ($1, $2, $3, $4)',
      [id, req.user!.id, entityType, keyword]
    );
    res.status(201).json({ id, entityType, keyword });
  });

  router.delete('/:id', requireUser, async (req: AuthedRequest, res: Response) => {
    await getAppDb().query(
      'DELETE FROM alert_subscriptions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.id]
    );
    res.json({ ok: true });
  });

  return router;
}

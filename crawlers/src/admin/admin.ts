import { Router, Request, Response, NextFunction } from 'express';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireAdmin, audit, toAuthedUser, Plan, Role } from '../auth/auth.js';
import { StorageBackend } from '../utils/storageBackend.js';
import { PLANS } from '../web/plans.js';
import { logger } from '../utils/logger.js';

const PLAN_IDS = Object.keys(PLANS) as Plan[];
const ROLE_IDS: Role[] = ['user', 'admin'];
export const TRIGGERABLE_CRAWLERS = [
  'clinicaltrials', 'trials-recent', 'pubmed', 'preprints', 'grants', 'companies', 'funding', 'jobs', 'people',
  'events', 'legislation', 'care', 'news', 'markets', 'openalex'
] as const;

/**
 * Operator console API. Everything here requires the admin role, which is
 * granted to the ADMIN_EMAILS accounts on signup/login or by another admin.
 */
export function adminRouter(storage: StorageBackend): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!appDbAvailable()) {
      res.status(503).json({ error: 'Admin features require the Postgres backend (set DATABASE_URL)' });
      return;
    }
    next();
  });
  router.use(requireAdmin);

  // Business + data overview in one call for the console landing page
  router.get('/overview', async (_req: AuthedRequest, res: Response) => {
    try {
      const db = getAppDb();
      const [users, plans, signups, keys, usage, datasets, alerts, pendingCrawls, stats] = await Promise.all([
        db.query('SELECT count(*)::int AS n FROM users'),
        db.query('SELECT plan, count(*)::int AS n FROM users GROUP BY plan'),
        db.query("SELECT count(*)::int AS n FROM users WHERE created_at > now() - interval '7 days'"),
        db.query('SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL'),
        db.query("SELECT COALESCE(sum(requests), 0)::int AS n FROM api_usage WHERE day >= (now() AT TIME ZONE 'UTC')::date - 6"),
        db.query('SELECT count(*)::int AS n FROM datasets'),
        db.query('SELECT count(*)::int AS n FROM alert_subscriptions'),
        db.query('SELECT count(*)::int AS n FROM crawl_requests WHERE started_at IS NULL'),
        storage.getStats()
      ]);
      const planCounts: Record<string, number> = { free: 0, pro: 0, enterprise: 0 };
      for (const row of plans.rows) planCounts[row.plan] = row.n;
      const mrr = planCounts.pro * PLANS.pro.priceMonthly + planCounts.enterprise * PLANS.enterprise.priceMonthly;

      res.json({
        users: { total: users.rows[0].n, last7d: signups.rows[0].n, byPlan: planCounts, estimatedMrr: mrr },
        api: { activeKeys: keys.rows[0].n, requests7d: usage.rows[0].n },
        datasets: datasets.rows[0].n,
        alerts: alerts.rows[0].n,
        crawls: { pendingRequests: pendingCrawls.rows[0].n, counts: stats?.counts ?? {}, lastRuns: stats?.lastRuns ?? {} }
      });
    } catch (error) {
      logger.error(`[admin] overview failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Failed to load overview' });
    }
  });

  router.get('/users', async (req: AuthedRequest, res: Response) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, parseInt(req.query.limit as string) || 50);
    const params: unknown[] = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE lower(email) LIKE $1 OR lower(COALESCE(name, '')) LIKE $1 OR lower(COALESCE(organization, '')) LIKE $1`;
    }
    const total = await getAppDb().query(`SELECT count(*)::int AS n FROM users ${where}`, params);
    params.push(limit, (page - 1) * limit);
    const rows = await getAppDb().query(
      `SELECT id, email, name, organization, plan, role, plan_status, newsletter_opt_in, stripe_customer_id, created_at, last_login_at,
              (SELECT count(*)::int FROM api_keys k WHERE k.user_id = users.id AND k.revoked_at IS NULL) AS api_keys,
              (SELECT count(*)::int FROM datasets d WHERE d.user_id = users.id) AS datasets
       FROM users ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({
      data: rows.rows.map(r => ({
        ...toAuthedUser(r),
        stripeCustomerId: r.stripe_customer_id,
        lastLoginAt: r.last_login_at,
        apiKeys: r.api_keys,
        datasets: r.datasets
      })),
      total: total.rows[0].n,
      page,
      limit
    });
  });

  // Plan / role override — e.g. comp an Enterprise seat or add another admin
  router.patch('/users/:id', async (req: AuthedRequest, res: Response) => {
    const { plan, role } = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (plan !== undefined) {
      if (!PLAN_IDS.includes(plan)) return res.status(400).json({ error: `plan must be one of ${PLAN_IDS.join(', ')}` });
      params.push(plan);
      sets.push(`plan = $${params.length}`);
    }
    if (role !== undefined) {
      if (!ROLE_IDS.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLE_IDS.join(', ')}` });
      if (req.params.id === req.user!.id && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot remove your own admin role' });
      }
      params.push(role);
      sets.push(`role = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const result = await getAppDb().query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
       RETURNING id, email, plan, role, name, organization, newsletter_opt_in, plan_status, created_at`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    await audit(req.user!.id, 'admin.user_updated', req.params.id, { plan, role });
    res.json({ user: toAuthedUser(result.rows[0]) });
  });

  router.delete('/users/:id', async (req: AuthedRequest, res: Response) => {
    if (req.params.id === req.user!.id) return res.status(400).json({ error: 'Use account settings to delete your own account' });
    const result = await getAppDb().query('DELETE FROM users WHERE id = $1 RETURNING email', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    await audit(req.user!.id, 'admin.user_deleted', req.params.id, { email: result.rows[0].email });
    res.json({ ok: true });
  });

  // Queue a crawl; the scheduler polls crawl_requests and runs it in its lane
  router.post('/crawl', async (req: AuthedRequest, res: Response) => {
    const crawler = req.body?.crawler;
    if (!TRIGGERABLE_CRAWLERS.includes(crawler)) {
      return res.status(400).json({ error: `crawler must be one of ${TRIGGERABLE_CRAWLERS.join(', ')}` });
    }
    const pending = await getAppDb().query(
      'SELECT id FROM crawl_requests WHERE crawler = $1 AND started_at IS NULL LIMIT 1', [crawler]);
    if (pending.rows[0]) {
      return res.status(202).json({ ok: true, id: pending.rows[0].id, message: `${crawler} is already queued` });
    }
    const inserted = await getAppDb().query(
      'INSERT INTO crawl_requests (crawler, requested_by) VALUES ($1, $2) RETURNING id, requested_at',
      [crawler, req.user!.id]
    );
    await audit(req.user!.id, 'admin.crawl_requested', crawler);
    res.status(202).json({ ok: true, id: inserted.rows[0].id, requestedAt: inserted.rows[0].requested_at, message: `${crawler} queued — the scheduler picks it up within 30 seconds` });
  });

  router.get('/crawl-requests', async (_req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT r.id, r.crawler, r.requested_at, r.started_at, r.finished_at, r.error, u.email AS requested_by
       FROM crawl_requests r LEFT JOIN users u ON u.id = r.requested_by
       ORDER BY r.requested_at DESC LIMIT 50`
    );
    res.json({ data: result.rows, crawlers: TRIGGERABLE_CRAWLERS });
  });

  router.get('/audit', async (req: AuthedRequest, res: Response) => {
    const limit = Math.min(500, parseInt(req.query.limit as string) || 100);
    const result = await getAppDb().query(
      `SELECT a.id, a.action, a.target, a.meta, a.created_at, u.email AS actor
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ data: result.rows });
  });

  // Newsletter archive for the console
  router.get('/newsletters', async (_req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      'SELECT id, subject, event_count, recipients, generated_at FROM newsletter_issues ORDER BY generated_at DESC LIMIT 50');
    res.json({ data: result.rows });
  });

  return router;
}

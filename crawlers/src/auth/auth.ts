import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { signSession, verifySession } from './tokens.js';
import { Mailer } from '../notify/mailer.js';
import { rateLimit, clientIp } from '../web/rateLimit.js';
import { planFor } from '../web/plans.js';
import { logger } from '../utils/logger.js';

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export type Plan = 'free' | 'pro' | 'enterprise';
export type Role = 'user' | 'admin';

export interface AuthedUser {
  id: string;
  email: string;
  plan: Plan;
  role: Role;
  name?: string | null;
  organization?: string | null;
  newsletterOptIn?: boolean;
  planStatus?: string;
  createdAt?: string;
}

export interface ApiKeyContext {
  id: string;
  label: string | null;
  scopes: string[];
}

// Express request augmented by attachUser middleware
export interface AuthedRequest extends Request {
  user?: AuthedUser;
  /** Set when the request was authenticated with an API key (not a session) */
  apiKey?: ApiKeyContext;
}

const SESSION_COOKIE = 'neuly_session';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// ---------- password hashing (scrypt, no native deps) ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------- API keys ----------

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Operator emails that are promoted to admin on signup/login (comma separated) */
export function isBootstrapAdmin(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

// ---------- middleware ----------

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return cookies;
}

const USER_COLUMNS = 'id, email, plan, role, name, organization, newsletter_opt_in, plan_status, created_at';

/**
 * Attach req.user from a session cookie or an API key
 * (Authorization: Bearer nk_... or ?api_key=nk_...). Never rejects —
 * downstream handlers decide what anonymous users may do.
 */
export function attachUser() {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      // API key auth (header preferred; query param for quick curl/browser use)
      const authHeader = req.headers.authorization;
      const headerKey = authHeader?.startsWith('Bearer nk_') ? authHeader.slice('Bearer '.length) : undefined;
      const queryKey = typeof req.query.api_key === 'string' && req.query.api_key.startsWith('nk_') ? req.query.api_key : undefined;
      const rawKey = headerKey ?? queryKey;
      if (rawKey && appDbAvailable()) {
        const keyHash = hashApiKey(rawKey);
        const result = await getAppDb().query(
          `SELECT u.id, u.email, u.plan, u.role, u.name, u.organization, u.newsletter_opt_in, u.plan_status, u.created_at,
                  k.id AS key_id, k.label AS key_label, k.scopes AS key_scopes
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
           WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
          [keyHash]
        );
        const row = result.rows[0];
        if (row) {
          req.user = toAuthedUser(row);
          req.apiKey = { id: row.key_id, label: row.key_label, scopes: row.key_scopes ?? ['read'] };
          getAppDb().query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id])
            .catch(() => undefined);
          return next();
        }
      }

      // Session cookie auth
      const session = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (session && appDbAvailable()) {
        // Re-read plan/role so upgrades and role changes apply without re-login
        const result = await getAppDb().query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [session.userId]);
        if (result.rows[0]) req.user = toAuthedUser(result.rows[0]);
      }
    } catch (error) {
      logger.warn(`[auth] attachUser failed: ${error instanceof Error ? error.message : error}`);
    }
    next();
  };
}

/** Require a signed-in user */
export function requireUser(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }
  next();
}

/** Require one of the given plans */
export function requirePlan(...plans: Plan[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in required' });
      return;
    }
    if (!plans.includes(req.user.plan)) {
      res.status(403).json({
        error: `This feature requires the ${plans.map(p => planFor(p).name).join(' or ')} plan`,
        plan: req.user.plan,
        upgrade: '/pricing'
      });
      return;
    }
    next();
  };
}

/** Require the admin role */
export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// ---------- helpers ----------

interface UserRow {
  id: string;
  email: string;
  plan: Plan;
  role?: Role;
  name?: string | null;
  organization?: string | null;
  newsletter_opt_in?: boolean;
  plan_status?: string;
  created_at?: Date;
}

export function toAuthedUser(row: UserRow): AuthedUser {
  return {
    id: row.id,
    email: row.email,
    plan: row.plan,
    role: row.role ?? 'user',
    name: row.name ?? null,
    organization: row.organization ?? null,
    newsletterOptIn: row.newsletter_opt_in ?? true,
    planStatus: row.plan_status ?? 'active',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : undefined
  };
}

// In production the cookie is SameSite=None so a statically hosted frontend
// on another origin (e.g. neuly.com -> neuly-web.onrender.com) can hold a
// session; None requires Secure, which requires HTTPS — fine on Render.
function cookieAttributes(): string {
  return process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
}

function setSessionCookie(res: Response, user: AuthedUser): void {
  const token = signSession({ userId: user.id, email: user.email, plan: user.plan });
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; ${cookieAttributes()}`);
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; ${cookieAttributes()}`);
}

function validEmail(email: unknown): email is string {
  return typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254;
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

export async function audit(actorId: string | null, action: string, target?: string, meta?: Record<string, unknown>): Promise<void> {
  if (!appDbAvailable()) return;
  await getAppDb().query(
    'INSERT INTO audit_log (actor_id, action, target, meta) VALUES ($1, $2, $3, $4)',
    [actorId, action, target ?? null, meta ? JSON.stringify(meta) : null]
  ).catch(error => logger.warn(`[audit] write failed: ${error instanceof Error ? error.message : error}`));
}

function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

const requireDb = (_req: Request, res: Response, next: NextFunction) => {
  if (!appDbAvailable()) {
    res.status(503).json({ error: 'Account features require the Postgres backend (set DATABASE_URL)' });
    return;
  }
  next();
};

// ---------- routes ----------

export function authRouter(mailer = new Mailer()): Router {
  const router = Router();
  router.use(requireDb);

  // Credential endpoints are brute-force targets: 20 attempts / 15 min per IP
  const credentialLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyFor: req => `auth:${clientIp(req)}`,
    message: 'Too many attempts — try again in a few minutes'
  });

  router.post('/signup', credentialLimit, async (req: Request, res: Response) => {
    const { email, password, name, organization } = req.body ?? {};
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const id = `usr_${randomUUID()}`;
      const passwordHash = await hashPassword(password);
      const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null;
      const cleanOrg = typeof organization === 'string' && organization.trim() ? organization.trim().slice(0, 200) : null;
      const role: Role = isBootstrapAdmin(email) ? 'admin' : 'user';
      const inserted = await getAppDb().query(
        `INSERT INTO users (id, email, password_hash, name, organization, role, last_login_at)
         VALUES ($1, lower($2), $3, $4, $5, $6, now()) RETURNING ${USER_COLUMNS}`,
        [id, email, passwordHash, cleanName, cleanOrg, role]
      );
      const user = toAuthedUser(inserted.rows[0]);
      setSessionCookie(res, user);
      await audit(user.id, 'user.signup', user.id, { role });
      res.status(201).json({ user });
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      logger.error(`[auth] signup failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Signup failed' });
    }
  });

  router.post('/login', credentialLimit, async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await getAppDb().query(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = lower($1)`,
      [email]
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Promote configured operator accounts that signed up before ADMIN_EMAILS was set
    if (row.role !== 'admin' && isBootstrapAdmin(row.email)) {
      await getAppDb().query("UPDATE users SET role = 'admin' WHERE id = $1", [row.id]);
      row.role = 'admin';
    }
    await getAppDb().query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);

    const user = toAuthedUser(row);
    setSessionCookie(res, user);
    res.json({ user });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req: AuthedRequest, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ user: req.user, plan: planFor(req.user.plan) });
  });

  // Profile update: name, organization, newsletter preference
  router.patch('/me', requireUser, async (req: AuthedRequest, res: Response) => {
    const { name, organization, newsletterOptIn } = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (name !== undefined) {
      params.push(typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null);
      sets.push(`name = $${params.length}`);
    }
    if (organization !== undefined) {
      params.push(typeof organization === 'string' && organization.trim() ? organization.trim().slice(0, 200) : null);
      sets.push(`organization = $${params.length}`);
    }
    if (typeof newsletterOptIn === 'boolean') {
      params.push(newsletterOptIn);
      sets.push(`newsletter_opt_in = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.user!.id);
    const result = await getAppDb().query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING ${USER_COLUMNS}`,
      params
    );
    res.json({ user: toAuthedUser(result.rows[0]) });
  });

  // Change password (requires the current one)
  router.post('/password', requireUser, credentialLimit, async (req: AuthedRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || !validPassword(newPassword)) {
      return res.status(400).json({ error: 'Current password and a new password of at least 8 characters are required' });
    }
    const result = await getAppDb().query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!result.rows[0] || !(await verifyPassword(currentPassword, result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await getAppDb().query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [await hashPassword(newPassword), req.user!.id]);
    await audit(req.user!.id, 'user.password_changed', req.user!.id);
    res.json({ ok: true });
  });

  // Forgot password: always 200 so the endpoint never confirms whether an
  // email is registered. The link lands on the SPA's /reset-password route.
  router.post('/forgot', credentialLimit, async (req: Request, res: Response) => {
    const { email } = req.body ?? {};
    if (!validEmail(email)) return res.status(400).json({ error: 'A valid email is required' });

    try {
      const result = await getAppDb().query('SELECT id, name FROM users WHERE email = lower($1)', [email]);
      const row = result.rows[0];
      if (row) {
        const token = randomBytes(32).toString('base64url');
        await getAppDb().query(
          'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
          [hashApiKey(token), row.id, new Date(Date.now() + RESET_TOKEN_TTL_MS)]
        );
        const link = `${siteUrl()}/reset-password?token=${token}`;
        await mailer.send({
          to: email.toLowerCase(),
          subject: 'Reset your Neuly password',
          html: [
            `<p>Hi${row.name ? ` ${escapeHtml(row.name)}` : ''},</p>`,
            `<p>Someone (hopefully you) asked to reset the password for your Neuly account.</p>`,
            `<p><a href="${link}">Reset your password</a> — this link works for one hour and can be used once.</p>`,
            `<p>If you didn't request this, you can ignore this email; your password is unchanged.</p>`
          ].join('\n'),
          text: `Reset your Neuly password: ${link} (valid for one hour)`
        });
      }
    } catch (error) {
      logger.error(`[auth] forgot-password failed: ${error instanceof Error ? error.message : error}`);
    }
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  });

  router.post('/reset', credentialLimit, async (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || !token || !validPassword(password)) {
      return res.status(400).json({ error: 'A reset token and a new password of at least 8 characters are required' });
    }
    const tokenHash = hashApiKey(token);
    const result = await getAppDb().query(
      `SELECT t.user_id, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired' });

    await getAppDb().query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
      [await hashPassword(password), row.user_id]);
    await getAppDb().query('UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1', [tokenHash]);
    await audit(row.user_id, 'user.password_reset', row.user_id);

    const fresh = await getAppDb().query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [row.user_id]);
    const user = toAuthedUser(fresh.rows[0]);
    setSessionCookie(res, user);
    res.json({ ok: true, user });
  });

  // Delete account (password confirmation). Cascades remove keys, alerts,
  // saves and datasets.
  router.delete('/me', requireUser, async (req: AuthedRequest, res: Response) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string') return res.status(400).json({ error: 'Password confirmation is required' });
    const result = await getAppDb().query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!result.rows[0] || !(await verifyPassword(password, result.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }
    await audit(req.user!.id, 'user.deleted', req.user!.id, { email: req.user!.email });
    await getAppDb().query('DELETE FROM users WHERE id = $1', [req.user!.id]);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- API keys ----------

const MAX_KEYS_PER_USER = 10;

export function apiKeysRouter(): Router {
  const router = Router();
  router.use(requireDb);

  // API access is part of the paid product: Pro gets a metered quota,
  // Enterprise a large one. The key itself is shown exactly once.
  router.post('/', requirePlan('pro', 'enterprise'), async (req: AuthedRequest, res: Response) => {
    const count = await getAppDb().query(
      'SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [req.user!.id]);
    if (count.rows[0].n >= MAX_KEYS_PER_USER) {
      return res.status(400).json({ error: `You can have up to ${MAX_KEYS_PER_USER} active API keys — revoke one first` });
    }

    const key = `nk_${randomBytes(24).toString('hex')}`;
    const id = `key_${randomUUID()}`;
    const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim().slice(0, 100) : null;

    await getAppDb().query(
      'INSERT INTO api_keys (id, user_id, key_hash, label) VALUES ($1, $2, $3, $4)',
      [id, req.user!.id, hashApiKey(key), label]
    );
    await audit(req.user!.id, 'api_key.created', id, { label });

    const spec = planFor(req.user!.plan);
    res.status(201).json({ id, key, label, prefix: key.slice(0, 7), quota: { daily: spec.apiDailyQuota, perMinute: spec.apiPerMinute } });
  });

  router.get('/', requireUser, async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT k.id, k.label, k.scopes, k.created_at, k.last_used_at, k.revoked_at,
              COALESCE((SELECT requests FROM api_usage u WHERE u.api_key_id = k.id AND u.day = (now() AT TIME ZONE 'UTC')::date), 0) AS requests_today,
              COALESCE((SELECT sum(requests) FROM api_usage u WHERE u.api_key_id = k.id AND u.day >= (now() AT TIME ZONE 'UTC')::date - 29), 0)::int AS requests_30d
       FROM api_keys k WHERE k.user_id = $1 ORDER BY k.created_at DESC`,
      [req.user!.id]
    );
    const spec = planFor(req.user!.plan);
    res.json({
      data: result.rows.map(row => ({
        id: row.id,
        label: row.label,
        scopes: row.scopes,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        requestsToday: row.requests_today,
        requests30d: row.requests_30d
      })),
      quota: { daily: spec.apiDailyQuota, perMinute: spec.apiPerMinute, apiAccess: spec.apiDailyQuota > 0 }
    });
  });

  // Usage across all keys: last 30 UTC days, plus today's remaining quota
  router.get('/usage', requireUser, async (req: AuthedRequest, res: Response) => {
    const [daily, today] = await Promise.all([
      getAppDb().query(
        `SELECT u.day, sum(u.requests)::int AS requests
         FROM api_usage u JOIN api_keys k ON k.id = u.api_key_id
         WHERE k.user_id = $1 AND u.day >= (now() AT TIME ZONE 'UTC')::date - 29
         GROUP BY u.day ORDER BY u.day`,
        [req.user!.id]
      ),
      dailyUsageForUser(req.user!.id)
    ]);
    const spec = planFor(req.user!.plan);
    res.json({
      plan: req.user!.plan,
      quota: { daily: spec.apiDailyQuota, perMinute: spec.apiPerMinute },
      today: { requests: today, remaining: Math.max(0, spec.apiDailyQuota - today) },
      daily: daily.rows.map(r => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day), requests: r.requests }))
    });
  });

  router.delete('/:id', requireUser, async (req: AuthedRequest, res: Response) => {
    await getAppDb().query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [req.params.id, req.user!.id]
    );
    await audit(req.user!.id, 'api_key.revoked', req.params.id);
    res.json({ ok: true });
  });

  return router;
}

/** Requests today (UTC) across every key the user owns */
export async function dailyUsageForUser(userId: string): Promise<number> {
  const result = await getAppDb().query(
    `SELECT COALESCE(sum(u.requests), 0)::int AS n
     FROM api_usage u JOIN api_keys k ON k.id = u.api_key_id
     WHERE k.user_id = $1 AND u.day = (now() AT TIME ZONE 'UTC')::date`,
    [userId]
  );
  return result.rows[0]?.n ?? 0;
}

/** Record one API request against a key; returns the key's count for today */
export async function recordApiUsage(apiKeyId: string): Promise<number> {
  const result = await getAppDb().query(
    `INSERT INTO api_usage (api_key_id, day, requests) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (api_key_id, day) DO UPDATE SET requests = api_usage.requests + 1
     RETURNING requests`,
    [apiKeyId]
  );
  return result.rows[0]?.requests ?? 1;
}

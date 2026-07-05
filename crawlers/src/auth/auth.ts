import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { signSession, verifySession } from './tokens.js';
import { logger } from '../utils/logger.js';

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export type Plan = 'free' | 'pro' | 'enterprise';

export interface AuthedUser {
  id: string;
  email: string;
  plan: Plan;
}

// Express request augmented by attachUser middleware
export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

const SESSION_COOKIE = 'neuly_session';

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

/**
 * Attach req.user from a session cookie or an API key
 * (Authorization: Bearer nk_...). Never rejects — downstream
 * handlers decide what anonymous users may do.
 */
export function attachUser() {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      // API key auth
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer nk_') && appDbAvailable()) {
        const keyHash = hashApiKey(authHeader.slice('Bearer '.length));
        const result = await getAppDb().query(
          `SELECT u.id, u.email, u.plan FROM api_keys k
           JOIN users u ON u.id = k.user_id
           WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
          [keyHash]
        );
        if (result.rows[0]) {
          req.user = result.rows[0];
          getAppDb().query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1', [keyHash])
            .catch(() => undefined);
          return next();
        }
      }

      // Session cookie auth
      const session = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (session && appDbAvailable()) {
        // Re-read plan so upgrades/downgrades apply without re-login
        const result = await getAppDb().query('SELECT id, email, plan FROM users WHERE id = $1', [session.userId]);
        if (result.rows[0]) req.user = result.rows[0];
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
      res.status(403).json({ error: `This feature requires the ${plans.join(' or ')} plan`, plan: req.user.plan });
      return;
    }
    next();
  };
}

// ---------- routes ----------

function setSessionCookie(res: Response, user: AuthedUser): void {
  const token = signSession({ userId: user.id, email: user.email, plan: user.plan });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${secure}`);
}

export function authRouter(): Router {
  const router = Router();

  // Account features need Postgres
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!appDbAvailable()) {
      res.status(503).json({ error: 'Account features require the Postgres backend (set DATABASE_URL)' });
      return;
    }
    next();
  });

  router.post('/signup', async (req: Request, res: Response) => {
    const { email, password, name } = req.body ?? {};
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    try {
      const id = `usr_${randomUUID()}`;
      const passwordHash = await hashPassword(password);
      await getAppDb().query(
        'INSERT INTO users (id, email, password_hash, name) VALUES ($1, lower($2), $3, $4)',
        [id, email, passwordHash, typeof name === 'string' ? name.slice(0, 200) : null]
      );
      const user: AuthedUser = { id, email: email.toLowerCase(), plan: 'free' };
      setSessionCookie(res, user);
      res.status(201).json({ user });
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      logger.error(`[auth] signup failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Signup failed' });
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await getAppDb().query(
      'SELECT id, email, plan, password_hash FROM users WHERE email = lower($1)',
      [email]
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user: AuthedUser = { id: row.id, email: row.email, plan: row.plan };
    setSessionCookie(res, user);
    res.json({ user });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/me', (req: AuthedRequest, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    res.json({ user: req.user });
  });

  return router;
}

export function apiKeysRouter(): Router {
  const router = Router();

  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!appDbAvailable()) {
      res.status(503).json({ error: 'Account features require the Postgres backend (set DATABASE_URL)' });
      return;
    }
    next();
  });

  // API access is the enterprise product
  router.post('/', requirePlan('enterprise'), async (req: AuthedRequest, res: Response) => {
    const key = `nk_${randomBytes(24).toString('hex')}`;
    const id = `key_${randomUUID()}`;
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 100) : null;

    await getAppDb().query(
      'INSERT INTO api_keys (id, user_id, key_hash, label) VALUES ($1, $2, $3, $4)',
      [id, req.user!.id, hashApiKey(key), label]
    );

    // The plaintext key is shown exactly once
    res.status(201).json({ id, key, label });
  });

  router.get('/', requireUser, async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT id, label, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id]
    );
    res.json({ data: result.rows });
  });

  router.delete('/:id', requireUser, async (req: AuthedRequest, res: Response) => {
    await getAppDb().query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.id]
    );
    res.json({ ok: true });
  });

  return router;
}

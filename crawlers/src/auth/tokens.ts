import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.js';

export interface SessionPayload {
  userId: string;
  email: string;
  plan: string;
  /** unix seconds */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value) return value;
  logger.warn('[auth] SESSION_SECRET not set — using an insecure development default. Set it in production.');
  return 'neuly-dev-secret-do-not-use-in-production';
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

/**
 * Sign a compact session token: base64url(payload).hmac
 */
export function signSession(payload: Omit<SessionPayload, 'exp'>, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const full: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64url(JSON.stringify(full));
  return `${body}.${hmac(body)}`;
}

/**
 * Verify a session token; returns the payload or null if invalid/expired.
 */
export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = hmac(body);

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (!payload.userId || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

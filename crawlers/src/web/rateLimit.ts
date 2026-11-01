import type { Request, Response, NextFunction } from 'express';

/**
 * In-process fixed-window rate limiter. Good for a single web instance (the
 * launch topology); swap the store for Redis when the web tier scales out.
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** unix seconds when the current window resets */
  resetAt: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly windowMs: number) {}

  hit(key: string, limit: number, now = Date.now()): RateLimitResult {
    this.sweep(now);
    const bucket = this.buckets.get(key);
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;

    if (!bucket || bucket.windowStart !== windowStart) {
      this.buckets.set(key, { count: 1, windowStart });
      return { allowed: limit >= 1, limit, remaining: Math.max(0, limit - 1), resetAt: Math.ceil((windowStart + this.windowMs) / 1000) };
    }

    bucket.count++;
    return {
      allowed: bucket.count <= limit,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: Math.ceil((windowStart + this.windowMs) / 1000)
    };
  }

  /** Drop stale buckets so memory stays bounded under churny anonymous traffic */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > this.windowMs * 2) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(result.resetAt));
}

export function clientIp(req: Request): string {
  // trust proxy is enabled on the app, so req.ip is the client address on Render
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Express middleware factory: limits requests per key within the window.
 * `keyFor` returns null to skip limiting for a request.
 */
export function rateLimit(options: {
  windowMs: number;
  limit: number;
  keyFor?: (req: Request) => string | null;
  message?: string;
}) {
  const limiter = new RateLimiter(options.windowMs);
  const keyFor = options.keyFor ?? clientIp;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFor(req);
    if (key === null) return next();
    const result = limiter.hit(key, options.limit);
    setRateLimitHeaders(res, result);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, result.resetAt - Math.floor(Date.now() / 1000))));
      res.status(429).json({ error: options.message ?? 'Too many requests — slow down and retry shortly' });
      return;
    }
    next();
  };
}

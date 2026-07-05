import pg from 'pg';
import { logger } from '../utils/logger.js';

/**
 * Shared pool for application tables (users, api_keys, alerts, newsletter).
 * Product features (auth, alerts, billing) require Postgres; when
 * DATABASE_URL is unset they are disabled and the data API still works
 * off the JSON backend.
 */
let pool: pg.Pool | null = null;

export function appDbAvailable(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getAppDb(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — account features require Postgres');
  }
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    pool.on('error', err => logger.error(`[appDb] Pool error: ${err.message}`));
  }
  return pool;
}

export async function closeAppDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

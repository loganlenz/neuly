import { CrawledData } from '../models/types.js';
import type { Plan } from '../auth/auth.js';

/** Free tier sees the last 7 days of change history; paid sees all */
export const FREE_CHANGES_WINDOW_DAYS = 7;
/** Free tier sees 90 days of the readout calendar; paid sees the full horizon */
export const FREE_READOUT_HORIZON_DAYS = 90;

export function isPaid(plan: Plan | undefined): boolean {
  return plan === 'pro' || plan === 'enterprise';
}

/**
 * Clamp the `since` filter on the change feed for free/anonymous users.
 * Returns the effective since timestamp (ISO).
 */
export function clampChangesSince(plan: Plan | undefined, requestedSince: string | undefined, now = new Date()): string | undefined {
  if (isPaid(plan)) return requestedSince;

  const floor = new Date(now.getTime() - FREE_CHANGES_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (!requestedSince || requestedSince < floor) return floor;
  return requestedSince;
}

/** Clamp the readout horizon for free/anonymous users */
export function clampReadoutHorizon(plan: Plan | undefined, requestedDays: number | undefined): number | undefined {
  if (isPaid(plan)) return requestedDays;
  const requested = requestedDays ?? FREE_READOUT_HORIZON_DAYS;
  return Math.min(requested, FREE_READOUT_HORIZON_DAYS);
}

/**
 * Render rows as CSV. Columns are the union of scalar fields across rows;
 * array fields are joined, object fields JSON-encoded.
 */
export function toCsv(rows: CrawledData[]): string {
  if (rows.length === 0) return '';

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const escapeCell = (value: unknown): string => {
    if (value === undefined || value === null) return '';
    let text: string;
    if (Array.isArray(value)) {
      text = value.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('; ');
    } else if (typeof value === 'object') {
      text = JSON.stringify(value);
    } else {
      text = String(value);
    }
    if (/[",\n]/.test(text)) {
      text = `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(col => escapeCell((row as Record<string, unknown>)[col])).join(','));
  }
  return lines.join('\n');
}

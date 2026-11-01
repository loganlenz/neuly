import type { Plan } from '../auth/auth.js';

/**
 * Single source of truth for what each plan includes. The API, the gating
 * middleware, the billing router and the frontend pricing page all read
 * from here so a limit is never defined twice.
 */
export interface PlanSpec {
  id: Plan;
  name: string;
  /** Monthly list price in USD (display only — Stripe prices are the contract) */
  priceMonthly: number;
  tagline: string;
  /** API requests per UTC day across all of the user's keys; 0 = no API access */
  apiDailyQuota: number;
  /** Burst limit per minute for API-key traffic */
  apiPerMinute: number;
  /** Max datasets a user may create; null = unlimited */
  maxDatasets: number | null;
  /** Max hand-picked items per dataset; null = unlimited */
  maxDatasetItems: number | null;
  /** Max saved queries per dataset; null = unlimited */
  maxDatasetQueries: number | null;
  /** Max alert subscriptions; null = unlimited */
  maxAlerts: number | null;
  /** Days of change history visible; null = full history */
  changesWindowDays: number | null;
  /** Readout calendar horizon in days; null = unlimited */
  readoutHorizonDays: number | null;
  /** CSV/JSON export of datasets and tables */
  exports: boolean;
  /** Full-table bulk download (NDJSON/CSV) and the data-licensing endpoints */
  bulkDownloads: boolean;
  /** Public share links for datasets */
  sharing: boolean;
  features: string[];
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const PLANS: Record<Plan, PlanSpec> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    tagline: 'Explore the live data layer',
    apiDailyQuota: 0,
    apiPerMinute: 0,
    maxDatasets: 1,
    maxDatasetItems: 50,
    maxDatasetQueries: 2,
    maxAlerts: 1,
    changesWindowDays: 7,
    readoutHorizonDays: 90,
    exports: false,
    bulkDownloads: false,
    sharing: false,
    features: [
      'Every dataset, refreshed continuously',
      'Industry Live feed, news, filings & quotes',
      '7 days of change history',
      '90-day readout calendar',
      '1 dataset (50 items) and 1 alert',
      'Weekly newsletter'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: envNumber('PLAN_PRICE_PRO', 79),
    tagline: 'For analysts, investors and operators',
    apiDailyQuota: envNumber('API_QUOTA_PRO', 2000),
    apiPerMinute: 120,
    maxDatasets: null,
    maxDatasetItems: null,
    maxDatasetQueries: null,
    maxAlerts: null,
    changesWindowDays: null,
    readoutHorizonDays: null,
    exports: true,
    bulkDownloads: false,
    sharing: true,
    features: [
      'Everything in Free',
      'Full change history and readout horizon',
      'Unlimited datasets, saved queries and alerts',
      'CSV / JSON export of any dataset or table',
      'Public share links for your datasets',
      'REST API access — 2,000 requests/day'
    ]
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthly: envNumber('PLAN_PRICE_ENTERPRISE', 499),
    tagline: 'The whole data layer, programmatically',
    apiDailyQuota: envNumber('API_QUOTA_ENTERPRISE', 100000),
    apiPerMinute: 600,
    maxDatasets: null,
    maxDatasetItems: null,
    maxDatasetQueries: null,
    maxAlerts: null,
    changesWindowDays: null,
    readoutHorizonDays: null,
    exports: true,
    bulkDownloads: true,
    sharing: true,
    features: [
      'Everything in Pro',
      'REST API — 100,000 requests/day, 600/min burst',
      'Bulk downloads of every table (NDJSON / CSV)',
      'Change-feed cursor for warehouse sync',
      'Multiple API keys with labels and usage metering',
      'Priority support and data requests'
    ]
  }
};

export function planFor(plan: Plan | undefined): PlanSpec {
  return PLANS[plan ?? 'free'] ?? PLANS.free;
}

/** Public shape for the pricing page: never leaks env-driven internals */
export function publicPlans(): Array<Omit<PlanSpec, 'apiPerMinute'> & { stripeConfigured: boolean }> {
  return (Object.values(PLANS) as PlanSpec[]).map(({ apiPerMinute: _burst, ...spec }) => ({
    ...spec,
    stripeConfigured: spec.id === 'free'
      ? true
      : Boolean(process.env.STRIPE_SECRET_KEY && process.env[`STRIPE_PRICE_${spec.id.toUpperCase()}`])
  }));
}

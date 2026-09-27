import type { CrawlerName } from './orchestrator.js';
import type { DataType } from './utils/storage.js';

export type Lane = 'live' | 'bulk';

export interface ScheduleEntry {
  crawler: Exclude<CrawlerName, 'all'>;
  /** Live-lane feeds run on their own queue so a long bulk crawl never delays them */
  lane: Lane;
  /** cron expression; override with SCHEDULE_<CRAWLER> env vars */
  cron: string;
  description: string;
  /** Dataset the crawler writes (shown on the freshness panel) */
  dataType: DataType;
}

/**
 * Per-source crawl cadence, tuned so every dataset is as close to real time
 * as its upstream source allows without abusing it:
 *   - live lane: news + market quotes, every few minutes
 *   - bulk lane: registries, filings and literature, hourly to daily
 * Every expression can be overridden with SCHEDULE_<CRAWLER> env vars.
 */
export const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  // Live lane
  { crawler: 'news', lane: 'live', cron: '*/15 * * * *', dataType: 'news', description: 'Google News + SEC filings — every 15 min' },
  { crawler: 'markets', lane: 'live', cron: '*/5 13-21 * * 1-5', dataType: 'market_quotes', description: 'Stock quotes — every 5 min, US market hours (UTC)' },
  // Bulk lane
  { crawler: 'clinicaltrials', lane: 'bulk', cron: '0 */2 * * *', dataType: 'clinical_trials', description: 'ClinicalTrials.gov — every 2 hours' },
  { crawler: 'legislation', lane: 'bulk', cron: '20 * * * *', dataType: 'legislation', description: 'Bills & Federal Register — hourly' },
  { crawler: 'funding', lane: 'bulk', cron: '40 * * * 1-5', dataType: 'funding_events', description: 'SEC Form D filings — hourly on weekdays' },
  { crawler: 'companies', lane: 'bulk', cron: '10 */6 * * *', dataType: 'companies', description: 'SEC EDGAR companies — every 6 hours' },
  { crawler: 'jobs', lane: 'bulk', cron: '30 */3 * * *', dataType: 'jobs', description: 'ATS job boards — every 3 hours' },
  { crawler: 'preprints', lane: 'bulk', cron: '50 */4 * * *', dataType: 'research_papers', description: 'bioRxiv/medRxiv preprints — every 4 hours' },
  { crawler: 'pubmed', lane: 'bulk', cron: '0 5,11,17,23 * * *', dataType: 'research_papers', description: 'PubMed + Europe PMC — every 6 hours' },
  { crawler: 'events', lane: 'bulk', cron: '0 8,20 * * *', dataType: 'events', description: 'Events — twice daily' },
  { crawler: 'grants', lane: 'bulk', cron: '0 4 * * *', dataType: 'grants', description: 'NIH RePORTER grants — daily 04:00 UTC' },
  { crawler: 'people', lane: 'bulk', cron: '30 5 * * *', dataType: 'people', description: 'People — daily 05:30 UTC' },
  { crawler: 'care', lane: 'bulk', cron: '0 11 * * *', dataType: 'care_providers', description: 'Licensed care providers — daily 11:00 UTC' },
  { crawler: 'openalex', lane: 'bulk', cron: '0 3 * * *', dataType: 'research_papers', description: 'OpenAlex citation refresh — daily 03:00 UTC' }
];

#!/usr/bin/env node
import 'dotenv/config';
import cron from 'node-cron';
import { CrawlerOrchestrator, CrawlerName } from './orchestrator.js';
import { logger } from './utils/logger.js';

interface ScheduleEntry {
  crawler: Exclude<CrawlerName, 'all'>;
  /** cron expression; override with SCHEDULE_<CRAWLER> env vars */
  cron: string;
  description: string;
}

/**
 * Per-source crawl cadence. Matched to how fast each source actually
 * changes — filings and jobs move daily, the literature weekly.
 */
const DEFAULT_SCHEDULE: ScheduleEntry[] = [
  { crawler: 'clinicaltrials', cron: '0 6 * * *', description: 'ClinicalTrials.gov — daily 06:00 UTC' },
  { crawler: 'companies', cron: '0 7 * * 1-5', description: 'SEC EDGAR — weekdays 07:00 UTC' },
  { crawler: 'jobs', cron: '30 7 * * *', description: 'ATS job boards — daily 07:30 UTC' },
  { crawler: 'events', cron: '0 8 * * *', description: 'Events — daily 08:00 UTC' },
  { crawler: 'pubmed', cron: '0 5 * * 1', description: 'PubMed — Mondays 05:00 UTC' },
  { crawler: 'people', cron: '0 5 * * 2', description: 'People — Tuesdays 05:00 UTC' }
];

function scheduleFor(entry: ScheduleEntry): string {
  const override = process.env[`SCHEDULE_${entry.crawler.toUpperCase()}`];
  if (override) {
    if (!cron.validate(override)) {
      logger.warn(`[Scheduler] Invalid cron override for ${entry.crawler}: "${override}", using default`);
      return entry.cron;
    }
    return override;
  }
  return entry.cron;
}

async function main(): Promise<void> {
  const orchestrator = await CrawlerOrchestrator.create();
  logger.info('='.repeat(60));
  logger.info('Neuly Crawl Scheduler');
  logger.info(`Storage: ${orchestrator.storageLabel}`);
  logger.info('='.repeat(60));

  // Serialize runs: crawlers share rate limits and the storage backend,
  // so overlapping schedules queue instead of running concurrently.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (crawler: Exclude<CrawlerName, 'all'>) => {
    queue = queue
      .then(() => orchestrator.run(crawler))
      .catch(error => {
        logger.error(`[Scheduler] ${crawler} run failed: ${error instanceof Error ? error.message : error}`);
      });
  };

  for (const entry of DEFAULT_SCHEDULE) {
    const expression = scheduleFor(entry);
    cron.schedule(expression, () => {
      logger.info(`[Scheduler] Triggering ${entry.crawler} (${expression})`);
      enqueue(entry.crawler);
    });
    logger.info(`  ${entry.crawler.padEnd(16)} ${expression.padEnd(14)} ${entry.description}`);
  }

  if (process.env.RUN_ON_START === 'true') {
    logger.info('[Scheduler] RUN_ON_START=true — running all crawlers now');
    enqueue('clinicaltrials');
    enqueue('companies');
    enqueue('jobs');
    enqueue('events');
    enqueue('pubmed');
    enqueue('people');
  }

  logger.info('[Scheduler] Running. Ctrl+C to stop.');

  const shutdown = async () => {
    logger.info('[Scheduler] Shutting down...');
    await queue.catch(() => undefined);
    await orchestrator.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  logger.error(`Scheduler failed to start: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

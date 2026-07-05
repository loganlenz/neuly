#!/usr/bin/env node
import 'dotenv/config';
import cron from 'node-cron';
import { CrawlerOrchestrator, CrawlerName } from './orchestrator.js';
import { runAlertDispatch } from './alerts/alerts.js';
import { runNewsletter } from './newsletter/digest.js';
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
  { crawler: 'people', cron: '0 5 * * 2', description: 'People — Tuesdays 05:00 UTC' },
  { crawler: 'legislation', cron: '0 9 * * *', description: 'Bills & Federal Register — daily 09:00 UTC' },
  { crawler: 'funding', cron: '30 9 * * 1-5', description: 'SEC Form D filings — weekdays 09:30 UTC' },
  { crawler: 'preprints', cron: '0 10 * * *', description: 'bioRxiv/medRxiv preprints — daily 10:00 UTC' },
  { crawler: 'grants', cron: '0 4 * * 3', description: 'NIH RePORTER grants — Wednesdays 04:00 UTC' },
  { crawler: 'openalex', cron: '0 3 * * 6', description: 'OpenAlex citation refresh — Saturdays 03:00 UTC' }
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

  // Product jobs: alert emails daily after the morning crawls; the
  // newsletter digest weekly on Mondays.
  const alertsCron = process.env.SCHEDULE_ALERTS ?? '0 12 * * *';
  cron.schedule(alertsCron, () => {
    queue = queue
      .then(() => runAlertDispatch(orchestrator.storageBackend))
      .then(({ sent }) => { logger.info(`[Scheduler] Alert dispatch done (${sent} emails)`); })
      .catch(error => { logger.error(`[Scheduler] Alert dispatch failed: ${error instanceof Error ? error.message : error}`); });
  });
  logger.info(`  ${'alerts'.padEnd(16)} ${alertsCron.padEnd(14)} Alert emails — daily 12:00 UTC`);

  const newsletterCron = process.env.SCHEDULE_NEWSLETTER ?? '0 13 * * 1';
  cron.schedule(newsletterCron, () => {
    queue = queue
      .then(() => runNewsletter(orchestrator.storageBackend))
      .then(({ recipients, eventCount }) => { logger.info(`[Scheduler] Newsletter done (${eventCount} events, ${recipients} recipients)`); })
      .catch(error => { logger.error(`[Scheduler] Newsletter failed: ${error instanceof Error ? error.message : error}`); });
  });
  logger.info(`  ${'newsletter'.padEnd(16)} ${newsletterCron.padEnd(14)} Weekly digest — Mondays 13:00 UTC`);

  if (process.env.RUN_ON_START === 'true') {
    logger.info('[Scheduler] RUN_ON_START=true — running all crawlers now');
    for (const entry of DEFAULT_SCHEDULE) {
      enqueue(entry.crawler);
    }
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

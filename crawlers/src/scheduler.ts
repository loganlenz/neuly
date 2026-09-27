#!/usr/bin/env node
import 'dotenv/config';
import cron from 'node-cron';
import { CrawlerOrchestrator, CrawlerName } from './orchestrator.js';
import { runAlertDispatch } from './alerts/alerts.js';
import { runNewsletter } from './newsletter/digest.js';
import { logger } from './utils/logger.js';
import { DEFAULT_SCHEDULE, Lane, ScheduleEntry } from './schedule.js';

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

  // Two serialized lanes: crawlers within a lane share rate limits, so they
  // queue instead of overlapping, while the live lane (news, quotes) is
  // never stuck behind a multi-minute registry crawl. A crawler already
  // waiting in its lane is not queued twice — at these cadences a slow run
  // would otherwise pile up duplicate work.
  const queues: Record<Lane, Promise<void>> = { live: Promise.resolve(), bulk: Promise.resolve() };
  const pending = new Set<string>();
  const laneOf = (crawler: Exclude<CrawlerName, 'all'>): Lane =>
    DEFAULT_SCHEDULE.find(e => e.crawler === crawler)?.lane ?? 'bulk';
  const enqueue = (crawler: Exclude<CrawlerName, 'all'>) => {
    if (pending.has(crawler)) {
      logger.info(`[Scheduler] ${crawler} already queued — skipping this trigger`);
      return;
    }
    pending.add(crawler);
    const lane = laneOf(crawler);
    queues[lane] = queues[lane]
      .then(() => {
        pending.delete(crawler);
        return orchestrator.run(crawler);
      })
      .catch(error => {
        pending.delete(crawler);
        logger.error(`[Scheduler] ${crawler} run failed: ${error instanceof Error ? error.message : error}`);
      });
  };
  // Product jobs read the change log; they ride the bulk lane
  const enqueueJob = (label: string, job: () => Promise<void>) => {
    queues.bulk = queues.bulk
      .then(job)
      .catch(error => { logger.error(`[Scheduler] ${label} failed: ${error instanceof Error ? error.message : error}`); });
  };

  for (const entry of DEFAULT_SCHEDULE) {
    const expression = scheduleFor(entry);
    cron.schedule(expression, () => {
      logger.info(`[Scheduler] Triggering ${entry.crawler} (${expression})`);
      enqueue(entry.crawler);
    });
    logger.info(`  ${entry.crawler.padEnd(16)} ${expression.padEnd(18)} [${entry.lane}] ${entry.description}`);
  }

  // Product jobs: alert emails hourly (each subscription keeps its own
  // cursor, so nothing is sent twice); the newsletter digest weekly.
  const alertsCron = process.env.SCHEDULE_ALERTS ?? '5 * * * *';
  cron.schedule(alertsCron, () => {
    enqueueJob('Alert dispatch', async () => {
      const { sent } = await runAlertDispatch(orchestrator.storageBackend);
      logger.info(`[Scheduler] Alert dispatch done (${sent} emails)`);
    });
  });
  logger.info(`  ${'alerts'.padEnd(16)} ${alertsCron.padEnd(18)} Alert emails — hourly`);

  const newsletterCron = process.env.SCHEDULE_NEWSLETTER ?? '0 13 * * 1';
  cron.schedule(newsletterCron, () => {
    enqueueJob('Newsletter', async () => {
      const { recipients, eventCount } = await runNewsletter(orchestrator.storageBackend);
      logger.info(`[Scheduler] Newsletter done (${eventCount} events, ${recipients} recipients)`);
    });
  });
  logger.info(`  ${'newsletter'.padEnd(16)} ${newsletterCron.padEnd(18)} Weekly digest — Mondays 13:00 UTC`);

  if (process.env.RUN_ON_START === 'true') {
    // Order matters on a cold start: companies derive from trials, funding
    // and jobs derive from companies, people derive from trials/grants/papers.
    const bootOrder: Array<Exclude<CrawlerName, 'all'>> = [
      'clinicaltrials', 'pubmed', 'preprints', 'grants', 'companies', 'funding', 'jobs', 'people',
      'events', 'legislation', 'care', 'news', 'markets', 'openalex'
    ];
    logger.info('[Scheduler] RUN_ON_START=true — running all crawlers now');
    for (const crawler of bootOrder) {
      enqueue(crawler);
    }
  }

  logger.info('[Scheduler] Running. Ctrl+C to stop.');

  const shutdown = async () => {
    logger.info('[Scheduler] Shutting down...');
    await Promise.all([queues.live, queues.bulk]).catch(() => undefined);
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

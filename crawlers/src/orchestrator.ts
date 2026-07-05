import { ClinicalTrialsCrawler } from './crawlers/ClinicalTrialsCrawler.js';
import { PubMedCrawler } from './crawlers/PubMedCrawler.js';
import { CompanyCrawler } from './crawlers/CompanyCrawler.js';
import { JobCrawler } from './crawlers/JobCrawler.js';
import { EventCrawler } from './crawlers/EventCrawler.js';
import { PeopleCrawler } from './crawlers/PeopleCrawler.js';
import { LegislationCrawler } from './crawlers/LegislationCrawler.js';
import { FundingCrawler } from './crawlers/FundingCrawler.js';
import { PreprintCrawler } from './crawlers/PreprintCrawler.js';
import { GrantsCrawler } from './crawlers/GrantsCrawler.js';
import { OpenAlexEnricher } from './enrichment/OpenAlexEnricher.js';
import { DiffEngine } from './core/DiffEngine.js';
import { CrawlResult } from './core/BaseCrawler.js';
import { DataType } from './utils/storage.js';
import { StorageBackend, createStorage } from './utils/storageBackend.js';
import { logger } from './utils/logger.js';
import { Company, ResearchPaper, CrawledData } from './models/types.js';

export type CrawlerName =
  | 'clinicaltrials' | 'pubmed' | 'companies' | 'jobs' | 'events' | 'people'
  | 'legislation' | 'funding' | 'preprints' | 'grants' | 'openalex'
  | 'all';

interface CrawlerRun {
  type: DataType;
  count: number;
  changes: number;
  error?: string;
}

interface CrawlerSpec {
  type: DataType;
  /** Whether a crawl result is a complete snapshot (enables removal detection) */
  fullSnapshot: boolean;
  run: () => Promise<CrawlResult<CrawledData>>;
}

/**
 * Neuly Crawler Orchestrator
 * Coordinates crawlers, persists results through the configured storage
 * backend, and records change events via the diff engine.
 */
export class CrawlerOrchestrator {
  private storage: StorageBackend;
  private diffEngine = new DiffEngine();
  private crawlers: Map<string, CrawlerSpec>;

  private constructor(storage: StorageBackend) {
    this.storage = storage;
    this.crawlers = new Map();
    this.initializeCrawlers();
  }

  /**
   * Create an orchestrator with the configured storage backend
   * (Postgres when DATABASE_URL is set, JSON files otherwise).
   */
  static async create(outputDir?: string): Promise<CrawlerOrchestrator> {
    const storage = await createStorage({ baseDir: outputDir });
    return new CrawlerOrchestrator(storage);
  }

  get storageLabel(): string {
    return this.storage.label;
  }

  /** Shared backend for jobs that read the change log (alerts, newsletter) */
  get storageBackend(): StorageBackend {
    return this.storage;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  private initializeCrawlers(): void {
    this.crawlers.set('clinicaltrials', {
      type: 'clinical_trials',
      fullSnapshot: false,
      run: () => {
        const crawler = new ClinicalTrialsCrawler();
        return crawler.run(ClinicalTrialsCrawler.getDefaultQueries());
      }
    });

    this.crawlers.set('pubmed', {
      type: 'research_papers',
      fullSnapshot: false,
      run: () => {
        const crawler = new PubMedCrawler(process.env.NCBI_API_KEY);
        return crawler.run(PubMedCrawler.getDefaultQueries());
      }
    });

    this.crawlers.set('companies', {
      type: 'companies',
      fullSnapshot: false,
      run: () => new CompanyCrawler().crawl()
    });

    this.crawlers.set('jobs', {
      type: 'jobs',
      fullSnapshot: true,
      run: async () => {
        // Feed the companies table into ATS auto-discovery so every known
        // company's job board is crawled, not just the seed list.
        const companies = await this.storage.load<Company>('companies');
        const crawler = new JobCrawler({ companies: companies.map(c => c.name) });
        return crawler.crawl();
      }
    });

    this.crawlers.set('events', {
      type: 'events',
      fullSnapshot: false,
      run: () => new EventCrawler().crawl()
    });

    this.crawlers.set('people', {
      type: 'people',
      fullSnapshot: false,
      run: () => new PeopleCrawler().crawl()
    });

    this.crawlers.set('legislation', {
      type: 'legislation',
      fullSnapshot: false,
      run: () => new LegislationCrawler().crawl()
    });

    this.crawlers.set('funding', {
      type: 'funding_events',
      fullSnapshot: false,
      run: () => new FundingCrawler().crawl()
    });

    // Preprints feed the shared research_papers dataset
    this.crawlers.set('preprints', {
      type: 'research_papers',
      fullSnapshot: false,
      run: () => new PreprintCrawler().crawl()
    });

    this.crawlers.set('grants', {
      type: 'grants',
      fullSnapshot: false,
      run: () => new GrantsCrawler().crawl()
    });

    // Enrichment, not crawling: refreshes citation counts on stored papers.
    // Returns only changed papers so the upsert (and diff) stay minimal.
    this.crawlers.set('openalex', {
      type: 'research_papers',
      fullSnapshot: false,
      run: async () => {
        const startTime = Date.now();
        const papers = await this.storage.load<ResearchPaper>('research_papers');
        const updated = await new OpenAlexEnricher().enrich(papers);
        return {
          success: true,
          data: updated,
          stats: {
            total: papers.length,
            successful: updated.length,
            failed: 0,
            duration: Date.now() - startTime
          }
        };
      }
    });
  }

  /**
   * Run one crawler: crawl, diff against stored state, record change
   * events, then upsert the fresh data.
   */
  private async runCrawler(name: string, spec: CrawlerSpec): Promise<CrawlerRun> {
    const result = await spec.run();
    const data = result.data ?? [];

    if (data.length === 0) {
      return { type: spec.type, count: 0, changes: 0 };
    }

    const previous = await this.storage.load(spec.type);
    const events = this.diffEngine.diff(spec.type, previous, data, {
      // Only trust absences as removals when every source succeeded;
      // a failed board mid-crawl must not read as "all its jobs removed".
      detectRemovals: spec.fullSnapshot && result.success
    });

    if (events.length > 0) {
      await this.storage.saveChangeEvents(events);
      const removedIds = events.filter(e => e.changeType === 'removed').map(e => e.entityId);
      if (removedIds.length > 0) {
        await this.storage.delete(spec.type, removedIds);
      }
    }

    await this.storage.upsert(spec.type, data);
    return { type: spec.type, count: data.length, changes: events.length };
  }

  /**
   * Run a specific crawler or all crawlers
   */
  async run(crawlerName: CrawlerName): Promise<void> {
    const startTime = Date.now();

    logger.info('='.repeat(60));
    logger.info('Neuly Crawler Orchestrator');
    logger.info('='.repeat(60));
    logger.info(`Running: ${crawlerName}`);
    logger.info(`Storage: ${this.storage.label}`);
    logger.info('');

    const results: CrawlerRun[] = [];
    const toRun = crawlerName === 'all'
      ? Array.from(this.crawlers.entries())
      : this.crawlers.has(crawlerName)
        ? [[crawlerName, this.crawlers.get(crawlerName)!] as const]
        : [];

    if (toRun.length === 0) {
      logger.error(`Unknown crawler: ${crawlerName}`);
      logger.info(`Available crawlers: ${Array.from(this.crawlers.keys()).join(', ')}, all`);
      return;
    }

    for (const [name, spec] of toRun) {
      try {
        logger.info(`\n${'─'.repeat(40)}`);
        logger.info(`Starting: ${name}`);
        logger.info('─'.repeat(40));

        const result = await this.runCrawler(name, spec);
        results.push(result);

        logger.info(`Completed: ${name} - ${result.count} items, ${result.changes} changes`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        results.push({ type: this.crawlers.get(name)!.type, count: 0, changes: 0, error: errorMsg });
        logger.error(`Failed: ${name} - ${errorMsg}`);
      }
    }

    // Print summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const totalItems = results.reduce((sum, r) => sum + r.count, 0);
    const totalChanges = results.reduce((sum, r) => sum + r.changes, 0);
    const failures = results.filter(r => r.error).length;

    logger.info('');
    logger.info('='.repeat(60));
    logger.info('Crawl Summary');
    logger.info('='.repeat(60));

    for (const result of results) {
      const status = result.error ? `FAILED: ${result.error}` : `${result.count} items, ${result.changes} changes`;
      logger.info(`  ${result.type}: ${status}`);
    }

    logger.info('─'.repeat(60));
    logger.info(`Total items: ${totalItems}`);
    logger.info(`Change events: ${totalChanges}`);
    logger.info(`Duration: ${duration}s`);
    logger.info(`Failures: ${failures}`);
    logger.info('='.repeat(60));
  }

  /**
   * Generate and print a data report
   */
  async report(): Promise<void> {
    const stats = await this.storage.getStats();
    const lines: string[] = [
      '# Neuly Data Report',
      `Generated: ${new Date().toISOString()}`,
      `Storage: ${this.storage.label}`,
      '',
      '## Data Counts',
      ''
    ];

    if (stats) {
      for (const [type, count] of Object.entries(stats.counts)) {
        lines.push(`- ${type}: ${count} items`);
      }
      if (stats.crawlHistory.length > 0) {
        lines.push('', '## Recent Crawl History', '');
        for (const entry of stats.crawlHistory.slice(-10)) {
          lines.push(`- ${entry.type}: ${entry.count} items at ${entry.timestamp}`);
        }
      }
    } else {
      lines.push('No data has been crawled yet.');
    }

    const recentChanges = await this.storage.loadChangeEvents({ limit: 15 });
    if (recentChanges.length > 0) {
      lines.push('', '## Recent Changes', '');
      for (const event of recentChanges) {
        lines.push(`- [${event.detectedAt}] ${event.summary}`);
      }
    }

    console.log(lines.join('\n'));
  }

  /**
   * Get storage statistics
   */
  async stats(): Promise<void> {
    const stats = await this.storage.getStats();

    if (!stats) {
      logger.info('No data has been crawled yet.');
      return;
    }

    logger.info('='.repeat(60));
    logger.info('Data Statistics');
    logger.info('='.repeat(60));
    logger.info(`Last updated: ${stats.lastUpdated}`);
    logger.info('');
    logger.info('Counts:');

    for (const [type, count] of Object.entries(stats.counts)) {
      logger.info(`  ${type}: ${count}`);
    }

    logger.info('='.repeat(60));
  }
}

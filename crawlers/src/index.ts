#!/usr/bin/env node
import 'dotenv/config';
import { ClinicalTrialsCrawler } from './crawlers/ClinicalTrialsCrawler.js';
import { PubMedCrawler } from './crawlers/PubMedCrawler.js';
import { CompanyCrawler } from './crawlers/CompanyCrawler.js';
import { JobCrawler } from './crawlers/JobCrawler.js';
import { EventCrawler } from './crawlers/EventCrawler.js';
import { PeopleCrawler } from './crawlers/PeopleCrawler.js';
import { DataStorage, DataType } from './utils/storage.js';
import { logger } from './utils/logger.js';

type CrawlerName = 'clinicaltrials' | 'pubmed' | 'companies' | 'jobs' | 'events' | 'people' | 'all';

// Special CLI commands that aren't crawlers but share the same option slot.
type Command = CrawlerName | 'stats' | 'report';

interface CrawlOptions {
  crawler: Command;
  query?: string;
  outputDir?: string;
  dryRun?: boolean;
}

/**
 * Neuly Crawler Orchestrator
 * Coordinates all data crawlers and manages data storage
 */
class CrawlerOrchestrator {
  private storage: DataStorage;
  private crawlers: Map<string, () => Promise<{ type: DataType; count: number }>>;

  constructor(outputDir?: string) {
    this.storage = new DataStorage({ baseDir: outputDir });
    this.crawlers = new Map();
    this.initializeCrawlers();
  }

  private initializeCrawlers(): void {
    // Clinical Trials
    this.crawlers.set('clinicaltrials', async () => {
      const crawler = new ClinicalTrialsCrawler();
      const queries = ClinicalTrialsCrawler.getDefaultQueries();
      const result = await crawler.run(queries);

      if (result.data && result.data.length > 0) {
        await this.storage.upsert('clinical_trials', result.data);
      }

      return { type: 'clinical_trials' as DataType, count: result.data?.length || 0 };
    });

    // PubMed Research Papers
    this.crawlers.set('pubmed', async () => {
      const crawler = new PubMedCrawler(process.env.NCBI_API_KEY);
      const queries = PubMedCrawler.getDefaultQueries();
      const result = await crawler.run(queries);

      if (result.data && result.data.length > 0) {
        await this.storage.upsert('research_papers', result.data);
      }

      return { type: 'research_papers' as DataType, count: result.data?.length || 0 };
    });

    // Companies
    this.crawlers.set('companies', async () => {
      const crawler = new CompanyCrawler();
      const result = await crawler.crawl();

      if (result.data && result.data.length > 0) {
        await this.storage.upsert('companies', result.data);
      }

      return { type: 'companies' as DataType, count: result.data?.length || 0 };
    });

    // Jobs
    this.crawlers.set('jobs', async () => {
      const crawler = new JobCrawler();
      const result = await crawler.crawl();

      if (result.data && result.data.length > 0) {
        await this.storage.upsert('jobs', result.data);
      }

      return { type: 'jobs' as DataType, count: result.data?.length || 0 };
    });

    // Events
    this.crawlers.set('events', async () => {
      const crawler = new EventCrawler();
      const result = await crawler.crawl();

      if (result.data && result.data.length > 0) {
        await this.storage.upsert('events', result.data);
      }

      return { type: 'events' as DataType, count: result.data?.length || 0 };
    });

    // People
    this.crawlers.set('people', async () => {
      const crawler = new PeopleCrawler();
      const result = await crawler.crawl();

      if (result.data && result.data.length > 0) {
        await this.storage.upsert('people', result.data);
      }

      return { type: 'people' as DataType, count: result.data?.length || 0 };
    });
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
    logger.info(`Output directory: ${this.storage['baseDir']}`);
    logger.info('');

    const results: Array<{ type: DataType; count: number; error?: string }> = [];

    if (crawlerName === 'all') {
      // Run all crawlers
      for (const [name, crawlFn] of this.crawlers) {
        try {
          logger.info(`\n${'─'.repeat(40)}`);
          logger.info(`Starting: ${name}`);
          logger.info('─'.repeat(40));

          const result = await crawlFn();
          results.push(result);

          logger.info(`Completed: ${name} - ${result.count} items`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          results.push({ type: name as DataType, count: 0, error: errorMsg });
          logger.error(`Failed: ${name} - ${errorMsg}`);
        }
      }
    } else {
      // Run specific crawler
      const crawlFn = this.crawlers.get(crawlerName);

      if (!crawlFn) {
        logger.error(`Unknown crawler: ${crawlerName}`);
        logger.info(`Available crawlers: ${Array.from(this.crawlers.keys()).join(', ')}, all`);
        return;
      }

      try {
        const result = await crawlFn();
        results.push(result);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        results.push({ type: crawlerName as DataType, count: 0, error: errorMsg });
        logger.error(`Crawler failed: ${errorMsg}`);
      }
    }

    // Print summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const totalItems = results.reduce((sum, r) => sum + r.count, 0);
    const failures = results.filter(r => r.error).length;

    logger.info('');
    logger.info('='.repeat(60));
    logger.info('Crawl Summary');
    logger.info('='.repeat(60));

    for (const result of results) {
      const status = result.error ? `FAILED: ${result.error}` : `${result.count} items`;
      logger.info(`  ${result.type}: ${status}`);
    }

    logger.info('─'.repeat(60));
    logger.info(`Total items: ${totalItems}`);
    logger.info(`Duration: ${duration}s`);
    logger.info(`Failures: ${failures}`);
    logger.info('='.repeat(60));
  }

  /**
   * Generate and print a data report
   */
  async report(): Promise<void> {
    const report = await this.storage.generateReport();
    console.log(report);
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

/**
 * Parse command line arguments
 */
function parseArgs(): CrawlOptions {
  const args = process.argv.slice(2);
  const options: CrawlOptions = {
    crawler: 'all'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--crawler' || arg === '-c') {
      options.crawler = args[++i] as CrawlerName;
    } else if (arg.startsWith('--crawler=')) {
      options.crawler = arg.split('=')[1] as CrawlerName;
    } else if (arg === '--query' || arg === '-q') {
      options.query = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.outputDir = args[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--stats') {
      options.crawler = 'stats';
    } else if (arg === '--report') {
      options.crawler = 'report';
    }
  }

  return options;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
Neuly Crawler - Data collection for psychedelic medicine research

Usage:
  npm run crawl:all              Run all crawlers
  npm run crawl:trials           Crawl ClinicalTrials.gov
  npm run crawl:pubmed           Crawl PubMed research papers
  npm run crawl:companies        Crawl company data
  npm run crawl:jobs             Crawl job postings
  npm run crawl:events           Crawl events and conferences
  npm run crawl:people           Crawl researcher profiles

Options:
  --crawler, -c <name>    Specify crawler to run
                          Options: clinicaltrials, pubmed, companies,
                                   jobs, events, people, all
  --query, -q <query>     Custom search query
  --output, -o <dir>      Output directory (default: ./data)
  --dry-run               Don't save results
  --stats                 Show data statistics
  --report                Generate data report
  --help, -h              Show this help message

Environment Variables:
  NCBI_API_KEY           API key for PubMed (optional, increases rate limit)
  LOG_LEVEL              Logging level (debug, info, warn, error)

Examples:
  # Run all crawlers
  npm run dev

  # Run only clinical trials crawler
  npm run dev -- --crawler=clinicaltrials

  # Custom query for PubMed
  npm run dev -- --crawler=pubmed --query="psilocybin depression 2024"

  # Check statistics
  npm run dev -- --stats
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const options = parseArgs();
  const orchestrator = new CrawlerOrchestrator(options.outputDir);

  try {
    if (options.crawler === 'stats') {
      await orchestrator.stats();
    } else if (options.crawler === 'report') {
      await orchestrator.report();
    } else {
      await orchestrator.run(options.crawler);
    }
  } catch (error) {
    logger.error(`Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

// Run main
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Export for programmatic use
export { CrawlerOrchestrator };
export { ClinicalTrialsCrawler } from './crawlers/ClinicalTrialsCrawler.js';
export { PubMedCrawler } from './crawlers/PubMedCrawler.js';
export { CompanyCrawler } from './crawlers/CompanyCrawler.js';
export { JobCrawler } from './crawlers/JobCrawler.js';
export { EventCrawler } from './crawlers/EventCrawler.js';
export { PeopleCrawler } from './crawlers/PeopleCrawler.js';
export { DataStorage } from './utils/storage.js';
export * from './models/types.js';

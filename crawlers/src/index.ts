#!/usr/bin/env node
import 'dotenv/config';
import { CrawlerOrchestrator, CrawlerName } from './orchestrator.js';
import { logger } from './utils/logger.js';

interface CrawlOptions {
  crawler: CrawlerName;
  query?: string;
  outputDir?: string;
  dryRun?: boolean;
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
      options.crawler = 'stats' as CrawlerName;
    } else if (arg === '--report') {
      options.crawler = 'report' as CrawlerName;
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
  npm run crawl:companies       Crawl company data
  npm run crawl:jobs             Crawl job postings
  npm run crawl:events           Crawl events and conferences
  npm run crawl:people           Crawl researcher profiles
  npm run schedule               Run the crawl scheduler (per-source cadence)
  npm run db:migrate             Apply the Postgres schema (DATABASE_URL)

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
  DATABASE_URL           Postgres connection string; when set, data is
                         stored in Postgres instead of JSON files
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
  const orchestrator = await CrawlerOrchestrator.create(options.outputDir);

  try {
    if (options.crawler === ('stats' as CrawlerName)) {
      await orchestrator.stats();
    } else if (options.crawler === ('report' as CrawlerName)) {
      await orchestrator.report();
    } else {
      await orchestrator.run(options.crawler);
    }
  } catch (error) {
    logger.error(`Fatal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    await orchestrator.close();
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
export { DiffEngine } from './core/DiffEngine.js';
export { DataStorage } from './utils/storage.js';
export { PostgresStorage } from './utils/postgresStorage.js';
export { createStorage } from './utils/storageBackend.js';
export type { StorageBackend } from './utils/storageBackend.js';
export { AtsDiscovery, slugCandidates } from './utils/atsDiscovery.js';
export * from './models/types.js';

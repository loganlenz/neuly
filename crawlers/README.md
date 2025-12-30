# Neuly Crawlers

Data collection system for the Neuly psychedelic medicine research platform. This crawler system fetches data from multiple authoritative sources to populate the Neuly database with clinical trials, research papers, company information, job postings, events, and researcher profiles.

## Features

- **ClinicalTrials.gov Crawler** - Fetches psychedelic clinical trials data
- **PubMed Crawler** - Collects peer-reviewed research papers
- **Company Crawler** - Gathers SEC filings and company information
- **Job Crawler** - Aggregates job postings from company career pages
- **Event Crawler** - Tracks conferences, webinars, and industry events
- **People Crawler** - Profiles key researchers and industry figures

## Installation

```bash
cd crawlers
npm install
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NCBI_API_KEY` | API key for PubMed (increases rate limit from 3/sec to 10/sec) | No |
| `LOG_LEVEL` | Logging level: debug, info, warn, error | No |

To get an NCBI API key:
1. Go to https://www.ncbi.nlm.nih.gov/account/
2. Sign in or create an account
3. Go to Settings > API Key Management
4. Generate a new API key

## Usage

### Run All Crawlers

```bash
npm run crawl:all
```

### Run Individual Crawlers

```bash
# Clinical trials from ClinicalTrials.gov
npm run crawl:trials

# Research papers from PubMed
npm run crawl:pubmed

# Company information
npm run crawl:companies

# Job postings
npm run crawl:jobs

# Events and conferences
npm run crawl:events

# Researcher profiles
npm run crawl:people
```

### Development Mode

```bash
npm run dev
```

### Build

```bash
npm run build
npm start
```

### View Statistics

```bash
npm run dev -- --stats
```

### Generate Report

```bash
npm run dev -- --report
```

## Project Structure

```
crawlers/
├── src/
│   ├── crawlers/           # Individual crawler implementations
│   │   ├── ClinicalTrialsCrawler.ts
│   │   ├── PubMedCrawler.ts
│   │   ├── CompanyCrawler.ts
│   │   ├── JobCrawler.ts
│   │   ├── EventCrawler.ts
│   │   └── PeopleCrawler.ts
│   ├── core/               # Base crawler class
│   │   └── BaseCrawler.ts
│   ├── models/             # Data type definitions
│   │   └── types.ts
│   ├── utils/              # Utility functions
│   │   ├── logger.ts
│   │   └── storage.ts
│   └── index.ts            # Main orchestrator and CLI
├── data/                   # Crawled data output (gitignored)
├── logs/                   # Log files (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

## Data Sources

### ClinicalTrials.gov
- **API**: https://clinicaltrials.gov/data-api/api
- **Data**: Clinical trials involving psychedelic substances
- **Rate Limit**: 3 requests/second (we use conservative limits)

### PubMed (NCBI E-utilities)
- **API**: https://www.ncbi.nlm.nih.gov/books/NBK25500/
- **Data**: Peer-reviewed research papers
- **Rate Limit**: 3/sec without key, 10/sec with API key

### SEC EDGAR
- **API**: https://www.sec.gov/developer
- **Data**: Public company filings (10-K, 10-Q, 8-K)
- **Rate Limit**: 10 requests/second

### Job Boards
- **Sources**: Greenhouse, Lever APIs from company career pages
- **Companies**: COMPASS Pathways, MindMed, Cybin, Atai, Numinus

## Data Types

The system collects and validates the following data types:

| Type | Description | Primary Sources |
|------|-------------|-----------------|
| `ClinicalTrial` | Clinical study records | ClinicalTrials.gov |
| `ResearchPaper` | Peer-reviewed publications | PubMed |
| `Company` | Psychedelic medicine companies | SEC EDGAR, manual curation |
| `JobPosting` | Industry job opportunities | Company career pages |
| `Event` | Conferences and webinars | Manual curation |
| `Person` | Researchers and executives | PubMed, manual curation |

## Substances Tracked

- Psilocybin
- MDMA
- Ketamine
- LSD
- DMT / 5-MeO-DMT
- Ibogaine
- Ayahuasca
- Cannabis
- Mescaline

## Output

Data is stored in JSON format in the `data/` directory:

```
data/
├── clinical_trials.json
├── research_papers.json
├── companies.json
├── jobs.json
├── events.json
├── people.json
└── manifest.json      # Crawl metadata and statistics
```

## Programmatic Usage

```typescript
import {
  CrawlerOrchestrator,
  ClinicalTrialsCrawler,
  PubMedCrawler,
  DataStorage
} from 'neuly-crawlers';

// Run all crawlers
const orchestrator = new CrawlerOrchestrator('./data');
await orchestrator.run('all');

// Run individual crawler
const trialsCrawler = new ClinicalTrialsCrawler();
const result = await trialsCrawler.run(['psilocybin depression']);

// Access stored data
const storage = new DataStorage({ baseDir: './data' });
const trials = await storage.load('clinical_trials');
```

## Rate Limiting & Ethics

All crawlers implement respectful rate limiting:
- Automatic delays between requests
- Exponential backoff on failures
- Proper User-Agent identification
- Compliance with robots.txt

## Contributing

1. Add new crawler in `src/crawlers/`
2. Extend `BaseCrawler` class
3. Define data schema in `src/models/types.ts`
4. Register crawler in `src/index.ts`

## License

MIT

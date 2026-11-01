# Neuly Crawlers

Data collection system for the Neuly psychedelic medicine research platform. This crawler system fetches data from multiple authoritative sources to populate the Neuly database with clinical trials, research papers, company information, job postings, events, and researcher profiles.

## Features

- **ClinicalTrials.gov Crawler** - Every study for every tracked substance — interventional trials, observational studies and expanded-access programs, in every status (terminated and withdrawn included, with the sponsor's stop reason), with design (allocation, masking, observational model), posted-results flag, lead sponsor class and principal investigators. `crawl:trials` is the full sweep; `crawl:trials:recent` the hourly incremental refresh of recently updated records
- **PubMed Crawler** - Peer-reviewed papers across ~45 substance/indication queries
- **Preprint Crawler** - Europe PMC preprint search (bioRxiv, medRxiv, Research Square, SSRN, PsyArXiv, ...): research 6-18 months ahead of the journals
- **Company Crawler** - Seven sources into one dataset: a curated list, every SEC filer whose filings mention a tracked substance (EDGAR full-text search, filtered to pharma/biotech/healthcare SIC codes), every industry sponsor and corporate collaborator of a tracked trial, NIH awardee companies (SBIR/STTR), Form D filers found by sector search, and companies named in 3+ sector headlines. Every row carries its source and evidence; SEC CIKs are resolved from the SEC ticker file, never hard-coded
- **Legislation Crawler** - State bills (LegiScan) + federal rules and notices (Federal Register) that are actually about the sector: the policy tracker
- **Funding Crawler** - SEC Form D filings for every company with a CIK, with offering amount, amount sold, investor count and named officers parsed from the filing
- **Grants Crawler** - NIH RePORTER research grants: the leading indicator of future trials
- **Job Crawler** - Auto-discovers ATS boards (Greenhouse, Lever, Ashby, Workable) for every company in the database and aggregates their postings
- **Event Crawler** - Recurring conferences projected to their next edition
- **People Crawler** - Curated key figures plus people derived from the data: trial principal investigators, NIH grant PIs, authors with 5+ papers in the corpus, and the officers and directors of every tracked company — public companies from three years of SEC Forms 3/4/5 ownership filings (`SecInsidersSource`), private companies from the related persons on their Form D filings, and every company's own leadership/team page (`TeamPageSource`: name, title, headshot) — each linked to the company (`companyIds`, `affiliations`) with the evidence for inclusion
- **Headshot Enrichment** - Daily: freely licensed photos from Wikidata/Wikimedia Commons for people without one (verified human + role-matching description), with attribution stored on the record
- **Care Crawler** - Care directory: state-licensed psilocybin service centers (Oregon Psilocybin Services, best-effort) plus a curated list of established clinics, telehealth platforms and research centers, flagged `verified` only when a regulator record backs them
- **OpenAlex Enrichment** - Refreshes citation counts and open-access flags on stored papers
- **Readout Calendar** - `/api/readouts` derives expected trial results windows from completion dates — the sector's earnings calendar
- **Postgres or JSON storage** - Set `DATABASE_URL` to store in Postgres; falls back to JSON files
- **Diff engine** - Every crawl is compared to the stored state and typed change events (`added` / `updated` / `removed`) are recorded, exposed at `/api/changes`
- **Scheduler** - `npm run schedule` runs each crawler on its own cron cadence

## Product surface

- **Accounts & plans** - signup/login with session cookies (`/api/auth/*`); free / pro / enterprise plans; roles `user` / `admin` (bootstrapped from `ADMIN_EMAILS`); forgot/reset password by email, profile, change password, delete account; brute-force rate limits and an audit log
- **Datasets** - user-built collections (`/api/datasets`): hand-picked records plus live saved queries (same filters as the list endpoints), resolved on every read, exported as CSV/JSON (Pro) and shared publicly by slug (Pro)
- **Public API** - `/api/v1/*` alias of every endpoint, API keys for Pro/Enterprise with daily quotas and per-minute bursts metered in `api_usage`, `X-RateLimit-*` headers, `/api/openapi.json`, `/docs`, and `/api/v1/bulk/:table` NDJSON/JSON/CSV downloads for Enterprise. One filter implementation (`src/web/dataQuery.ts`) backs the UI, the API and saved queries
- **Admin console** - `/api/admin/*` (and `/admin` in the app): users, plan/role overrides, business overview, run-any-crawler-now via the `crawl_requests` table the scheduler polls, audit log, partner claims and leads
- **Marketplace** - `/api/track/view` (signed-in interest log), `/api/leads` (care inquiries and study-participation interest with consent), `/api/partners` (claim a listing, activity log, masked leads, Stripe pay-per-lead unlock), `/api/admin/marketplace` (approve claims, set prices, comp leads, revenue)
- **Entity pages** - server-rendered `/news/:id`, `/bills/:id`, `/funding/:id`, `/grants/:id`, `/papers/:id`, `/jobs/:id`, `/events/:id`, `/care/:id`, `/people/:id` in addition to trials, companies, substances and policy; outbound links pass through a leaving-Neuly interstitial; anonymous visitors get summaries and sign-up gates
- **Saved items** - per-user save/follow of any entity (`/api/saves`), shown on the dashboard and the saved/following tabs
- **Plan gating** - one catalog in `src/web/plans.ts`: free sees 7 days of change history, a 90-day readout horizon, 1 dataset and 1 alert; Pro adds full history, unlimited datasets/alerts, exports, share links and API keys (2,000 requests/day); Enterprise adds 100,000 requests/day and bulk downloads
- **Alerts** - saved subscriptions (`/api/alerts`, entity type + keyword) matched daily against the change log and emailed
- **Newsletter** - auto-generated weekly digest (changes by section + upcoming readouts), archived in `newsletter_issues` and sent to opted-in users
- **Email delivery** - Resend when `RESEND_API_KEY` is set; otherwise messages land in `data/outbox/` (dev-friendly)
- **Billing** - `/api/billing/plans`, Stripe Checkout (reusing the customer), signature-verified webhook keeping `users.plan` / `plan_status` in sync with subscription and invoice events, customer portal — enabled by the `STRIPE_*` env vars
- **Programmatic SEO pages** - server-rendered, crawlable pages generated from the database: `/substances/:slug`, `/trials/:nctId`, `/company-profiles/:slug`, `/policy/:jurisdiction`, `/readouts-calendar`, plus `robots.txt` and `sitemap.xml`

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
| `DATABASE_URL` | Postgres connection string; when set, data is stored in Postgres instead of JSON files | No |
| `NCBI_API_KEY` | API key for PubMed (increases rate limit from 3/sec to 10/sec) | No |
| `LEGISCAN_API_KEY` | LegiScan key for state bills (free at legiscan.com/legiscan); Federal Register works without it | No |
| `OPENALEX_MAILTO` | Email for the OpenAlex polite pool (faster, more reliable) | No |
| `OREGON_PSILOCYBIN_API` | Override for the Oregon Psilocybin Services licensee directory endpoint used by the care crawler | No |
| `LOG_LEVEL` | Logging level: debug, info, warn, error | No |
| `RUN_ON_START` | Scheduler: run all crawlers immediately on startup | No |
| `SCHEDULE_<CRAWLER>` | Scheduler: cron override per crawler, e.g. `SCHEDULE_JOBS="30 7 * * *"` (`SCHEDULE_TRIALS_RECENT` for the incremental trials crawl) | No |
| `ADMIN_EMAILS` | Operator emails promoted to the admin role | No |
| `CORS_ORIGINS` | Allowed browser origins for cookie-authenticated calls (unset = any) | No |
| `API_QUOTA_PRO` / `API_QUOTA_ENTERPRISE` | API requests per day per plan | No |
| `PLAN_PRICE_PRO` / `PLAN_PRICE_ENTERPRISE` | Display prices on the pricing page | No |

### Postgres

```bash
# create the database, then:
DATABASE_URL=postgresql://user:pass@host:5432/neuly npm run db:migrate
DATABASE_URL=postgresql://user:pass@host:5432/neuly npm run seed
```

The schema (`src/db/schema.sql`) stores each entity as JSONB with provenance
columns (`source`, `first_seen_at`, `updated_at`), plus `change_events`
(diff engine output) and `crawl_runs` (crawl history) tables.

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

# State bills + Federal Register documents
npm run crawl:legislation

# SEC Form D funding events
npm run crawl:funding

# bioRxiv/medRxiv preprints
npm run crawl:preprints

# NIH research grants
npm run crawl:grants

# Licensed care providers + curated clinics
npm run crawl:care

# Refresh citation counts from OpenAlex
npm run enrich:openalex
```

### Substance taxonomy

Every record is tagged against one shared taxonomy (`src/utils/substances.ts`):
Psilocybin, MDMA, Ketamine, LSD, DMT, 5-MeO-DMT, Ibogaine, Ayahuasca, Cannabis,
Mescaline, Kratom, Kava, Salvia, Kanna, Amanita Muscaria. Adding a substance
there (pattern + query term) flows through every crawler and the API.

### Seed vs crawled data

`npm run seed` writes only first-boot content whose ids match what the
crawlers produce (the curated company and people lists, projected recurring
events, curated care providers and training programs). Trials, papers, jobs,
legislation, funding and grants come exclusively from crawls.
`npm run db:cleanup-legacy` (run automatically by `deploy:start`) removes the
placeholder rows earlier seed versions wrote.

### Run the Scheduler

Runs each crawler on its own cadence (trials twice daily, SEC filings on
weekdays, jobs daily, PubMed twice weekly, ...). Override any cadence with
`SCHEDULE_<CRAWLER>`.

```bash
npm run schedule
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
- **Sources**: Greenhouse, Lever, Ashby, and Workable public APIs
- **Discovery**: ATS boards are probed automatically for every company in the
  companies table (slug candidates derived from the company name); hits and
  misses are cached in `data/ats_boards.json`. A seed list (COMPASS Pathways,
  MindMed, Cybin, Atai, Numinus) is always crawled.

## Data Types

The system collects and validates the following data types:

| Type | Description | Primary Sources |
|------|-------------|-----------------|
| `ClinicalTrial` | Clinical study records | ClinicalTrials.gov |
| `ResearchPaper` | Peer-reviewed publications + preprints | PubMed, bioRxiv, medRxiv, OpenAlex |
| `Company` | Psychedelic medicine companies | SEC EDGAR, manual curation |
| `LegislationBill` | State bills and federal regulatory actions | LegiScan, Federal Register |
| `FundingEvent` | Private raises (Form D exempt offerings) | SEC EDGAR full-text search |
| `Grant` | Research grants | NIH RePORTER |
| `JobPosting` | Industry job opportunities | Company ATS boards (auto-discovered) |
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

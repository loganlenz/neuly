#!/usr/bin/env node
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { DataType } from './utils/storage.js';
import { createStorage } from './utils/storageBackend.js';
import { attachUser, authRouter, apiKeysRouter, requirePlan, AuthedRequest } from './auth/auth.js';
import { savesRouter } from './user/saves.js';
import { alertsRouter } from './alerts/alerts.js';
import { billingRouter, handleStripeWebhook } from './billing/stripe.js';
import { seoRouter } from './web/seoPages.js';
import { clampChangesSince, clampReadoutHorizon, toCsv } from './web/gating.js';
import { ALL_DATA_TYPES } from './utils/storage.js';
import { logger } from './utils/logger.js';
import {
  ClinicalTrial,
  ResearchPaper,
  Company,
  Person,
  JobPosting,
  Event,
  LegislationBill,
  FundingEvent,
  Grant,
  CareProvider,
  NewsItem,
  MarketQuote,
  SUBSTANCES
} from './models/types.js';
import { deriveReadoutCalendar } from './core/readouts.js';
import { LiveHub, buildFreshness } from './web/liveHub.js';
import { adminRouter } from './admin/admin.js';
import { datasetsRouter } from './datasets/datasets.js';
import { versionAlias, apiTrafficPolicy, publicApiRouter, listResponse, API_VERSION } from './web/publicApi.js';
import { appDbAvailable, getAppDb } from './db/appDb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const storage = await createStorage();
const liveHub = new LiveHub(storage);

// Behind Render's proxy: req.ip and req.secure reflect the client
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers (no helmet dependency needed for this surface)
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS. CORS_ORIGINS (comma separated) pins the allowed browser origins in
// production; unset, every origin is reflected so a statically hosted
// frontend works out of the box. API-key clients are unaffected either way.
const allowedOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length > 0
    ? (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
    : true,
  credentials: true,
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Neuly-Rows', 'Retry-After']
}));

// Stripe webhook needs the raw bytes for signature verification, so it is
// mounted before the JSON body parser.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json({ limit: '256kb' }));
app.use(versionAlias());
app.use(attachUser());
app.use(apiTrafficPolicy());

// Serve the frontend (index.html) from the project root
const projectRoot = join(__dirname, '..', '..');
if (existsSync(join(projectRoot, 'index.html'))) {
  app.use(express.static(projectRoot, { index: false }));
}

// Request logging (skip static files)
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api')) {
    logger.info(`${req.method} ${req.path}`);
  }
  next();
});

// ============================================
// API ROUTES
// ============================================

/** Split "Robin L. Carhart-Harris" → { first: 'robin', last: 'carhart-harris' } */
function normalizeAuthor(name: string): { first?: string; last?: string } {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (!cleaned) return {};
  if (cleaned.includes(',')) {
    // "Carhart-Harris, Robin"
    const [last, rest] = cleaned.split(',').map(s => s.trim().toLowerCase());
    return { last, first: rest?.split(' ')[0] };
  }
  const parts = cleaned.toLowerCase().split(' ');
  return { last: parts[parts.length - 1], first: parts.length > 1 ? parts[0] : undefined };
}

/** PubMed stores "Carhart-Harris R"; Europe PMC "Carhart-Harris RL"; curated "Robin Carhart-Harris" */
function authorMatches(stored: string, wanted: { first?: string; last?: string }): boolean {
  const s = stored.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!wanted.last || !s.includes(wanted.last)) return false;
  if (!wanted.first) return true;
  const rest = s.replace(wanted.last, ' ').trim();
  return rest === '' || rest.startsWith(wanted.first) || rest.startsWith(wanted.first[0]) || rest.endsWith(` ${wanted.first[0]}`) || rest.includes(` ${wanted.first}`);
}

/**
 * Leadership for a company: people the SEC filings (or curation) link to
 * it. Officers first, then directors, then everyone else.
 */
function leadershipFor(company: Company, people: Person[]): Company['leadership'] {
  const linked = people.filter(p => p.companyIds?.includes(company.id));
  if (linked.length === 0) return company.leadership;
  const rank = (p: Person) => {
    const aff = p.affiliations?.find(a => a.companyId === company.id);
    const role = (aff?.role ?? p.title ?? '').toLowerCase();
    if (/chief executive|\bceo\b|president|founder/.test(role)) return 0;
    if (/chief|officer|\bcfo\b|\bcmo\b|\bcoo\b|\bcso\b/.test(role)) return 1;
    if (/director|board/.test(role)) return 2;
    return 3;
  };
  const fromPeople = linked
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(p => ({
      name: p.name,
      title: p.affiliations?.find(a => a.companyId === company.id)?.role ?? p.title ?? 'Executive',
      personId: p.id,
      source: p.affiliations?.find(a => a.companyId === company.id)?.source
    }));
  const seen = new Set(fromPeople.map(l => l.name.toLowerCase()));
  const curated = (company.leadership ?? []).filter(l => !seen.has(l.name.toLowerCase()));
  return [...fromPeople, ...curated] as Company['leadership'];
}

/**
 * Health check endpoint (includes the database when configured)
 */
app.get('/api/health', async (_req: Request, res: Response) => {
  let database: 'ok' | 'error' | 'not-configured' = 'not-configured';
  if (appDbAvailable()) {
    try {
      await getAppDb().query('SELECT 1');
      database = 'ok';
    } catch {
      database = 'error';
    }
  }
  res.status(database === 'error' ? 503 : 200).json({
    status: database === 'error' ? 'degraded' : 'ok',
    timestamp: new Date().toISOString(),
    version: API_VERSION,
    storage: storage.label.split(':')[0],
    database
  });
});

/**
 * Get data statistics
 */
app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await storage.getStats();
    if (!stats) {
      return res.json({
        message: 'No data has been crawled yet',
        counts: {}
      });
    }
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================
// CLINICAL TRIALS
// ============================================

app.get('/api/clinical-trials', async (req: Request, res: Response) => {
  try {
    const trials = await storage.load<ClinicalTrial>('clinical_trials');
    res.json(listResponse('clinical_trials', trials, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching clinical trials: ${error}`);
    res.status(500).json({ error: 'Failed to fetch clinical trials' });
  }
});

app.get('/api/clinical-trials/:id', async (req: Request, res: Response) => {
  try {
    const trials = await storage.load<ClinicalTrial>('clinical_trials');
    const wanted = req.params.id.toLowerCase();
    const trial = trials.find(t => t.id === req.params.id || t.nctId.toLowerCase() === wanted);

    if (!trial) {
      return res.status(404).json({ error: 'Clinical trial not found' });
    }

    res.json(trial);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch clinical trial' });
  }
});

// ============================================
// RESEARCH PAPERS
// ============================================

app.get('/api/research', async (req: Request, res: Response) => {
  try {
    const papers = await storage.load<ResearchPaper>('research_papers');
    const query = { ...(req.query as Record<string, unknown>) };

    // author=Robin Carhart-Harris — matches "Carhart-Harris R", "Robin Carhart-Harris", etc.
    let rows: ResearchPaper[] = papers;
    if (typeof query.author === 'string') {
      const wanted = normalizeAuthor(query.author);
      if (wanted.last) rows = rows.filter(p => p.authors.some(a => authorMatches(a.name, wanted)));
      delete query.author;
    }

    // Abstracts dominate payload size; list responses carry a preview unless full=1
    const full = query.full === '1' || query.full === 'true';
    res.json(listResponse('research_papers', rows, query, {
      map: row => {
        const p = row as ResearchPaper;
        return full || !p.abstract || p.abstract.length <= 400
          ? p
          : { ...p, abstract: `${p.abstract.slice(0, 400).trimEnd()}…` };
      }
    }));
  } catch (error) {
    logger.error(`Error fetching research papers: ${error}`);
    res.status(500).json({ error: 'Failed to fetch research papers' });
  }
});

app.get('/api/research/:id', async (req: Request, res: Response) => {
  try {
    const papers = await storage.load<ResearchPaper>('research_papers');
    const paper = papers.find(p => p.id === req.params.id || p.pmid === req.params.id || p.doi === req.params.id);

    if (!paper) {
      return res.status(404).json({ error: 'Research paper not found' });
    }

    res.json(paper);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch research paper' });
  }
});

// ============================================
// COMPANIES
// ============================================

app.get('/api/companies', async (req: Request, res: Response) => {
  try {
    const [companies, people] = await Promise.all([
      storage.load<Company>('companies'),
      storage.load<Person>('people')
    ]);
    res.json(listResponse('companies', companies, req.query as Record<string, unknown>, {
      map: row => {
        const c = row as Company;
        return { ...c, leadership: leadershipFor(c, people) };
      }
    }));
  } catch (error) {
    logger.error(`Error fetching companies: ${error}`);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/companies/:id', async (req: Request, res: Response) => {
  try {
    const [companies, people, trials, jobs, funding] = await Promise.all([
      storage.load<Company>('companies'),
      storage.load<Person>('people'),
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<JobPosting>('jobs'),
      storage.load<FundingEvent>('funding_events')
    ]);
    const wanted = req.params.id.toLowerCase();
    const company = companies.find(c => c.id === req.params.id || c.ticker?.toLowerCase() === wanted);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const nameLc = company.name.toLowerCase();
    res.json({
      ...company,
      leadership: leadershipFor(company, people),
      people: people.filter(p => p.companyIds?.includes(company.id)),
      trials: trials.filter(t => t.sponsor?.toLowerCase().includes(nameLc) || t.collaborators?.some(c => c.toLowerCase().includes(nameLc))).slice(0, 50),
      jobs: jobs.filter(j => j.company.toLowerCase() === nameLc || j.companyId === company.id).slice(0, 50),
      fundingEvents: funding.filter(f => (company.cik && f.cik && f.cik.replace(/^0+/, '') === company.cik.replace(/^0+/, '')) || f.companyName.toLowerCase() === nameLc)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// ============================================
// PEOPLE
// ============================================

app.get('/api/people', async (req: Request, res: Response) => {
  try {
    const people = await storage.load<Person>('people');
    res.json(listResponse('people', people, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching people: ${error}`);
    res.status(500).json({ error: 'Failed to fetch people' });
  }
});

app.get('/api/people/:id', async (req: Request, res: Response) => {
  try {
    const [people, companies] = await Promise.all([
      storage.load<Person>('people'),
      storage.load<Company>('companies')
    ]);
    const person = people.find(p => p.id === req.params.id);

    if (!person) {
      return res.status(404).json({ error: 'Person not found' });
    }

    res.json({
      ...person,
      companies: companies.filter(c => person.companyIds?.includes(c.id)).map(c => ({ id: c.id, name: c.name, ticker: c.ticker, type: c.type, stage: c.stage }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch person' });
  }
});

// ============================================
// JOBS
// ============================================

app.get('/api/jobs', async (req: Request, res: Response) => {
  try {
    const jobs = await storage.load<JobPosting>('jobs');
    res.json(listResponse('jobs', jobs, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching jobs: ${error}`);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

app.get('/api/jobs/:id', async (req: Request, res: Response) => {
  try {
    const jobs = await storage.load<JobPosting>('jobs');
    const job = jobs.find(j => j.id === req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ============================================
// EVENTS
// ============================================

app.get('/api/events', async (req: Request, res: Response) => {
  try {
    const events = await storage.load<Event>('events');
    res.json(listResponse('events', events, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching events: ${error}`);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/events/:id', async (req: Request, res: Response) => {
  try {
    const events = await storage.load<Event>('events');
    const event = events.find(e => e.id === req.params.id);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json(event);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// ============================================
// EDUCATION
// ============================================

app.get('/api/education', async (req: Request, res: Response) => {
  try {
    const courses = await storage.load('educational_resources');
    res.json(listResponse('educational_resources', courses, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching educational resources: ${error}`);
    res.status(500).json({ error: 'Failed to fetch educational resources' });
  }
});

// ============================================
// CARE PROVIDERS
// ============================================

/**
 * Care directory: state-licensed service centers + curated clinics.
 * Query params: type, state, country, substance, search, verified, page, limit
 */
app.get('/api/care', async (req: Request, res: Response) => {
  try {
    const providers = await storage.load<CareProvider>('care_providers');
    res.json(listResponse('care_providers', providers, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching care providers: ${error}`);
    res.status(500).json({ error: 'Failed to fetch care providers' });
  }
});

app.get('/api/care/:id', async (req: Request, res: Response) => {
  try {
    const providers = await storage.load<CareProvider>('care_providers');
    const provider = providers.find(p => p.id === req.params.id);
    if (!provider) return res.status(404).json({ error: 'Care provider not found' });
    res.json(provider);
  } catch (error) {
    logger.error(`Error fetching care provider: ${error}`);
    res.status(500).json({ error: 'Failed to fetch care provider' });
  }
});

// ============================================
// AGGREGATE ENDPOINTS
// ============================================

/**
 * Get all data for dashboard
 */
app.get('/api/dashboard', async (_req: Request, res: Response) => {
  try {
    const [trials, papers, companies, people, jobs, events, education, legislation, funding, grants, care, news, quotes] = await Promise.all([
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<ResearchPaper>('research_papers'),
      storage.load<Company>('companies'),
      storage.load<Person>('people'),
      storage.load<JobPosting>('jobs'),
      storage.load<Event>('events'),
      storage.load('educational_resources'),
      storage.load<LegislationBill>('legislation'),
      storage.load<FundingEvent>('funding_events'),
      storage.load<Grant>('grants'),
      storage.load<CareProvider>('care_providers'),
      storage.load<NewsItem>('news'),
      storage.load<MarketQuote>('market_quotes')
    ]);

    // Get upcoming events
    const now = new Date();
    const upcomingEvents = events
      .filter(e => new Date(e.startDate) >= now)
      .slice(0, 5);

    // Get recent jobs
    const recentJobs = jobs
      .sort((a, b) => {
        const dateA = a.postedDate ? new Date(a.postedDate).getTime() : 0;
        const dateB = b.postedDate ? new Date(b.postedDate).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 10);

    // Get substance statistics (trials and papers per substance)
    const substanceStats: Record<string, number> = {};
    const substancePapers: Record<string, number> = {};
    for (const substance of SUBSTANCES) {
      substanceStats[substance] = trials.filter(t => t.substances.includes(substance)).length;
      substancePapers[substance] = papers.filter(p => p.substances.includes(substance)).length;
    }

    res.json({
      counts: {
        clinicalTrials: trials.length,
        interventionalTrials: trials.filter(t => t.studyType === 'INTERVENTIONAL').length,
        observationalStudies: trials.filter(t => t.studyType === 'OBSERVATIONAL').length,
        trialsWithResults: trials.filter(t => t.hasResults).length,
        researchPapers: papers.length,
        preprints: papers.filter(p => p.publicationType?.includes('Preprint')).length,
        companies: companies.length,
        people: people.length,
        executives: people.filter(p => p.role === 'Executive').length,
        jobs: jobs.length,
        events: events.length,
        educationalResources: education.length,
        legislation: legislation.length,
        fundingEvents: funding.length,
        grants: grants.length,
        careProviders: care.length,
        licensedCareProviders: care.filter(c => c.verified).length,
        news: news.length,
        publicCompaniesQuoted: quotes.length
      },
      latestNews: [...news].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8),
      substancePapers,
      upcomingEvents,
      recentJobs,
      substanceStats,
      featuredCompanies: companies.slice(0, 6).map(c => ({ ...c, leadership: leadershipFor(c, people) })),
      featuredPeople: people.slice(0, 6)
    });
  } catch (error) {
    logger.error(`Error fetching dashboard data: ${error}`);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

/**
 * Search across all data types
 */
app.get('/api/search', async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string || '').toLowerCase();

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const [trials, papers, companies, people, jobs, events, legislation, grants, care, news] = await Promise.all([
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<ResearchPaper>('research_papers'),
      storage.load<Company>('companies'),
      storage.load<Person>('people'),
      storage.load<JobPosting>('jobs'),
      storage.load<Event>('events'),
      storage.load<LegislationBill>('legislation'),
      storage.load<Grant>('grants'),
      storage.load<CareProvider>('care_providers'),
      storage.load<NewsItem>('news')
    ]);

    const results = {
      news: news
        .filter(n => n.title.toLowerCase().includes(query) || n.companies.some(c => c.toLowerCase().includes(query)))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 10),
      legislation: legislation.filter(l =>
        l.title.toLowerCase().includes(query) ||
        l.description?.toLowerCase().includes(query)
      ).slice(0, 10),
      grants: grants.filter(g =>
        g.title.toLowerCase().includes(query) ||
        g.piNames.some(n => n.toLowerCase().includes(query))
      ).slice(0, 10),
      careProviders: care.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.location?.city?.toLowerCase().includes(query)
      ).slice(0, 10),
      clinicalTrials: trials.filter(t =>
        t.title.toLowerCase().includes(query) ||
        t.briefSummary?.toLowerCase().includes(query) ||
        t.nctId.toLowerCase() === query
      ).slice(0, 10),
      researchPapers: papers.filter(p =>
        p.title.toLowerCase().includes(query) ||
        p.abstract?.toLowerCase().includes(query)
      ).slice(0, 10),
      companies: companies.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.description?.toLowerCase().includes(query) ||
        c.ticker?.toLowerCase() === query
      ).slice(0, 10),
      people: people.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.organization?.toLowerCase().includes(query) ||
        p.title?.toLowerCase().includes(query)
      ).slice(0, 10),
      jobs: jobs.filter(j =>
        j.title.toLowerCase().includes(query) ||
        j.company.toLowerCase().includes(query)
      ).slice(0, 10),
      events: events.filter(e =>
        e.title.toLowerCase().includes(query) ||
        e.description?.toLowerCase().includes(query)
      ).slice(0, 10)
    };

    res.json(results);
  } catch (error) {
    logger.error(`Error performing search: ${error}`);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================
// ACCOUNTS, DATASETS, ALERTS, BILLING, ADMIN, SEO PAGES, PUBLIC API DOCS
// ============================================

app.use('/api/auth', authRouter());
app.use('/api/keys', apiKeysRouter());
app.use('/api/saves', savesRouter());
app.use('/api/alerts', alertsRouter());
app.use('/api/billing', billingRouter());
app.use('/api/datasets', datasetsRouter(storage));
app.use('/api/admin', adminRouter(storage));
app.use(publicApiRouter(storage));
app.use(seoRouter(storage));

/**
 * CSV export of any dataset — Pro and Enterprise plans.
 */
app.get('/api/export/:type', requirePlan('pro', 'enterprise'), async (req: AuthedRequest, res: Response) => {
  const type = req.params.type as DataType;
  if (!ALL_DATA_TYPES.includes(type)) {
    return res.status(400).json({ error: `Unknown dataset. Available: ${ALL_DATA_TYPES.join(', ')}` });
  }
  try {
    const rows = await storage.load(type);
    res.type('text/csv')
      .setHeader('Content-Disposition', `attachment; filename="neuly_${type}.csv"`)
      .send(toCsv(rows));
  } catch (error) {
    logger.error(`Error exporting ${type}: ${error}`);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ============================================
// LEGISLATION / FUNDING / GRANTS / READOUTS
// ============================================

/**
 * Legislation & regulatory tracker: state bills + federal register documents.
 * Query params: jurisdiction (state code or US-Federal), substance, search, page, limit
 */
app.get('/api/legislation', async (req: Request, res: Response) => {
  try {
    const bills = await storage.load<LegislationBill>('legislation');
    res.json(listResponse('legislation', bills, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching legislation: ${error}`);
    res.status(500).json({ error: 'Failed to fetch legislation' });
  }
});

app.get('/api/legislation/:id', async (req: Request, res: Response) => {
  try {
    const bills = await storage.load<LegislationBill>('legislation');
    const bill = bills.find(b => b.id === req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    res.json(bill);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bill' });
  }
});

/**
 * Funding events: SEC Form D filings by companies in the space.
 * Query params: search, since (YYYY-MM-DD), page, limit
 */
app.get('/api/funding', async (req: Request, res: Response) => {
  try {
    const events = await storage.load<FundingEvent>('funding_events');
    res.json(listResponse('funding_events', events, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching funding events: ${error}`);
    res.status(500).json({ error: 'Failed to fetch funding events' });
  }
});

app.get('/api/funding/:id', async (req: Request, res: Response) => {
  try {
    const events = await storage.load<FundingEvent>('funding_events');
    const event = events.find(f => f.id === req.params.id || f.accessionNumber === req.params.id);
    if (!event) return res.status(404).json({ error: 'Funding event not found' });
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch funding event' });
  }
});

/**
 * Research grants (NIH RePORTER).
 * Query params: substance, search, fiscalYear, page, limit
 */
app.get('/api/grants', async (req: Request, res: Response) => {
  try {
    const grants = await storage.load<Grant>('grants');
    res.json(listResponse('grants', grants, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching grants: ${error}`);
    res.status(500).json({ error: 'Failed to fetch grants' });
  }
});

app.get('/api/grants/:id', async (req: Request, res: Response) => {
  try {
    const grants = await storage.load<Grant>('grants');
    const grant = grants.find(g => g.id === req.params.id || g.projectNumber === req.params.id);
    if (!grant) return res.status(404).json({ error: 'Grant not found' });
    res.json(grant);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch grant' });
  }
});

/**
 * Trial readout calendar — expected results windows derived from
 * clinical trial completion dates, soonest first.
 * Query params: phase, substance, horizonDays, limit
 */
app.get('/api/readouts', async (req: AuthedRequest, res: Response) => {
  try {
    const trials = await storage.load<ClinicalTrial>('clinical_trials');
    // Free/anonymous users see a 90-day horizon; Pro+ the full calendar
    let readouts = deriveReadoutCalendar(trials, {
      horizonDays: clampReadoutHorizon(req.user?.plan, parseInt(req.query.horizonDays as string) || undefined)
    });

    if (req.query.phase) {
      const phase = (req.query.phase as string).toLowerCase();
      readouts = readouts.filter(r => r.phase?.toLowerCase().includes(phase));
    }
    if (req.query.substance) {
      const substance = (req.query.substance as string).toLowerCase();
      readouts = readouts.filter(r => r.substances.some(s => s.toLowerCase().includes(substance)));
    }

    const limit = parseInt(req.query.limit as string) || 100;
    res.json({ data: readouts.slice(0, limit), total: readouts.length });
  } catch (error) {
    logger.error(`Error deriving readout calendar: ${error}`);
    res.status(500).json({ error: 'Failed to derive readout calendar' });
  }
});

/**
 * Recent change events (diff engine output): what's new, updated, removed.
 * Query params: type (entity type), since (ISO timestamp), limit
 */
app.get('/api/changes', async (req: AuthedRequest, res: Response) => {
  try {
    // Free/anonymous users see the last 7 days; Pro+ the full history
    const events = await storage.loadChangeEvents({
      entityType: req.query.type as string | undefined,
      since: clampChangesSince(req.user?.plan, req.query.since as string | undefined),
      limit: Math.min(parseInt(req.query.limit as string) || 100, 1000)
    });
    res.json({ data: events, total: events.length, cursor: events[0]?.detectedAt });
  } catch (error) {
    logger.error(`Error fetching change events: ${error}`);
    res.status(500).json({ error: 'Failed to fetch change events' });
  }
});

/**
 * Industry news: press coverage + material SEC filings, newest first.
 * Query params: category ('News' | 'SEC Filing'), substance, company, search,
 * since (ISO date), page, limit
 */
app.get('/api/news', async (req: Request, res: Response) => {
  try {
    const items = await storage.load<NewsItem>('news');
    res.json(listResponse('news', items, req.query as Record<string, unknown>));
  } catch (error) {
    logger.error(`Error fetching news: ${error}`);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

/**
 * Market quotes for every publicly traded company tracked, plus an
 * equal-weighted sector move. Query params: sort ('change' | 'ticker')
 */
app.get('/api/markets', async (req: Request, res: Response) => {
  try {
    const quotes = await storage.load<MarketQuote>('market_quotes');
    const sorted = [...quotes].sort((a, b) =>
      req.query.sort === 'ticker'
        ? a.ticker.localeCompare(b.ticker)
        : Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0)
    );
    const withChange = quotes.filter(q => typeof q.changePercent === 'number');
    const sectorChangePercent = withChange.length
      ? Math.round((withChange.reduce((sum, q) => sum + q.changePercent!, 0) / withChange.length) * 100) / 100
      : null;
    const asOf = quotes.reduce<string | undefined>((latest, q) =>
      q.marketTime && (!latest || q.marketTime > latest) ? q.marketTime : latest, undefined);

    res.json({
      data: sorted,
      total: quotes.length,
      summary: {
        sectorChangePercent,
        advancers: withChange.filter(q => q.changePercent! > 0).length,
        decliners: withChange.filter(q => q.changePercent! < 0).length,
        asOf
      }
    });
  } catch (error) {
    logger.error(`Error fetching market quotes: ${error}`);
    res.status(500).json({ error: 'Failed to fetch market quotes' });
  }
});

/**
 * Per-dataset freshness: counts, last successful crawl, last error, cadence.
 */
app.get('/api/freshness', async (_req: Request, res: Response) => {
  try {
    const stats = await storage.getStats();
    res.json({ serverTime: new Date().toISOString(), data: buildFreshness(stats) });
  } catch (error) {
    logger.error(`Error building freshness report: ${error}`);
    res.status(500).json({ error: 'Failed to build freshness report' });
  }
});

/**
 * Live update stream (Server-Sent Events). Emits `hello` with dataset
 * freshness on connect, then `changes` whenever a crawl lands new data.
 */
app.get('/api/live', async (_req: Request, res: Response) => {
  try {
    await liveHub.subscribe(res);
  } catch (error) {
    logger.error(`Error opening live stream: ${error}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to open live stream' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// Catch-all: serve index.html for non-API routes (SPA support)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found', docs: '/docs' });
  }
  const indexPath = join(projectRoot, 'index.html');
  if (existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// Error handler
app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large' });
    return;
  }
  logger.error(`Server error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  logger.info('='.repeat(50));
  logger.info('Neuly API Server');
  logger.info('='.repeat(50));
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info('');
  logger.info('Open http://localhost:' + PORT + ' in your browser');
  logger.info('API docs at http://localhost:' + PORT + '/docs');
  logger.info('');
  logger.info('API endpoints (also under /api/v1):');
  logger.info('  GET /api/dashboard       - Dashboard summary');
  logger.info('  GET /api/clinical-trials - Clinical trials (interventional + observational)');
  logger.info('  GET /api/research        - Research papers');
  logger.info('  GET /api/companies       - Companies (with SEC-sourced leadership)');
  logger.info('  GET /api/people          - People (?company= for executives)');
  logger.info('  GET /api/jobs            - Job postings');
  logger.info('  GET /api/events          - Events');
  logger.info('  GET /api/search?q=       - Global search');
  logger.info('  GET /api/changes         - Recent change events');
  logger.info('  GET /api/legislation     - Bills & regulatory actions');
  logger.info('  GET /api/funding         - SEC Form D funding events');
  logger.info('  GET /api/grants          - NIH research grants');
  logger.info('  GET /api/readouts        - Trial readout calendar');
  logger.info('  GET /api/news            - Industry news + SEC filings');
  logger.info('  GET /api/markets         - Public company stock quotes');
  logger.info('  GET /api/freshness       - Per-dataset crawl freshness');
  logger.info('  GET /api/live            - Live update stream (SSE)');
  logger.info('  GET /api/bulk/:type      - Bulk table download (Enterprise)');
  logger.info('  *   /api/datasets        - User datasets');
  logger.info('  *   /api/admin           - Operator console');
  logger.info(`Storage backend: ${storage.label}`);
  logger.info(`Accounts: ${appDbAvailable() ? 'enabled' : 'disabled (no DATABASE_URL)'}`);
  logger.info('='.repeat(50));
});

export default app;

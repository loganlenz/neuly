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
  EducationalResource,
  Substance,
  SUBSTANCES
} from './models/types.js';
import { deriveReadoutCalendar } from './core/readouts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const storage = await createStorage();

// Middleware. credentials:true + reflected origin lets a statically hosted
// frontend on another domain carry the session cookie to this API.
app.use(cors({ origin: true, credentials: true }));
// Stripe webhook needs the raw bytes for signature verification, so it is
// mounted before the JSON body parser.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json());
app.use(attachUser());

// Serve the frontend (index.html) from the project root
const projectRoot = join(__dirname, '..', '..');
if (existsSync(join(projectRoot, 'index.html'))) {
  app.use(express.static(projectRoot));
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
 * Health check endpoint
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
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

    // Apply filters
    let filtered = trials;

    if (req.query.substance) {
      const substance = req.query.substance as string;
      filtered = filtered.filter(t =>
        t.substances.some(s => s.toLowerCase().includes(substance.toLowerCase()))
      );
    }

    if (req.query.status) {
      const status = req.query.status as string;
      filtered = filtered.filter(t => t.status.toLowerCase() === status.toLowerCase());
    }

    if (req.query.phase) {
      const phase = req.query.phase as string;
      filtered = filtered.filter(t => t.phase?.toLowerCase().includes(phase.toLowerCase()));
    }

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(t =>
        t.title.toLowerCase().includes(search) ||
        t.briefSummary?.toLowerCase().includes(search) ||
        t.conditions.some(c => c.toLowerCase().includes(search))
      );
    }

    // Pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    res.json({
      data: paginated,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching clinical trials: ${error}`);
    res.status(500).json({ error: 'Failed to fetch clinical trials' });
  }
});

app.get('/api/clinical-trials/:id', async (req: Request, res: Response) => {
  try {
    const trials = await storage.load<ClinicalTrial>('clinical_trials');
    const trial = trials.find(t => t.id === req.params.id || t.nctId === req.params.id);

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

    let filtered = papers;

    if (req.query.substance) {
      const substance = req.query.substance as string;
      filtered = filtered.filter(p =>
        p.substances.some(s => s.toLowerCase().includes(substance.toLowerCase()))
      );
    }

    if (req.query.year) {
      const year = parseInt(req.query.year as string);
      filtered = filtered.filter(p => p.year === year);
    }

    // author=Robin Carhart-Harris — matches "Carhart-Harris R", "Robin Carhart-Harris", etc.
    if (req.query.author) {
      const wanted = normalizeAuthor(req.query.author as string);
      if (wanted.last) {
        filtered = filtered.filter(p => p.authors.some(a => authorMatches(a.name, wanted)));
      }
    }

    if (req.query.type === 'preprint') {
      filtered = filtered.filter(p => p.publicationType?.includes('Preprint'));
    } else if (req.query.type === 'peer-reviewed') {
      filtered = filtered.filter(p => !p.publicationType?.includes('Preprint'));
    }

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      const words = search.split(/\s+/).filter(w => w.length > 1);
      filtered = filtered.filter(p => {
        const haystack = `${p.title} ${p.abstract || ''} ${p.journal || ''} ${p.authors.map(a => a.name).join(' ')} ${(p.keywords || []).join(' ')}`.toLowerCase();
        return words.length > 0 ? words.every(w => haystack.includes(w)) : haystack.includes(search);
      });
    }

    // Sort newest first (date, then year)
    filtered.sort((a, b) => (b.publicationDate || `${b.year || 0}`).localeCompare(a.publicationDate || `${a.year || 0}`));

    // Pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const start = (page - 1) * limit;
    // Abstracts dominate payload size; list responses carry a preview unless full=1
    const full = req.query.full === '1' || req.query.full === 'true';
    const paginated = filtered.slice(start, start + limit).map(p =>
      full || !p.abstract || p.abstract.length <= 400
        ? p
        : { ...p, abstract: `${p.abstract.slice(0, 400).trimEnd()}…` }
    );

    res.json({
      data: paginated,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching research papers: ${error}`);
    res.status(500).json({ error: 'Failed to fetch research papers' });
  }
});

app.get('/api/research/:id', async (req: Request, res: Response) => {
  try {
    const papers = await storage.load<ResearchPaper>('research_papers');
    const paper = papers.find(p => p.id === req.params.id || p.pmid === req.params.id);

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
    const companies = await storage.load<Company>('companies');

    let filtered = companies;

    if (req.query.type) {
      const type = req.query.type as string;
      filtered = filtered.filter(c => c.type.toLowerCase() === type.toLowerCase());
    }

    if (req.query.stage) {
      const stage = req.query.stage as string;
      filtered = filtered.filter(c => c.stage.toLowerCase() === stage.toLowerCase());
    }

    if (req.query.substance) {
      const substance = req.query.substance as string;
      filtered = filtered.filter(c =>
        c.substances.some(s => s.toLowerCase().includes(substance.toLowerCase()))
      );
    }

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(search) ||
        c.description?.toLowerCase().includes(search) ||
        c.focus?.toLowerCase().includes(search)
      );
    }

    // Pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    res.json({
      data: paginated,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching companies: ${error}`);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/companies/:id', async (req: Request, res: Response) => {
  try {
    const companies = await storage.load<Company>('companies');
    const company = companies.find(c => c.id === req.params.id || c.ticker === req.params.id);

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(company);
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

    let filtered = people;

    if (req.query.role) {
      const role = req.query.role as string;
      filtered = filtered.filter(p => p.role.toLowerCase() === role.toLowerCase());
    }

    if (req.query.expertise) {
      const expertise = req.query.expertise as string;
      filtered = filtered.filter(p =>
        p.expertise?.some(e => e.toLowerCase().includes(expertise.toLowerCase()))
      );
    }

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.organization?.toLowerCase().includes(search) ||
        p.bio?.toLowerCase().includes(search)
      );
    }

    // Sort by publication count (researchers first)
    filtered.sort((a, b) => (b.publications?.count || 0) - (a.publications?.count || 0));

    // Pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    res.json({
      data: paginated,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching people: ${error}`);
    res.status(500).json({ error: 'Failed to fetch people' });
  }
});

app.get('/api/people/:id', async (req: Request, res: Response) => {
  try {
    const people = await storage.load<Person>('people');
    const person = people.find(p => p.id === req.params.id);

    if (!person) {
      return res.status(404).json({ error: 'Person not found' });
    }

    res.json(person);
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

    let filtered = jobs;

    if (req.query.type) {
      const type = req.query.type as string;
      filtered = filtered.filter(j => j.type.toLowerCase() === type.toLowerCase());
    }

    if (req.query.company) {
      const company = req.query.company as string;
      filtered = filtered.filter(j => j.company.toLowerCase().includes(company.toLowerCase()));
    }

    if (req.query.remote) {
      filtered = filtered.filter(j => j.location?.remote === true);
    }

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(j =>
        j.title.toLowerCase().includes(search) ||
        j.company.toLowerCase().includes(search) ||
        j.description?.toLowerCase().includes(search)
      );
    }

    // Sort by date (newest first)
    filtered.sort((a, b) => {
      const dateA = a.postedDate ? new Date(a.postedDate).getTime() : 0;
      const dateB = b.postedDate ? new Date(b.postedDate).getTime() : 0;
      return dateB - dateA;
    });

    // Pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    res.json({
      data: paginated,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
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

    let filtered = events;

    if (req.query.type) {
      const type = req.query.type as string;
      filtered = filtered.filter(e => e.type.toLowerCase() === type.toLowerCase());
    }

    if (req.query.format) {
      const format = req.query.format as string;
      filtered = filtered.filter(e => e.format.toLowerCase() === format.toLowerCase());
    }

    if (req.query.upcoming === 'true') {
      const now = new Date();
      filtered = filtered.filter(e => new Date(e.startDate) >= now);
    }

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(e =>
        e.title.toLowerCase().includes(search) ||
        e.description?.toLowerCase().includes(search) ||
        e.organizer?.toLowerCase().includes(search)
      );
    }

    // Sort by date (soonest first)
    filtered.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

    // Pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    res.json({
      data: paginated,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
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
    // Curated rows carry a few display fields beyond the schema (level,
    // category, price string); read them loosely.
    type CourseRow = EducationalResource & Record<string, string | undefined>;
    const courses = (await storage.load<EducationalResource>('educational_resources')) as unknown as CourseRow[];
    let filtered = courses;

    if (req.query.level) {
      const level = (req.query.level as string).toLowerCase();
      filtered = filtered.filter(c => c.level?.toLowerCase() === level);
    }
    if (req.query.category) {
      const category = (req.query.category as string).toLowerCase();
      filtered = filtered.filter(c => c.category?.toLowerCase() === category);
    }
    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(c =>
        c.title?.toLowerCase().includes(search) ||
        c.provider?.toLowerCase().includes(search) ||
        c.description?.toLowerCase().includes(search)
      );
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;

    res.json({
      data: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
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
    let filtered = providers;

    if (req.query.type) {
      const type = (req.query.type as string).toLowerCase();
      filtered = filtered.filter(p => p.type.toLowerCase() === type);
    }
    if (req.query.state) {
      const state = (req.query.state as string).toLowerCase();
      filtered = filtered.filter(p => p.location?.state?.toLowerCase() === state);
    }
    if (req.query.country) {
      const country = (req.query.country as string).toLowerCase();
      filtered = filtered.filter(p => p.location?.country?.toLowerCase() === country);
    }
    if (req.query.substance) {
      const substance = (req.query.substance as string).toLowerCase();
      filtered = filtered.filter(p => p.substances.some(s => s.toLowerCase().includes(substance)));
    }
    if (req.query.verified === 'true') {
      filtered = filtered.filter(p => p.verified);
    }
    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.description?.toLowerCase().includes(search) ||
        p.location?.city?.toLowerCase().includes(search) ||
        p.services?.some(s => s.toLowerCase().includes(search))
      );
    }

    // Licensed / verified rows first, then alphabetical
    filtered.sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;

    res.json({
      data: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
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
    const [trials, papers, companies, people, jobs, events, education, legislation, funding, grants, care] = await Promise.all([
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
      storage.load<CareProvider>('care_providers')
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
        researchPapers: papers.length,
        preprints: papers.filter(p => p.publicationType?.includes('Preprint')).length,
        companies: companies.length,
        people: people.length,
        jobs: jobs.length,
        events: events.length,
        educationalResources: education.length,
        legislation: legislation.length,
        fundingEvents: funding.length,
        grants: grants.length,
        careProviders: care.length,
        licensedCareProviders: care.filter(c => c.verified).length
      },
      substancePapers,
      upcomingEvents,
      recentJobs,
      substanceStats,
      featuredCompanies: companies.slice(0, 6),
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

    const [trials, papers, companies, people, jobs, events, legislation, grants, care] = await Promise.all([
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<ResearchPaper>('research_papers'),
      storage.load<Company>('companies'),
      storage.load<Person>('people'),
      storage.load<JobPosting>('jobs'),
      storage.load<Event>('events'),
      storage.load<LegislationBill>('legislation'),
      storage.load<Grant>('grants'),
      storage.load<CareProvider>('care_providers')
    ]);

    const results = {
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
        t.briefSummary?.toLowerCase().includes(query)
      ).slice(0, 10),
      researchPapers: papers.filter(p =>
        p.title.toLowerCase().includes(query) ||
        p.abstract?.toLowerCase().includes(query)
      ).slice(0, 10),
      companies: companies.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.description?.toLowerCase().includes(query)
      ).slice(0, 10),
      people: people.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.organization?.toLowerCase().includes(query)
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
// ACCOUNTS, ALERTS, BILLING, SEO PAGES
// ============================================

app.use('/api/auth', authRouter());
app.use('/api/keys', apiKeysRouter());
app.use('/api/saves', savesRouter());
app.use('/api/alerts', alertsRouter());
app.use('/api/billing', billingRouter());
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
    let filtered = bills;

    if (req.query.jurisdiction) {
      const jurisdiction = (req.query.jurisdiction as string).toLowerCase();
      filtered = filtered.filter(b => b.jurisdiction.toLowerCase() === jurisdiction);
    }
    if (req.query.substance) {
      const substance = (req.query.substance as string).toLowerCase();
      filtered = filtered.filter(b => b.substances.some(s => s.toLowerCase().includes(substance)));
    }
    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(b =>
        b.title.toLowerCase().includes(search) ||
        b.description?.toLowerCase().includes(search) ||
        b.billNumber.toLowerCase().includes(search)
      );
    }

    filtered.sort((a, b) => (b.lastActionDate || '').localeCompare(a.lastActionDate || ''));

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;

    res.json({
      data: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching legislation: ${error}`);
    res.status(500).json({ error: 'Failed to fetch legislation' });
  }
});

/**
 * Funding events: SEC Form D filings by companies in the space.
 * Query params: search, since (YYYY-MM-DD), page, limit
 */
app.get('/api/funding', async (req: Request, res: Response) => {
  try {
    const events = await storage.load<FundingEvent>('funding_events');
    let filtered = events;

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(f => f.companyName.toLowerCase().includes(search));
    }
    if (req.query.since) {
      const since = req.query.since as string;
      filtered = filtered.filter(f => f.filedAt >= since);
    }

    filtered.sort((a, b) => b.filedAt.localeCompare(a.filedAt));

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;

    res.json({
      data: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching funding events: ${error}`);
    res.status(500).json({ error: 'Failed to fetch funding events' });
  }
});

/**
 * Research grants (NIH RePORTER).
 * Query params: substance, search, fiscalYear, page, limit
 */
app.get('/api/grants', async (req: Request, res: Response) => {
  try {
    const grants = await storage.load<Grant>('grants');
    let filtered = grants;

    if (req.query.substance) {
      const substance = (req.query.substance as string).toLowerCase();
      filtered = filtered.filter(g => g.substances.some(s => s.toLowerCase().includes(substance)));
    }
    if (req.query.fiscalYear) {
      const year = parseInt(req.query.fiscalYear as string);
      filtered = filtered.filter(g => g.fiscalYear === year);
    }
    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(g =>
        g.title.toLowerCase().includes(search) ||
        g.organization?.toLowerCase().includes(search) ||
        g.piNames.some(name => name.toLowerCase().includes(search))
      );
    }

    filtered.sort((a, b) => (b.awardAmount || 0) - (a.awardAmount || 0));

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const start = (page - 1) * limit;

    res.json({
      data: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit)
    });
  } catch (error) {
    logger.error(`Error fetching grants: ${error}`);
    res.status(500).json({ error: 'Failed to fetch grants' });
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
      limit: parseInt(req.query.limit as string) || 100
    });
    res.json({ data: events, total: events.length });
  } catch (error) {
    logger.error(`Error fetching change events: ${error}`);
    res.status(500).json({ error: 'Failed to fetch change events' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// Catch-all: serve index.html for non-API routes (SPA support)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  const indexPath = join(projectRoot, 'index.html');
  if (existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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
  logger.info('');
  logger.info('API endpoints:');
  logger.info('  GET /api/dashboard       - Dashboard summary');
  logger.info('  GET /api/clinical-trials - Clinical trials');
  logger.info('  GET /api/research        - Research papers');
  logger.info('  GET /api/companies       - Companies');
  logger.info('  GET /api/people          - People');
  logger.info('  GET /api/jobs            - Job postings');
  logger.info('  GET /api/events          - Events');
  logger.info('  GET /api/search?q=       - Global search');
  logger.info('  GET /api/changes         - Recent change events');
  logger.info('  GET /api/legislation     - Bills & regulatory actions');
  logger.info('  GET /api/funding         - SEC Form D funding events');
  logger.info('  GET /api/grants          - NIH research grants');
  logger.info('  GET /api/readouts        - Trial readout calendar');
  logger.info(`Storage backend: ${storage.label}`);
  logger.info('='.repeat(50));
});

export default app;

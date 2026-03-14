#!/usr/bin/env node
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { DataStorage, DataType } from './utils/storage.js';
import { logger } from './utils/logger.js';
import {
  ClinicalTrial,
  ResearchPaper,
  Company,
  Person,
  JobPosting,
  Event,
  Substance,
  SUBSTANCES
} from './models/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const storage = new DataStorage();

// Middleware
app.use(cors());
app.use(express.json());

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

    if (req.query.search) {
      const search = (req.query.search as string).toLowerCase();
      filtered = filtered.filter(p =>
        p.title.toLowerCase().includes(search) ||
        p.abstract?.toLowerCase().includes(search) ||
        p.authors.some(a => a.name.toLowerCase().includes(search))
      );
    }

    // Sort by year (newest first)
    filtered.sort((a, b) => (b.year || 0) - (a.year || 0));

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
// AGGREGATE ENDPOINTS
// ============================================

/**
 * Get all data for dashboard
 */
app.get('/api/dashboard', async (_req: Request, res: Response) => {
  try {
    const [trials, papers, companies, people, jobs, events] = await Promise.all([
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<ResearchPaper>('research_papers'),
      storage.load<Company>('companies'),
      storage.load<Person>('people'),
      storage.load<JobPosting>('jobs'),
      storage.load<Event>('events')
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

    // Get substance statistics
    const substanceStats: Record<string, number> = {};
    for (const substance of SUBSTANCES) {
      substanceStats[substance] = trials.filter(t => t.substances.includes(substance)).length;
    }

    res.json({
      counts: {
        clinicalTrials: trials.length,
        researchPapers: papers.length,
        companies: companies.length,
        people: people.length,
        jobs: jobs.length,
        events: events.length
      },
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

    const [trials, papers, companies, people, jobs, events] = await Promise.all([
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<ResearchPaper>('research_papers'),
      storage.load<Company>('companies'),
      storage.load<Person>('people'),
      storage.load<JobPosting>('jobs'),
      storage.load<Event>('events')
    ]);

    const results = {
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
  logger.info('='.repeat(50));
});

export default app;

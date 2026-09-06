#!/usr/bin/env node
/**
 * Seed script — first-boot content so the site is never empty.
 *
 * Everything seeded here is either (a) derived from the crawlers' own curated
 * source lists, so ids match what the crawlers write and the first crawl
 * simply enriches the rows in place, or (b) a small curated dataset with no
 * automated source yet (training programs). No invented trials, papers or
 * jobs: those datasets are populated exclusively by crawls of their
 * authoritative sources.
 *
 * Usage: npx tsx src/seed.ts [--if-empty]
 */
import 'dotenv/config';
import { createStorage } from './utils/storageBackend.js';
import { CompanyCrawler } from './crawlers/CompanyCrawler.js';
import { PeopleCrawler } from './crawlers/PeopleCrawler.js';
import { EventCrawler } from './crawlers/EventCrawler.js';
import { CareCrawler } from './crawlers/CareCrawler.js';
import { CompanySchema, PersonSchema } from './models/types.js';
import { logger } from './utils/logger.js';

const storage = await createStorage();
const now = () => new Date().toISOString();

/** Same normalisation as BaseCrawler.generateId */
function entityId(prefix: string, identifier: string): string {
  return `${prefix}_${identifier.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

/** Same normalisation as PeopleCrawler.slugify */
function personId(name: string): string {
  return `per_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}`;
}

// ============================================
// COMPANIES — the crawler's curated list, unenriched (SEC data arrives on
// the first companies crawl, which reuses these ids).
// ============================================
const companies = CompanyCrawler.getKnownCompanies().flatMap(known => {
  const parsed = CompanySchema.safeParse({
    id: entityId('co', known.name),
    name: known.name,
    legalName: known.legalName,
    type: known.type,
    stage: known.stage,
    ticker: known.ticker,
    substances: known.substances,
    focus: known.focus,
    website: known.website,
    source: 'Curated',
    crawledAt: now()
  });
  return parsed.success ? [parsed.data] : [];
});

// ============================================
// PEOPLE — the crawler's curated key figures (publication counts arrive on
// the first people crawl, which reuses these ids).
// ============================================
const people = PeopleCrawler.getKeyFigures().flatMap(figure => {
  if (!figure.name) return [];
  const parsed = PersonSchema.safeParse({
    ...figure,
    id: personId(figure.name),
    source: 'Curated',
    crawledAt: now()
  });
  return parsed.success ? [parsed.data] : [];
});

// ============================================
// EVENTS — recurring conferences projected to their next edition (pure
// computation, no network).
// ============================================
const events = (await new EventCrawler().crawl()).data ?? [];

// ============================================
// CARE PROVIDERS — curated clinics/centers only; licensed rows arrive from
// the care crawler.
// ============================================
const careProviders = (await new CareCrawler({ skipRemote: true }).crawl()).data ?? [];

// ============================================
// EDUCATIONAL RESOURCES (curated)
// Real training programs; refreshed by hand — providers change rarely.
// ============================================
const educationalResources = [
  { id: 'edu_fluence-foundations', provider: 'Fluence', title: 'Psychedelic-Assisted Therapy Foundations', price: '$399', level: 'Beginner', category: 'Therapy', duration: '8 weeks', description: 'Comprehensive introduction to psychedelic-assisted therapy covering psilocybin, MDMA, and ketamine protocols.', url: 'https://www.fluencetraining.com', crawledAt: new Date().toISOString() },
  { id: 'edu_fluence-integration', provider: 'Fluence', title: 'Integration Techniques for Clinicians', price: '$249', level: 'Intermediate', category: 'Therapy', duration: '6 weeks', description: 'Advanced integration methods including somatic, narrative, and mindfulness-based approaches for post-session care.', url: 'https://www.fluencetraining.com', crawledAt: new Date().toISOString() },
  { id: 'edu_maps-mdma', provider: 'MAPS', title: 'MDMA-Assisted Therapy for PTSD', price: '$599', level: 'Advanced', category: 'Therapy', duration: '12 weeks', description: 'Deep dive into the MAPS MDMA therapy protocol, clinical trial methodology, and therapist competencies.', url: 'https://maps.org/education', crawledAt: new Date().toISOString() },
  { id: 'edu_naropa', provider: 'Naropa University', title: 'Psychedelic-Assisted Therapies Certificate', price: '$1,200', level: 'Advanced', category: 'Academic', duration: '16 weeks', description: 'Graduate-level certificate exploring contemplative traditions and psychedelic science for clinical practice.', url: 'https://www.naropa.edu', crawledAt: new Date().toISOString() },
  { id: 'edu_psychedelic-support-kap', provider: 'Psychedelic.Support', title: 'Ketamine-Assisted Psychotherapy', price: '$349', level: 'Intermediate', category: 'Therapy', duration: '6 weeks', description: 'Clinical training in ketamine-assisted psychotherapy including dosing, monitoring, and therapeutic frameworks.', url: 'https://psychedelic.support', crawledAt: new Date().toISOString() },
  { id: 'edu_ciis', provider: 'CIIS', title: 'Certificate in Psychedelic-Assisted Therapies and Research', price: '$899', level: 'Advanced', category: 'Academic', duration: '10 weeks', description: 'Research methodology and clinical training from the California Institute of Integral Studies certificate program.', url: 'https://www.ciis.edu/research-centers/center-for-psychedelic-therapies-and-research', crawledAt: new Date().toISOString() },
  { id: 'edu_ipi', provider: 'Integrative Psychiatry Institute', title: 'Psychedelic-Assisted Therapy Certification', price: '$5,000+', level: 'Advanced', category: 'Therapy', duration: '12 months', description: 'Yearlong certification for licensed clinicians covering ketamine, psilocybin, and MDMA-assisted therapy with experiential practicum.', url: 'https://psychiatryinstitute.com', crawledAt: new Date().toISOString() },
  { id: 'edu_synthesis', provider: 'Synthesis Institute', title: 'Psilocybin Facilitation Practicum', price: '$2,500', level: 'Advanced', category: 'Therapy', duration: '8 weeks', description: 'Hands-on practicum for psilocybin session facilitation including preparation, guiding, and integration.', url: 'https://www.synthesisinstitute.com', crawledAt: new Date().toISOString() },
  { id: 'edu_therapsil', provider: 'TheraPsil', title: 'Psilocybin for End-of-Life Care', price: '$449', level: 'Intermediate', category: 'Therapy', duration: '6 weeks', description: 'Specialized training in psilocybin-assisted therapy for existential distress in palliative care settings.', url: 'https://therapsil.ca', crawledAt: new Date().toISOString() },
  { id: 'edu_zendo', provider: 'Zendo Project', title: 'Psychedelic Peer Support Training', price: '$199', level: 'Beginner', category: 'Safety', duration: '3 weeks', description: 'Training for peer support workers in festival, community, and clinical psychedelic settings.', url: 'https://zendoproject.org', crawledAt: new Date().toISOString() },
  { id: 'edu_dancesafe', provider: 'DanceSafe', title: 'Harm Reduction Fundamentals', price: 'Free', level: 'Beginner', category: 'Safety', duration: '4 weeks', description: 'Evidence-based harm reduction strategies for psychedelic use in community and clinical contexts.', url: 'https://dancesafe.org', crawledAt: new Date().toISOString() },
  { id: 'edu_hopkins-course', provider: 'Johns Hopkins', title: 'Science of Psychedelics', price: 'Free', level: 'Beginner', category: 'Academic', duration: '5 weeks', description: 'Introduction to the modern science of psychedelics from the Center for Psychedelic and Consciousness Research.', url: 'https://hopkinspsychedelic.org', crawledAt: new Date().toISOString() }
];

// ============================================
// SEED
// ============================================
async function seed() {
  // --if-empty: deploy-time guard, checked PER DATASET — a dataset that
  // already has rows (seeded earlier or written by a crawler) is never
  // overwritten, while newly added datasets still get their seed.
  const ifEmpty = process.argv.includes('--if-empty');

  logger.info('='.repeat(50));
  logger.info(`Seeding Neuly database${ifEmpty ? ' (--if-empty: only empty datasets)' : ''}`);
  logger.info('='.repeat(50));

  const datasets: Array<[string, unknown[]]> = [
    ['companies', companies],
    ['people', people],
    ['events', events],
    ['care_providers', careProviders],
    ['educational_resources', educationalResources]
  ];

  for (const [type, rows] of datasets) {
    if (ifEmpty) {
      const existing = await storage.load(type as any);
      if (existing.length > 0) {
        logger.info(`Skipped ${type}: already has ${existing.length} rows`);
        continue;
      }
    }
    await storage.save(type as any, rows as any);
    logger.info(`Saved ${rows.length} ${type}`);
  }

  logger.info('');
  logger.info('='.repeat(50));
  logger.info(`Seed complete! (storage: ${storage.label})`);
  logger.info('Trials, papers, jobs, legislation, funding and grants are populated by crawls only.');
  logger.info('='.repeat(50));

  await storage.close();
}

seed().catch(console.error);

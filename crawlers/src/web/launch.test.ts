import { describe, it, expect } from 'vitest';
import { filterDataset, sortDataset, QUERY_PARAMS_BY_TYPE } from './dataQuery.js';
import { RateLimiter } from './rateLimit.js';
import { PLANS, planFor, publicPlans } from './plans.js';
import { buildOpenApiSpec, versionAlias, listResponse } from './publicApi.js';
import { planFromSubscription, planForPrice } from '../billing/stripe.js';
import { displayNameFromSec, insiderTitle, SecInsidersSource } from '../crawlers/SecInsidersSource.js';
import { PeopleCrawler } from '../crawlers/PeopleCrawler.js';
import { tableForEntityType } from '../datasets/datasets.js';
import { ALL_DATA_TYPES } from '../utils/storage.js';
import type { ClinicalTrial, Company, FundingEvent, Person } from '../models/types.js';
import type { Request, Response } from 'express';

const trial = (overrides: Partial<ClinicalTrial>): ClinicalTrial => ({
  id: `ct_${overrides.nctId?.toLowerCase() ?? 'x'}`, nctId: 'NCT00000000', title: 'A trial', status: 'Recruiting',
  conditions: ['Depression'], interventions: [], substances: ['Psilocybin'],
  url: 'https://clinicaltrials.gov/study/NCT00000000', lastUpdated: '2026-01-01', crawledAt: '2026-01-01', ...overrides
});

describe('filterDataset', () => {
  const trials = [
    trial({ nctId: 'NCT1', phase: 'Phase 3', studyType: 'INTERVENTIONAL', sponsor: 'COMPASS Pathways', sponsorClass: 'INDUSTRY', hasResults: true, lastUpdated: '2026-06-01' }),
    trial({ nctId: 'NCT2', phase: 'Phase 2', studyType: 'OBSERVATIONAL', status: 'Completed', substances: ['MDMA'], sponsor: 'Yale University', lastUpdated: '2025-01-01' }),
    trial({ nctId: 'NCT3', phase: 'Phase 1', studyType: 'INTERVENTIONAL', status: 'Terminated', substances: ['Ketamine'], whyStopped: 'Funding ended', title: 'Ketamine for PTSD' })
  ];

  it('applies trial filters the same way the UI, API and saved queries do', () => {
    expect(filterDataset('clinical_trials', trials, { substance: 'psilocybin' }).map(t => (t as ClinicalTrial).nctId)).toEqual(['NCT1']);
    expect(filterDataset('clinical_trials', trials, { studyType: 'observational' })).toHaveLength(1);
    expect(filterDataset('clinical_trials', trials, { status: 'active' })).toHaveLength(1);
    expect(filterDataset('clinical_trials', trials, { status: 'Terminated' })).toHaveLength(1);
    expect(filterDataset('clinical_trials', trials, { hasResults: 'true' })).toHaveLength(1);
    expect(filterDataset('clinical_trials', trials, { sponsorClass: 'INDUSTRY' })).toHaveLength(1);
    expect(filterDataset('clinical_trials', trials, { since: '2026-01-01' })).toHaveLength(2);
    expect(filterDataset('clinical_trials', trials, { search: 'ketamine ptsd' })).toHaveLength(1);
    expect(filterDataset('clinical_trials', trials, { search: 'NCT2' })).toHaveLength(1);
  });

  it('sorts trials newest-updated first', () => {
    const sorted = sortDataset('clinical_trials', trials) as ClinicalTrial[];
    expect(sorted[0].nctId).toBe('NCT1');
  });

  it('filters people by company link', () => {
    const people: Person[] = [
      { id: 'per_a', name: 'A', role: 'Executive', companyIds: ['co_x'], crawledAt: 'now' },
      { id: 'per_b', name: 'B', role: 'Researcher', organization: 'X Corp', crawledAt: 'now' }
    ];
    expect(filterDataset('people', people, { company: 'co_x' })).toHaveLength(1);
    expect(filterDataset('people', people, { company: 'x corp' })).toHaveLength(1);
    expect(filterDataset('people', people, { role: 'executive' })).toHaveLength(1);
  });

  it('documents every table', () => {
    for (const type of ALL_DATA_TYPES) expect(QUERY_PARAMS_BY_TYPE[type].length).toBeGreaterThan(0);
  });
});

describe('listResponse', () => {
  it('paginates and caps limit', () => {
    const rows = Array.from({ length: 12 }, (_, i) => trial({ nctId: `NCT${i}`, lastUpdated: `2026-01-${String(i + 1).padStart(2, '0')}` }));
    const page = listResponse('clinical_trials', rows, { page: '2', limit: '5' });
    expect(page.total).toBe(12);
    expect(page.data).toHaveLength(5);
    expect(page.totalPages).toBe(3);
    expect(listResponse('clinical_trials', rows, { limit: '99999' }).limit).toBe(5000);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window and resets', () => {
    const limiter = new RateLimiter(60_000);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) expect(limiter.hit('k', 3, t0 + i).allowed).toBe(true);
    const blocked = limiter.hit('k', 3, t0 + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(limiter.hit('k', 3, t0 + 60_000).allowed).toBe(true);
    expect(limiter.hit('other', 3, t0).allowed).toBe(true);
  });
});

describe('plans', () => {
  it('defines escalating quotas and keeps the API paid', () => {
    expect(PLANS.free.apiDailyQuota).toBe(0);
    expect(PLANS.pro.apiDailyQuota).toBeGreaterThan(0);
    expect(PLANS.enterprise.apiDailyQuota).toBeGreaterThan(PLANS.pro.apiDailyQuota);
    expect(PLANS.enterprise.bulkDownloads).toBe(true);
    expect(PLANS.pro.bulkDownloads).toBe(false);
    expect(planFor(undefined).id).toBe('free');
    expect(publicPlans().map(p => p.id)).toEqual(['free', 'pro', 'enterprise']);
  });
});

describe('public API', () => {
  it('rewrites /api/v1 to /api', () => {
    const mw = versionAlias();
    const req = { url: '/api/v1/clinical-trials?limit=2' } as Request;
    mw(req, {} as Response, () => undefined);
    expect(req.url).toBe('/api/clinical-trials?limit=2');
    const plain = { url: '/api/people' } as Request;
    mw(plain, {} as Response, () => undefined);
    expect(plain.url).toBe('/api/people');
  });

  it('builds an OpenAPI spec covering every table, bulk and sync endpoints', () => {
    const spec = buildOpenApiSpec() as { paths: Record<string, unknown>; info: { version: string } };
    expect(spec.paths['/v1/clinical-trials']).toBeDefined();
    expect(spec.paths['/v1/bulk/research_papers']).toBeDefined();
    expect(spec.paths['/v1/changes']).toBeDefined();
    expect(spec.paths['/v1/datasets/{id}/queries']).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
  });
});

describe('stripe plan mapping', () => {
  const env = { STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_ENTERPRISE: 'price_ent' } as NodeJS.ProcessEnv;

  it('maps price ids and subscription status to a plan', () => {
    expect(planForPrice('price_pro', env)).toBe('pro');
    expect(planForPrice('nope', env)).toBeUndefined();
    expect(planFromSubscription({ status: 'active', items: { data: [{ price: { id: 'price_ent' } }] } }, env)).toEqual({ plan: 'enterprise', status: 'active' });
    expect(planFromSubscription({ status: 'past_due', items: { data: [{ price: { id: 'price_pro' } }] } }, env).plan).toBe('pro');
    expect(planFromSubscription({ status: 'canceled', items: { data: [{ price: { id: 'price_pro' } }] } }, env).plan).toBe('free');
    expect(planFromSubscription({ status: 'active', metadata: { plan: 'pro' } }, env).plan).toBe('pro');
    expect(planFromSubscription({ status: 'active' }, env).plan).toBe('free');
  });
});

describe('SEC insiders', () => {
  it('turns SEC "LAST FIRST" names into display names', () => {
    expect(displayNameFromSec('Nath Kabir')).toBe('Kabir Nath');
    expect(displayNameFromSec('SMITH JOHN A')).toBe('John A Smith');
    expect(displayNameFromSec('Doe, Jane')).toBe('Jane Doe');
    expect(displayNameFromSec('MCDONALD RONALD')).toBe('Ronald McDonald');
  });

  it('labels insiders by relationship', () => {
    expect(insiderTitle({ isOfficer: true, isDirector: true, isTenPercentOwner: false, officerTitle: 'Chief Executive Officer' })).toBe('Chief Executive Officer & Director');
    expect(insiderTitle({ isOfficer: false, isDirector: true, isTenPercentOwner: false })).toBe('Board Director');
    expect(insiderTitle({ isOfficer: false, isDirector: false, isTenPercentOwner: true })).toBe('10% Owner');
  });

  const form4 = `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-08-03</periodOfReport>
  <issuer><issuerCik>0001816590</issuerCik><issuerName>COMPASS Pathways plc</issuerName></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001940258</rptOwnerCik><rptOwnerName>Nath Kabir</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001234567</rptOwnerCik><rptOwnerName>BIG FUND LP</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship>
  </reportingOwner>
</ownershipDocument>`;

  it('parses ownership XML and drops fund vehicles', () => {
    const source = new SecInsidersSource();
    const insiders = source.parseOwnership(form4, '4', '0001940258-26-000011', '2026-08-05');
    expect(insiders).toHaveLength(1);
    expect(insiders[0]).toMatchObject({ name: 'Kabir Nath', isOfficer: true, isDirector: true, officerTitle: 'Chief Executive Officer', asOf: '2026-08-03', issuerName: 'COMPASS Pathways plc' });
  });

  it('links executives to companies through the People crawler', async () => {
    const company: Company = { id: 'co_compass-pathways', name: 'COMPASS Pathways', type: 'Biotech', stage: 'Public', substances: ['Psilocybin'], cik: '0001816590', crawledAt: 'now' };
    const privateCo: Company = { id: 'co_psilera', name: 'Psilera Inc.', type: 'Biotech', stage: 'Private', substances: ['Psilocybin'], crawledAt: 'now' };
    const filing: FundingEvent = {
      id: 'fund_1', companyName: 'PSILERA INC.', formType: 'D', filedAt: '2026-03-01', accessionNumber: '0001-26-1', url: 'https://sec.gov/x', source: 'SEC', crawledAt: 'now',
      relatedPersons: [{ name: 'JANE ROE', roles: ['Executive Officer', 'Director', 'CEO'] }]
    };
    const source = new SecInsidersSource();
    source.fetchInsiders = async () => source.parseOwnership(form4, '4', 'acc', '2026-08-05');

    const crawler = new PeopleCrawler({ skipPubMed: true, companies: [company, privateCo], fundingEvents: [filing], insidersSource: source });
    const result = await crawler.crawl();
    const people = result.data!;

    // Curated Kabir Nath gains the SEC link rather than being duplicated
    const nath = people.filter(p => /kabir nath/i.test(p.name));
    expect(nath).toHaveLength(1);
    expect(nath[0].companyIds).toEqual(['co_compass-pathways']);
    expect(nath[0].affiliations?.some(a => a.source === 'SEC Form 4' && a.companyId === 'co_compass-pathways')).toBe(true);

    // Form D related person becomes a title-cased executive of the private company
    const roe = people.find(p => p.name === 'Jane Roe');
    expect(roe).toBeDefined();
    expect(roe!.role).toBe('Executive');
    expect(roe!.title).toBe('CEO');
    expect(roe!.companyIds).toEqual(['co_psilera']);
    expect(roe!.source).toBe('SEC Form D');
  });
});

describe('datasets', () => {
  it('maps UI entity aliases to tables', () => {
    expect(tableForEntityType('trial')).toBe('clinical_trials');
    expect(tableForEntityType('company')).toBe('companies');
    expect(tableForEntityType('people')).toBe('people');
    expect(tableForEntityType('nonsense')).toBeUndefined();
  });
});

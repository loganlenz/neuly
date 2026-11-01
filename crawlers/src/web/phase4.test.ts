import { describe, it, expect } from 'vitest';
import { maskLead, defaultLeadPriceCents, CLAIMABLE_TYPES } from '../marketplace/marketplace.js';
import { entityPath } from './seoPages.js';
import { TeamPageSource } from '../crawlers/TeamPageSource.js';
import { descriptionFits, commonsThumbnailUrl } from '../enrichment/HeadshotEnricher.js';
import { CompanyCrawler } from '../crawlers/CompanyCrawler.js';
import type { Grant, NewsItem, ClinicalTrial } from '../models/types.js';

describe('marketplace', () => {
  it('masks a lead down to initials, email domain and a message preview', () => {
    const masked = maskLead({
      contact: { name: 'Jane Q Doe', email: 'jane@example.org', phone: '+1 555 0100', location: 'Denver, CO' },
      details: { condition: 'Treatment-resistant depression', message: 'I have tried four antidepressants and would like to discuss ketamine-assisted therapy options.' }
    });
    expect(masked.contact.name).toBe('J. Q. D.');
    expect(masked.contact.emailDomain).toBe('example.org');
    expect(masked.contact.phone).toBe('•••-•••-••••');
    expect(masked.contact.location).toBe('Denver, CO');
    expect(masked.details.condition).toBe('Treatment-resistant depression');
    expect(String(masked.details.messagePreview)).toMatch(/…$/);
    expect(masked.contact).not.toHaveProperty('email');
  });

  it('prices leads per listing type with env overrides', () => {
    expect(defaultLeadPriceCents('care_providers')).toBe(CLAIMABLE_TYPES.care_providers.defaultCents);
    expect(defaultLeadPriceCents('clinical_trials')).toBe(CLAIMABLE_TYPES.clinical_trials.defaultCents);
    process.env.LEAD_PRICE_CARE_CENTS = '2500';
    expect(defaultLeadPriceCents('care_providers')).toBe(2500);
    delete process.env.LEAD_PRICE_CARE_CENTS;
  });
});

describe('entity pages', () => {
  it('gives every entity type its own Neuly URL', () => {
    expect(entityPath('clinical_trials', { id: 'ct_x', nctId: 'NCT01234567' })).toBe('/trials/NCT01234567');
    expect(entityPath('companies', { id: 'co_x', name: 'COMPASS Pathways' })).toBe('/company-profiles/compass-pathways');
    expect(entityPath('news', { id: 'news_abc' })).toBe('/news/news_abc');
    expect(entityPath('legislation', { id: 'leg_co_sb303' })).toBe('/bills/leg_co_sb303');
    expect(entityPath('funding_events', { id: 'fund_1' })).toBe('/funding/fund_1');
    expect(entityPath('grants', { id: 'grant_1' })).toBe('/grants/grant_1');
    expect(entityPath('research_papers', { id: 'pm_1' })).toBe('/papers/pm_1');
    expect(entityPath('people', { id: 'per_kabir-nath' })).toBe('/people/per_kabir-nath');
    expect(entityPath('care_providers', { id: 'care_x' })).toBe('/care/care_x');
    expect(entityPath('jobs', { id: 'job_1' })).toBe('/jobs/job_1');
    expect(entityPath('events', { id: 'evt_1' })).toBe('/events/evt_1');
  });
});

describe('TeamPageSource', () => {
  const html = `<html><body>
    <nav><a href="/team">Team</a><a href="/about">About</a></nav>
    <section class="leadership">
      <div class="member"><img src="/img/jane.jpg"><h3>Dr. Jane Doe</h3><p>Chief Executive Officer</p><p>Jane founded the company in 2019.</p></div>
      <div class="member"><img data-src="https://cdn.example.com/john.png"><h3>John A. Smith</h3><p>Chief Scientific Officer &amp; Co-Founder</p></div>
      <div class="member"><h3>Research Team</h3><p>Our scientists</p></div>
      <div class="member"><h3>Maria Garcia</h3><p>Read more</p></div>
    </section>
    <h2>Latest news</h2><p>Jane Doe will speak at the conference.</p>
  </body></html>`;

  it('finds the team page from navigation', () => {
    const source = new TeamPageSource();
    const candidates = source.teamPageCandidates(html, 'https://example.com/');
    expect(candidates[0]).toBe('https://example.com/team');
    expect(candidates).toContain('https://example.com/about');
  });

  it('extracts name, title and headshot per card and skips non-people', () => {
    const source = new TeamPageSource();
    const team = source.extractTeam(html, 'https://example.com/team');
    expect(team.map(m => m.name)).toEqual(['Jane Doe', 'John A. Smith']);
    expect(team[0]).toMatchObject({ title: 'Chief Executive Officer', imageUrl: 'https://example.com/img/jane.jpg' });
    expect(team[1]).toMatchObject({ title: 'Chief Scientific Officer & Co-Founder', imageUrl: 'https://cdn.example.com/john.png' });
  });
});

describe('HeadshotEnricher', () => {
  it('only accepts Wikidata matches whose description fits the role', () => {
    expect(descriptionFits({ role: 'Researcher', organization: 'Imperial College London' }, 'British neuropsychopharmacologist')).toBe(true);
    expect(descriptionFits({ role: 'Executive', organization: 'COMPASS Pathways' }, 'American businessperson')).toBe(true);
    expect(descriptionFits({ role: 'Researcher' }, 'English footballer')).toBe(false);
    expect(descriptionFits({ role: 'Advocate', organization: 'MAPS' }, 'psychedelic researcher and activist')).toBe(true);
    expect(descriptionFits({ role: 'Executive' }, undefined)).toBe(false);
  });

  it('builds Commons thumbnail urls', () => {
    expect(commonsThumbnailUrl('Rick Doblin - MAPS.png')).toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Rick_Doblin_-_MAPS.png?width=480');
  });
});

describe('CompanyCrawler discovery sources', () => {
  const trial = (overrides: Partial<ClinicalTrial>): ClinicalTrial => ({
    id: 'ct_x', nctId: 'NCT00000001', title: 't', status: 'Recruiting', conditions: ['Depression'],
    interventions: [], substances: ['Psilocybin'], url: 'https://clinicaltrials.gov/study/NCT00000001',
    lastUpdated: '2026-01-01', crawledAt: '2026-01-01', ...overrides
  });
  const news = (title: string, substances: NewsItem['substances'] = ['Psilocybin']): NewsItem => ({
    id: `n_${title.slice(0, 10)}`, title, url: 'https://example.com/a', publishedAt: '2026-06-01T00:00:00Z', category: 'News', substances, companies: [], source: 'Google News', crawledAt: 'x'
  });
  const grant = (org: string): Grant => ({ id: `g_${org}`, projectNumber: 'R43MH000001', title: 'Psilocybin analog for depression', piNames: ['Doe, Jane'], organization: org, agency: 'NIMH', fiscalYear: 2026, awardAmount: 250000, substances: ['Psilocybin'], source: 'NIH RePORTER', crawledAt: 'x' });

  it('adds collaborators, NIH awardee companies and repeatedly covered companies with evidence', async () => {
    const crawler = new CompanyCrawler({
      skipDiscovery: true,
      trials: [trial({ collaborators: ['Novel Neuro Therapeutics Inc.', 'Yale University'] })],
      grants: [grant('Psilera Inc.'), grant('University of Wisconsin')],
      news: [news('Mindstate Therapeutics raises $20M'), news('Mindstate Therapeutics names CFO'), news('Mindstate Therapeutics doses first patient'), news('Lonely Biosciences appears once')]
    });
    (crawler as unknown as { request: () => Promise<never> }).request = async () => { throw new Error('offline'); };
    const result = await crawler.crawl();
    const names = result.data!.map(c => c.name);
    expect(names).toContain('Novel Neuro Therapeutics Inc.');
    expect(names).toContain('Psilera');
    expect(names).toContain('Mindstate Therapeutics');
    expect(names).not.toContain('Yale University');
    expect(names).not.toContain('University of Wisconsin');
    expect(names).not.toContain('Lonely Biosciences');
    expect(result.data!.find(c => c.name === 'Mindstate Therapeutics')!.source).toBe('News coverage');
    expect(result.data!.find(c => c.name === 'Novel Neuro Therapeutics Inc.')!.evidence).toEqual(['Collaborator on NCT00000001']);
  });
});

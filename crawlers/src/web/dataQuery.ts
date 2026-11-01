import { DataType } from '../utils/storage.js';
import {
  CrawledData, ClinicalTrial, ResearchPaper, Company, Person, JobPosting, Event,
  LegislationBill, FundingEvent, Grant, CareProvider, NewsItem, MarketQuote, EducationalResource
} from '../models/types.js';

export type QueryParams = Record<string, string>;

/**
 * Shared filter semantics for every table. The REST list endpoints, the
 * public API and saved dataset queries all run through here, so a filter
 * that works in the UI also works as `?param=` on the API and as a saved
 * query — one definition, three surfaces.
 */
const lc = (v: string | undefined | null) => (v ?? '').toLowerCase();
const has = (list: string[] | undefined, needle: string) => (list ?? []).some(s => lc(s).includes(needle));
const words = (search: string) => search.toLowerCase().split(/\s+/).filter(w => w.length > 1);
const matchesAll = (haystack: string, search: string) => {
  const ws = words(search);
  const h = haystack.toLowerCase();
  return ws.length > 0 ? ws.every(w => h.includes(w)) : h.includes(search.toLowerCase());
};

function sinceOk(value: string | undefined, since: string | undefined): boolean {
  return !since || (value ?? '') >= since;
}

export function filterDataset(type: DataType, rows: CrawledData[], params: QueryParams): CrawledData[] {
  const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const substance = lc(p.substance);
  const search = p.search || p.q;

  switch (type) {
    case 'clinical_trials':
      return (rows as ClinicalTrial[]).filter(t =>
        (!substance || has(t.substances, substance)) &&
        (!p.status || lc(t.status) === lc(p.status) || (lc(p.status) === 'active' && /recruit|active|enrolling/i.test(t.status))) &&
        (!p.phase || lc(t.phase).includes(lc(p.phase))) &&
        (!p.studyType || lc(t.studyType).includes(lc(p.studyType))) &&
        (!p.sponsor || lc(t.sponsor).includes(lc(p.sponsor))) &&
        (!p.sponsorClass || lc(t.sponsorClass) === lc(p.sponsorClass)) &&
        (!p.condition || has(t.conditions, lc(p.condition))) &&
        (!p.country || (t.locations ?? []).some(l => lc(l.country).includes(lc(p.country)))) &&
        (p.hasResults === undefined || String(Boolean(t.hasResults)) === lc(p.hasResults)) &&
        sinceOk(t.lastUpdated, p.since) &&
        (!search || matchesAll(`${t.title} ${t.briefSummary ?? ''} ${t.conditions.join(' ')} ${t.sponsor ?? ''} ${t.nctId}`, search))
      );

    case 'research_papers':
      return (rows as ResearchPaper[]).filter(r =>
        (!substance || has(r.substances, substance)) &&
        (!p.year || r.year === parseInt(p.year)) &&
        (!p.journal || lc(r.journal).includes(lc(p.journal))) &&
        (!p.type || (p.type === 'preprint' ? Boolean(r.publicationType?.includes('Preprint')) : p.type === 'peer-reviewed' ? !r.publicationType?.includes('Preprint') : has(r.publicationType, lc(p.type)))) &&
        (!p.author || r.authors.some(a => lc(a.name).includes(lc(p.author)))) &&
        (p.openAccess === undefined || String(Boolean(r.isOpenAccess)) === lc(p.openAccess)) &&
        sinceOk(r.publicationDate, p.since) &&
        (!search || matchesAll(`${r.title} ${r.abstract ?? ''} ${r.journal ?? ''} ${r.authors.map(a => a.name).join(' ')} ${(r.keywords ?? []).join(' ')}`, search))
      );

    case 'companies':
      return (rows as Company[]).filter(c =>
        (!substance || has(c.substances, substance)) &&
        (!p.type || lc(c.type) === lc(p.type)) &&
        (!p.stage || lc(c.stage) === lc(p.stage)) &&
        (!p.country || lc(c.headquarters?.country).includes(lc(p.country))) &&
        (!p.ticker || lc(c.ticker) === lc(p.ticker)) &&
        (p.public === undefined || String(c.stage === 'Public') === lc(p.public)) &&
        (!search || matchesAll(`${c.name} ${c.legalName ?? ''} ${c.description ?? ''} ${c.focus ?? ''} ${c.ticker ?? ''}`, search))
      );

    case 'people':
      return (rows as Person[]).filter(x =>
        (!p.role || lc(x.role) === lc(p.role)) &&
        (!p.expertise || has(x.expertise, lc(p.expertise))) &&
        (!substance || has(x.expertise, substance)) &&
        (!p.organization || lc(x.organization).includes(lc(p.organization)) || (x.affiliations ?? []).some(a => lc(a.organization).includes(lc(p.organization)))) &&
        (!p.company || (x.companyIds ?? []).includes(p.company) || lc(x.organization).includes(lc(p.company)) || (x.affiliations ?? []).some(a => lc(a.organization).includes(lc(p.company)))) &&
        (!search || matchesAll(`${x.name} ${x.organization ?? ''} ${x.title ?? ''} ${x.bio ?? ''} ${(x.researchAreas ?? []).join(' ')}`, search))
      );

    case 'jobs':
      return (rows as JobPosting[]).filter(j =>
        (!p.type || lc(j.type) === lc(p.type)) &&
        (!p.company || lc(j.company).includes(lc(p.company))) &&
        (!p.remote || j.location?.remote === true) &&
        (!p.country || lc(j.location?.country).includes(lc(p.country))) &&
        sinceOk(j.postedDate, p.since) &&
        (!search || matchesAll(`${j.title} ${j.company} ${j.description ?? ''}`, search))
      );

    case 'events':
      return (rows as Event[]).filter(e =>
        (!p.type || lc(e.type) === lc(p.type)) &&
        (!p.format || lc(e.format) === lc(p.format)) &&
        (p.upcoming !== 'true' || new Date(e.startDate) >= new Date()) &&
        (!search || matchesAll(`${e.title} ${e.description ?? ''} ${e.organizer ?? ''}`, search))
      );

    case 'educational_resources':
      return (rows as Array<EducationalResource & Record<string, string | undefined>>).filter(c =>
        (!p.level || lc(c.level) === lc(p.level)) &&
        (!p.category || lc(c.category) === lc(p.category)) &&
        (!p.provider || lc(c.provider).includes(lc(p.provider))) &&
        (!search || matchesAll(`${c.title} ${c.provider} ${c.description ?? ''}`, search))
      );

    case 'legislation':
      return (rows as LegislationBill[]).filter(b =>
        (!p.jurisdiction || lc(b.jurisdiction) === lc(p.jurisdiction)) &&
        (!substance || has(b.substances, substance)) &&
        (!p.status || lc(b.status).includes(lc(p.status))) &&
        sinceOk(b.lastActionDate, p.since) &&
        (!search || matchesAll(`${b.title} ${b.description ?? ''} ${b.billNumber}`, search))
      );

    case 'funding_events':
      return (rows as FundingEvent[]).filter(f =>
        (!substance || has(f.substances, substance)) &&
        (!p.formType || lc(f.formType) === lc(p.formType)) &&
        (!p.minAmount || (f.totalAmountSold ?? f.totalOfferingAmount ?? 0) >= Number(p.minAmount)) &&
        sinceOk(f.filedAt, p.since) &&
        (!search || matchesAll(`${f.companyName} ${f.industryGroup ?? ''} ${(f.relatedPersons ?? []).map(r => r.name).join(' ')}`, search))
      );

    case 'grants':
      return (rows as Grant[]).filter(g =>
        (!substance || has(g.substances, substance)) &&
        (!p.fiscalYear || g.fiscalYear === parseInt(p.fiscalYear)) &&
        (!p.agency || lc(g.agency).includes(lc(p.agency))) &&
        (!p.organization || lc(g.organization).includes(lc(p.organization))) &&
        (!search || matchesAll(`${g.title} ${g.organization ?? ''} ${g.piNames.join(' ')} ${g.abstract ?? ''}`, search))
      );

    case 'care_providers':
      return (rows as CareProvider[]).filter(c =>
        (!p.type || lc(c.type) === lc(p.type)) &&
        (!p.state || lc(c.location?.state) === lc(p.state)) &&
        (!p.country || lc(c.location?.country) === lc(p.country)) &&
        (!substance || has(c.substances, substance)) &&
        (p.verified !== 'true' || c.verified) &&
        (!search || matchesAll(`${c.name} ${c.description ?? ''} ${c.location?.city ?? ''} ${(c.services ?? []).join(' ')}`, search))
      );

    case 'news':
      return (rows as NewsItem[]).filter(n =>
        (!p.category || lc(n.category) === lc(p.category)) &&
        (!substance || (n.substances ?? []).some(s => lc(s) === substance)) &&
        (!p.company || has(n.companies, lc(p.company))) &&
        sinceOk(n.publishedAt, p.since) &&
        (!search || matchesAll(`${n.title} ${n.publisher ?? ''} ${n.companies.join(' ')} ${n.summary ?? ''}`, search))
      );

    case 'market_quotes':
      return (rows as MarketQuote[]).filter(q =>
        (!p.ticker || lc(q.ticker) === lc(p.ticker)) &&
        (!p.company || lc(q.companyName).includes(lc(p.company)) || q.companyId === p.company) &&
        (!search || matchesAll(`${q.ticker} ${q.companyName}`, search))
      );

    default:
      return rows;
  }
}

/** Default sort per table: newest / most relevant first */
export function sortDataset(type: DataType, rows: CrawledData[]): CrawledData[] {
  const by = <T>(fn: (a: T, b: T) => number) => [...(rows as T[])].sort(fn) as CrawledData[];
  switch (type) {
    case 'clinical_trials': return by<ClinicalTrial>((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''));
    case 'research_papers': return by<ResearchPaper>((a, b) => (b.publicationDate || `${b.year || 0}`).localeCompare(a.publicationDate || `${a.year || 0}`));
    case 'people': return by<Person>((a, b) => (b.publications?.count || 0) - (a.publications?.count || 0));
    case 'jobs': return by<JobPosting>((a, b) => (b.postedDate ?? '').localeCompare(a.postedDate ?? ''));
    case 'events': return by<Event>((a, b) => a.startDate.localeCompare(b.startDate));
    case 'legislation': return by<LegislationBill>((a, b) => (b.lastActionDate ?? '').localeCompare(a.lastActionDate ?? ''));
    case 'funding_events': return by<FundingEvent>((a, b) => b.filedAt.localeCompare(a.filedAt));
    case 'grants': return by<Grant>((a, b) => (b.awardAmount ?? 0) - (a.awardAmount ?? 0));
    case 'care_providers': return by<CareProvider>((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));
    case 'news': return by<NewsItem>((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    case 'market_quotes': return by<MarketQuote>((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0));
    default: return rows;
  }
}

/** Query parameters each table accepts — drives the OpenAPI spec and docs */
export const QUERY_PARAMS_BY_TYPE: Record<DataType, Array<{ name: string; description: string }>> = {
  clinical_trials: [
    { name: 'substance', description: 'Tracked substance, e.g. Psilocybin, MDMA, Ketamine' },
    { name: 'status', description: 'Recruiting, Completed, Terminated, … or "active" for any recruiting/active status' },
    { name: 'phase', description: 'Phase 1, Phase 2, Phase 3, Phase 1/2, …' },
    { name: 'studyType', description: 'INTERVENTIONAL, OBSERVATIONAL or EXPANDED_ACCESS' },
    { name: 'sponsor', description: 'Lead sponsor name (substring)' },
    { name: 'sponsorClass', description: 'INDUSTRY, NIH, OTHER, …' },
    { name: 'condition', description: 'Condition (substring)' },
    { name: 'country', description: 'Site country (substring)' },
    { name: 'hasResults', description: 'true / false — results posted on ClinicalTrials.gov' },
    { name: 'since', description: 'Only records updated on/after this date (YYYY-MM-DD)' },
    { name: 'search', description: 'Full-text search over title, summary, conditions, sponsor, NCT id' }
  ],
  research_papers: [
    { name: 'substance', description: 'Tracked substance' },
    { name: 'year', description: 'Publication year' },
    { name: 'journal', description: 'Journal name (substring)' },
    { name: 'type', description: 'preprint, peer-reviewed, or a publication type such as "Observational Study", "Randomized Controlled Trial", "Review"' },
    { name: 'author', description: 'Author name (substring)' },
    { name: 'openAccess', description: 'true / false' },
    { name: 'since', description: 'Published on/after this date' },
    { name: 'search', description: 'Full-text search' }
  ],
  companies: [
    { name: 'substance', description: 'Tracked substance' },
    { name: 'type', description: 'Biotech, Pharma, Healthcare, Non-Profit, Research, Technology, Other' },
    { name: 'stage', description: 'Public, Private, Seed, Series A, …' },
    { name: 'country', description: 'Headquarters country' },
    { name: 'ticker', description: 'Stock ticker' },
    { name: 'public', description: 'true / false' },
    { name: 'search', description: 'Full-text search' }
  ],
  people: [
    { name: 'role', description: 'Researcher, Executive, Clinician, Investor, Advocate, Educator, Other' },
    { name: 'expertise', description: 'Substance expertise' },
    { name: 'organization', description: 'Organisation / affiliation (substring)' },
    { name: 'company', description: 'Company id (co_…) or name — people linked to that company' },
    { name: 'search', description: 'Full-text search' }
  ],
  jobs: [
    { name: 'type', description: 'Research, Clinical, Engineering, Policy, Marketing, Business, Operations, Other' },
    { name: 'company', description: 'Company name (substring)' },
    { name: 'remote', description: 'true — remote roles only' },
    { name: 'country', description: 'Country (substring)' },
    { name: 'since', description: 'Posted on/after this date' },
    { name: 'search', description: 'Full-text search' }
  ],
  events: [
    { name: 'type', description: 'Conference, Webinar, Workshop, Summit, Meetup, Symposium, Course, Other' },
    { name: 'format', description: 'In-Person, Virtual, Hybrid' },
    { name: 'upcoming', description: 'true — future events only' },
    { name: 'search', description: 'Full-text search' }
  ],
  educational_resources: [
    { name: 'level', description: 'Beginner, Intermediate, Advanced' },
    { name: 'category', description: 'Therapy, Academic, Safety, …' },
    { name: 'provider', description: 'Provider (substring)' },
    { name: 'search', description: 'Full-text search' }
  ],
  legislation: [
    { name: 'jurisdiction', description: 'Two-letter state code or US-Federal' },
    { name: 'substance', description: 'Tracked substance' },
    { name: 'status', description: 'Status / document type (substring)' },
    { name: 'since', description: 'Last action on/after this date' },
    { name: 'search', description: 'Full-text search' }
  ],
  funding_events: [
    { name: 'substance', description: 'Tracked substance' },
    { name: 'formType', description: 'D or D/A' },
    { name: 'minAmount', description: 'Minimum amount sold/offered (USD)' },
    { name: 'since', description: 'Filed on/after this date' },
    { name: 'search', description: 'Company or related person (substring)' }
  ],
  grants: [
    { name: 'substance', description: 'Tracked substance' },
    { name: 'fiscalYear', description: 'NIH fiscal year' },
    { name: 'agency', description: 'Funding agency (substring)' },
    { name: 'organization', description: 'Awardee organisation (substring)' },
    { name: 'search', description: 'Full-text search' }
  ],
  care_providers: [
    { name: 'type', description: 'Clinic, Service Center, Telehealth, Retreat, Healing Center, Research Center, Other' },
    { name: 'state', description: 'Two-letter state code' },
    { name: 'country', description: 'Country' },
    { name: 'substance', description: 'Tracked substance' },
    { name: 'verified', description: 'true — regulator-verified rows only' },
    { name: 'search', description: 'Full-text search' }
  ],
  news: [
    { name: 'category', description: 'News or "SEC Filing"' },
    { name: 'substance', description: 'Tracked substance' },
    { name: 'company', description: 'Tracked company named in the item' },
    { name: 'since', description: 'Published on/after this ISO timestamp' },
    { name: 'search', description: 'Full-text search' }
  ],
  market_quotes: [
    { name: 'ticker', description: 'Stock ticker' },
    { name: 'company', description: 'Company id or name' },
    { name: 'search', description: 'Ticker or company name' }
  ]
};

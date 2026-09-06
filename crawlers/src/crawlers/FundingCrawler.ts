import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import { FundingEvent, FundingEventSchema, Company } from '../models/types.js';
import { detectSubstances } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

interface EftsHit {
  _id?: string; // "accessionNumber:documentName"
  _source?: {
    ciks?: string[];
    display_names?: string[]; // "Company Name  (CIK 0001234567)"
    file_date?: string;
    file_type?: string;
    adsh?: string; // accession number with dashes
  };
}

interface EftsSearchResponse {
  hits?: {
    total?: { value?: number };
    hits?: EftsHit[];
  };
}

interface SecSubmissions {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
    };
  };
}

/** Parsed Form D primary_doc.xml (schema X0708) */
interface FormDDocument {
  edgarSubmission?: {
    submissionType?: string;
    primaryIssuer?: {
      cik?: string | number;
      entityName?: string;
      issuerAddress?: { city?: string; stateOrCountry?: string; stateOrCountryDescription?: string };
    };
    relatedPersonsList?: {
      relatedPersonInfo?: Array<{
        relatedPersonName?: { firstName?: string; middleName?: string; lastName?: string };
        relatedPersonRelationshipList?: { relationship?: string | string[] };
        relationshipClarification?: string;
      }>;
    };
    offeringData?: {
      industryGroup?: { industryGroupType?: string };
      typesOfSecuritiesOffered?: Record<string, boolean | string>;
      offeringSalesAmounts?: {
        totalOfferingAmount?: string | number;
        totalAmountSold?: string | number;
        totalRemaining?: string | number;
      };
      investors?: { totalNumberAlreadyInvested?: string | number };
    };
  };
}

export interface FundingCrawlerOptions {
  /** Stored companies; every one with a CIK has its Form D filings pulled */
  companies?: Company[];
  /** Max Form D documents fetched per company per run */
  maxFilingsPerCompany?: number;
}

/**
 * Funding crawler — the private raise tracker.
 *
 * Form D is the notice a company files after selling securities in an
 * exempt (private) offering, so it captures rounds that never hit the news.
 * The form has no business description, so full-text search almost never
 * finds them by substance; instead every company in the database that has
 * an SEC CIK gets its Form D / D/A filings pulled from its submissions feed
 * and the primary document parsed for amounts, investor counts and the
 * officers named. EDGAR full-text search is kept as a secondary source for
 * vehicles (SPVs, funds) whose names mention the sector.
 */
export class FundingCrawler extends BaseCrawler<FundingEvent> {
  private static readonly QUERY_TERMS = ['psilocybin', 'psychedelic', 'MDMA', 'ibogaine', 'ketamine', 'kratom'];

  private readonly options: FundingCrawlerOptions;
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => ['relatedPersonInfo', 'relationship'].includes(name)
  });

  constructor(options: FundingCrawlerOptions = {}) {
    super({
      name: 'FundingCrawler',
      baseUrl: 'https://efts.sec.gov/LATEST',
      rateLimit: 4, // SEC allows 10/sec; stay conservative
      concurrency: 2,
      retries: 3,
      timeout: 30000,
      headers: {
        // SEC requires a descriptive User-Agent with contact info
        'User-Agent': 'Neuly Research contact@neuly.io',
        'Accept': 'application/json, application/xml, text/xml, */*'
      }
    });
    this.options = options;
  }

  async crawl(query?: string): Promise<CrawlResult<FundingEvent>> {
    const events: FundingEvent[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    // 1. Form D filings by every company we know the CIK for
    const withCik = (this.options.companies ?? []).filter(c => c.cik);
    for (const company of withCik) {
      try {
        const filings = await this.crawlCompanyFormDs(company);
        events.push(...filings);
        if (filings.length > 0) {
          logger.info(`[FundingCrawler] ${company.name}: ${filings.length} Form D filings`);
        }
      } catch (error) {
        errors.push(`Form D lookup for ${company.name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // 2. Full-text search for filers whose Form D text names the sector
    const terms = query ? [query] : FundingCrawler.QUERY_TERMS;
    for (const term of terms) {
      try {
        const filings = await this.searchFilings(term);
        events.push(...filings);
        logger.info(`[FundingCrawler] Full-text: ${filings.length} Form D filings for "${term}"`);
      } catch (error) {
        errors.push(`EDGAR search "${term}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Same filing may arrive from both paths — merge, preferring parsed detail
    const unique = new Map<string, FundingEvent>();
    for (const event of events) {
      const existing = unique.get(event.id);
      if (!existing) {
        unique.set(event.id, event);
        continue;
      }
      unique.set(event.id, {
        ...existing,
        ...event,
        matchedTerms: Array.from(new Set([...(existing.matchedTerms || []), ...(event.matchedTerms || [])])),
        substances: Array.from(new Set([...(existing.substances || []), ...(event.substances || [])])) as FundingEvent['substances'],
        totalOfferingAmount: existing.totalOfferingAmount ?? event.totalOfferingAmount,
        totalAmountSold: existing.totalAmountSold ?? event.totalAmountSold
      });
    }

    return {
      success: errors.length === 0,
      data: Array.from(unique.values()),
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: unique.size + errors.length,
        successful: unique.size,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /** Form D / D/A filings listed in a company's submissions feed */
  private async crawlCompanyFormDs(company: Company): Promise<FundingEvent[]> {
    const cik = String(company.cik).replace(/^0+/, '').padStart(10, '0');
    const submissions = await this.request<SecSubmissions>(
      `https://data.sec.gov/submissions/CIK${cik}.json`
    );
    const recent = submissions.filings?.recent;
    if (!recent) return [];

    const max = this.options.maxFilingsPerCompany ?? 12;
    const events: FundingEvent[] = [];
    for (let i = 0; i < recent.form.length && events.length < max; i++) {
      const form = recent.form[i];
      if (form !== 'D' && form !== 'D/A') continue;

      const accession = recent.accessionNumber[i];
      const accessionNoDashes = accession.replace(/-/g, '');
      const folder = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}`;
      // The listed document is the XSL-rendered view; the raw XML sits beside it
      const primaryDoc = (recent.primaryDocument[i] || 'primary_doc.xml').replace(/^xslFormDX\d+\//, '');

      let parsed: Partial<FundingEvent> = {};
      try {
        const xml = await this.request<string>(`${folder}/${primaryDoc}`, { responseType: 'text' });
        parsed = this.parseFormD(xml);
      } catch (error) {
        logger.debug(`[FundingCrawler] Could not parse ${accession} for ${company.name}: ${error instanceof Error ? error.message : error}`);
      }

      const transformed: Partial<FundingEvent> = {
        id: this.generateId('fund', accession),
        companyName: company.name,
        cik,
        formType: form,
        filedAt: parseDate(recent.filingDate[i]) || recent.filingDate[i],
        accessionNumber: accession,
        substances: company.substances,
        matchedTerms: [],
        url: `${folder}/${accession}-index.htm`,
        source: 'SEC EDGAR Form D',
        crawledAt: this.getTimestamp(),
        ...parsed
      };
      const validated = this.validate(transformed);
      if (validated) events.push(validated);
    }
    return events;
  }

  /** Extract amounts, investors, industry and named persons from Form D XML */
  parseFormD(xml: string): Partial<FundingEvent> {
    const doc = this.xmlParser.parse(xml) as FormDDocument;
    const submission = doc.edgarSubmission;
    if (!submission) return {};

    const offering = submission.offeringData;
    const amounts = offering?.offeringSalesAmounts;
    const securities = offering?.typesOfSecuritiesOffered;
    const securityTypes = securities
      ? Object.entries(securities)
          .filter(([key, value]) => key.startsWith('is') && (value === true || value === 'true'))
          .map(([key]) => key.replace(/^is/, '').replace(/Type$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
      : [];

    const relatedPersons = (submission.relatedPersonsList?.relatedPersonInfo ?? [])
      .map(person => {
        const n = person.relatedPersonName;
        const name = [n?.firstName, n?.middleName, n?.lastName].filter(Boolean).join(' ').trim();
        const rel = person.relatedPersonRelationshipList?.relationship;
        const roles = (Array.isArray(rel) ? rel : rel ? [rel] : []).map(String);
        if (person.relationshipClarification) roles.push(String(person.relationshipClarification));
        return { name, roles };
      })
      .filter(p => p.name);

    const address = submission.primaryIssuer?.issuerAddress;
    return {
      totalOfferingAmount: toAmount(amounts?.totalOfferingAmount),
      totalAmountSold: toAmount(amounts?.totalAmountSold),
      totalRemaining: toAmount(amounts?.totalRemaining),
      investorCount: toCount(offering?.investors?.totalNumberAlreadyInvested),
      industryGroup: offering?.industryGroup?.industryGroupType
        ? String(offering.industryGroup.industryGroupType).replace(/([a-z])([A-Z])/g, '$1 $2')
        : undefined,
      securityTypes: securityTypes.length > 0 ? securityTypes : undefined,
      issuerCity: address?.city ? titleCase(String(address.city)) : undefined,
      issuerState: address?.stateOrCountry ? String(address.stateOrCountry) : undefined,
      relatedPersons: relatedPersons.length > 0 ? relatedPersons.slice(0, 20) : undefined
    };
  }

  /**
   * EDGAR full-text search scoped to Form D / D/A filings.
   * Endpoint: https://efts.sec.gov/LATEST/search-index?q=...&forms=D
   */
  private async searchFilings(term: string): Promise<FundingEvent[]> {
    const response = await this.request<EftsSearchResponse>('/search-index', {
      params: {
        q: `"${term}"`,
        forms: 'D,D/A'
      }
    });

    const events: FundingEvent[] = [];

    for (const hit of response.hits?.hits || []) {
      const source = hit._source;
      if (!source?.adsh || !source.file_date) continue;

      const displayName = source.display_names?.[0] || 'Unknown filer';
      const companyName = cleanText(displayName.replace(/\s*\(CIK[^)]*\)\s*/i, '')) || displayName;
      const cik = source.ciks?.[0];
      const accession = source.adsh;
      const accessionNoDashes = accession.replace(/-/g, '');
      const filingUrl = cik
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${accession}-index.htm`
        : `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(accession)}`;

      const transformed: Partial<FundingEvent> = {
        id: this.generateId('fund', accession),
        companyName,
        cik,
        formType: source.file_type || 'D',
        filedAt: parseDate(source.file_date) || source.file_date,
        accessionNumber: accession,
        substances: detectSubstances(`${companyName} ${term}`),
        matchedTerms: [term],
        url: filingUrl,
        source: 'SEC EDGAR Full-Text Search',
        crawledAt: this.getTimestamp()
      };

      const validated = this.validate(transformed);
      if (validated) events.push(validated);
    }

    return events;
  }

  transform(rawData: unknown): Partial<FundingEvent> {
    return rawData as Partial<FundingEvent>;
  }

  validate(data: unknown): FundingEvent | null {
    try {
      return FundingEventSchema.parse(data);
    } catch (error) {
      logger.warn(`[FundingCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  static getDefaultQueries(): string[] {
    return FundingCrawler.QUERY_TERMS;
  }
}

/** Form D amounts are numeric strings or the literal "Indefinite" */
function toAmount(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const n = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(value).trim() !== '' && /\d/.test(String(value)) ? n : undefined;
}

function toCount(value: string | number | undefined): number | undefined {
  const n = toAmount(value);
  return n === undefined ? undefined : Math.round(n);
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
}

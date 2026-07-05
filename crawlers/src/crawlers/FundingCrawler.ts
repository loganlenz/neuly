import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import { FundingEvent, FundingEventSchema } from '../models/types.js';
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

/**
 * Crawler for SEC Form D (exempt offering) filings — the private funding
 * tracker. Uses EDGAR full-text search (EFTS) to find Form D and D/A
 * filings whose text mentions psychedelic terms, i.e. private raises by
 * companies in the space that never hit the news.
 */
export class FundingCrawler extends BaseCrawler<FundingEvent> {
  private static readonly QUERY_TERMS = [
    'psilocybin',
    'psychedelic',
    'MDMA',
    'ibogaine',
    'ketamine'
  ];

  constructor() {
    super({
      name: 'FundingCrawler',
      baseUrl: 'https://efts.sec.gov/LATEST',
      rateLimit: 2, // SEC allows 10/sec; stay conservative
      concurrency: 1,
      retries: 3,
      timeout: 30000,
      headers: {
        // SEC requires a descriptive User-Agent with contact info
        'User-Agent': 'Neuly Research contact@neuly.io'
      }
    });
  }

  async crawl(query?: string): Promise<CrawlResult<FundingEvent>> {
    const events: FundingEvent[] = [];
    const errors: string[] = [];
    const startTime = Date.now();
    const terms = query ? [query] : FundingCrawler.QUERY_TERMS;

    for (const term of terms) {
      try {
        const filings = await this.searchFilings(term);
        events.push(...filings);
        logger.info(`[FundingCrawler] Found ${filings.length} Form D filings for "${term}"`);
      } catch (error) {
        errors.push(`EDGAR search "${term}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Same filing matches multiple terms — merge and keep all matched terms
    const unique = new Map<string, FundingEvent>();
    for (const event of events) {
      const existing = unique.get(event.id);
      if (existing) {
        existing.matchedTerms = Array.from(new Set([...(existing.matchedTerms || []), ...(event.matchedTerms || [])]));
      } else {
        unique.set(event.id, event);
      }
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

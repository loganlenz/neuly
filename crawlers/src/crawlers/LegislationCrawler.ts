import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import { LegislationBill, LegislationBillSchema } from '../models/types.js';
import { detectSubstances } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

interface FederalRegisterDocument {
  document_number?: string;
  title?: string;
  abstract?: string;
  type?: string; // 'Rule' | 'Proposed Rule' | 'Notice' | 'Presidential Document'
  publication_date?: string;
  html_url?: string;
  agencies?: Array<{ name?: string; raw_name?: string }>;
}

interface FederalRegisterResponse {
  count?: number;
  next_page_url?: string | null;
  results?: FederalRegisterDocument[];
}

interface LegiScanSearchResult {
  searchresult?: Record<string, {
    relevance?: number;
    bill_id?: number;
    bill_number?: string;
    state?: string;
    title?: string;
    last_action?: string;
    last_action_date?: string;
    url?: string;
    text_url?: string;
  } | { count?: number; page?: string }>;
}

/**
 * Crawler for legislation and regulatory actions:
 * - Federal Register API (no key): DEA/FDA/HHS rules, proposed rules, notices
 * - LegiScan API (LEGISCAN_API_KEY): state bills across all 50 states
 *
 * Both feed the `legislation` data type — the state-by-state and federal
 * policy tracker.
 */
export class LegislationCrawler extends BaseCrawler<LegislationBill> {
  private legiscanApiKey?: string;

  /** Terms searched against both APIs */
  private static readonly QUERY_TERMS = [
    'psilocybin',
    'psychedelic',
    'MDMA',
    'ibogaine',
    'ketamine clinic'
  ];

  constructor(legiscanApiKey?: string) {
    super({
      name: 'LegislationCrawler',
      baseUrl: '',
      rateLimit: 1,
      concurrency: 1,
      retries: 3,
      timeout: 30000
    });
    this.legiscanApiKey = legiscanApiKey || process.env.LEGISCAN_API_KEY;
  }

  async crawl(query?: string): Promise<CrawlResult<LegislationBill>> {
    const bills: LegislationBill[] = [];
    const errors: string[] = [];
    const startTime = Date.now();
    const terms = query ? [query] : LegislationCrawler.QUERY_TERMS;

    // Federal Register — always available, no API key
    for (const term of terms) {
      try {
        const documents = await this.crawlFederalRegister(term);
        bills.push(...documents);
        logger.info(`[LegislationCrawler] Federal Register: ${documents.length} documents for "${term}"`);
      } catch (error) {
        errors.push(`Federal Register "${term}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // LegiScan — state bills, requires API key
    if (this.legiscanApiKey) {
      for (const term of terms) {
        try {
          const stateBills = await this.crawlLegiScan(term);
          bills.push(...stateBills);
          logger.info(`[LegislationCrawler] LegiScan: ${stateBills.length} bills for "${term}"`);
        } catch (error) {
          errors.push(`LegiScan "${term}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } else {
      logger.warn('[LegislationCrawler] LEGISCAN_API_KEY not set — skipping state bills (get a free key at legiscan.com/legiscan)');
    }

    // Deduplicate: the same bill matches multiple search terms
    const unique = new Map<string, LegislationBill>();
    for (const bill of bills) {
      unique.set(bill.id, bill);
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
   * Federal Register documents mentioning a term.
   * API docs: https://www.federalregister.gov/developers/documentation/api/v1
   */
  private async crawlFederalRegister(term: string): Promise<LegislationBill[]> {
    const response = await this.request<FederalRegisterResponse>(
      'https://www.federalregister.gov/api/v1/documents.json',
      {
        params: {
          'conditions[term]': `"${term}"`,
          'per_page': 100,
          'order': 'newest',
          'fields[]': ['document_number', 'title', 'abstract', 'type', 'publication_date', 'html_url', 'agencies']
        }
      }
    );

    const bills: LegislationBill[] = [];
    for (const doc of response.results || []) {
      if (!doc.document_number || !doc.title || !doc.html_url) continue;

      const text = `${doc.title} ${doc.abstract || ''}`;
      const transformed: Partial<LegislationBill> = {
        id: this.generateId('leg', `fr-${doc.document_number}`),
        jurisdiction: 'US-Federal',
        billNumber: doc.document_number,
        title: cleanText(doc.title) || doc.title,
        description: cleanText(doc.abstract)?.slice(0, 2000),
        status: doc.type,
        agencies: (doc.agencies || [])
          .map(a => a.name || a.raw_name)
          .filter((name): name is string => Boolean(name)),
        substances: detectSubstances(text),
        lastActionDate: parseDate(doc.publication_date),
        url: doc.html_url,
        source: 'Federal Register',
        crawledAt: this.getTimestamp()
      };

      const validated = this.validate(transformed);
      if (validated) bills.push(validated);
    }

    return bills;
  }

  /**
   * LegiScan full-text search across all states.
   * API docs: https://legiscan.com/legiscan (op=getSearch)
   */
  private async crawlLegiScan(term: string): Promise<LegislationBill[]> {
    const response = await this.request<LegiScanSearchResult>('https://api.legiscan.com/', {
      params: {
        key: this.legiscanApiKey,
        op: 'getSearch',
        state: 'ALL',
        query: term
      }
    });

    const bills: LegislationBill[] = [];
    const results = response.searchresult || {};

    for (const [key, value] of Object.entries(results)) {
      if (key === 'summary') continue; // metadata entry, not a bill
      const hit = value as Extract<typeof value, { bill_id?: number }>;
      if (!hit.bill_id || !hit.bill_number || !hit.state || !hit.title || !hit.url) continue;

      const transformed: Partial<LegislationBill> = {
        id: this.generateId('leg', `ls-${hit.bill_id}`),
        jurisdiction: hit.state,
        billNumber: hit.bill_number,
        title: cleanText(hit.title) || hit.title,
        substances: detectSubstances(hit.title) ,
        lastAction: cleanText(hit.last_action),
        lastActionDate: parseDate(hit.last_action_date),
        url: hit.url,
        source: 'LegiScan',
        crawledAt: this.getTimestamp()
      };

      const validated = this.validate(transformed);
      if (validated) bills.push(validated);
    }

    return bills;
  }

  transform(rawData: unknown): Partial<LegislationBill> {
    return rawData as Partial<LegislationBill>;
  }

  validate(data: unknown): LegislationBill | null {
    try {
      return LegislationBillSchema.parse(data);
    } catch (error) {
      logger.warn(`[LegislationCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  static getDefaultQueries(): string[] {
    return LegislationCrawler.QUERY_TERMS;
  }
}

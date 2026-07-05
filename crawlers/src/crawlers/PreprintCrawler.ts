import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import { ResearchPaper, ResearchPaperSchema } from '../models/types.js';
import { detectSubstances } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

interface BiorxivRecord {
  doi?: string;
  title?: string;
  authors?: string; // "Last, F.; Last, F."
  author_corresponding_institution?: string;
  date?: string; // YYYY-MM-DD
  category?: string;
  abstract?: string;
  server?: string;
  version?: string;
  published?: string; // journal DOI once published, or "NA"
}

interface BiorxivResponse {
  messages?: Array<{ status?: string; count?: number; total?: number; cursor?: string | number }>;
  collection?: BiorxivRecord[];
}

/**
 * Crawler for bioRxiv and medRxiv preprints. The details API has no
 * keyword search, so we sweep a rolling window of recent posts and keep
 * the ones mentioning tracked substances. Preprints surface research
 * 6-18 months before it lands in PubMed.
 *
 * Output feeds the shared `research_papers` data type with
 * publicationType ['Preprint'].
 */
export class PreprintCrawler extends BaseCrawler<ResearchPaper> {
  private static readonly SERVERS = ['biorxiv', 'medrxiv'] as const;
  /** How far back each crawl sweeps */
  private static readonly WINDOW_DAYS = 30;
  /** Page cap per server per crawl (100 records/page) */
  private static readonly MAX_PAGES = 30;

  constructor() {
    super({
      name: 'PreprintCrawler',
      baseUrl: 'https://api.biorxiv.org',
      rateLimit: 1,
      concurrency: 1,
      retries: 3,
      timeout: 60000
    });
  }

  async crawl(_query?: string): Promise<CrawlResult<ResearchPaper>> {
    const papers: ResearchPaper[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    const end = new Date();
    const start = new Date(end.getTime() - PreprintCrawler.WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const interval = `${this.isoDay(start)}/${this.isoDay(end)}`;

    for (const server of PreprintCrawler.SERVERS) {
      try {
        const serverPapers = await this.crawlServer(server, interval);
        papers.push(...serverPapers);
        logger.info(`[PreprintCrawler] ${server}: kept ${serverPapers.length} relevant preprints`);
      } catch (error) {
        errors.push(`${server} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      success: errors.length === 0,
      data: papers,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: papers.length + errors.length,
        successful: papers.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * Page through /details/{server}/{from}/{to}/{cursor} keeping
   * substance-relevant records.
   * API docs: https://api.biorxiv.org
   */
  private async crawlServer(server: string, interval: string): Promise<ResearchPaper[]> {
    const papers: ResearchPaper[] = [];
    let cursor = 0;

    for (let page = 0; page < PreprintCrawler.MAX_PAGES; page++) {
      const response = await this.request<BiorxivResponse>(`/details/${server}/${interval}/${cursor}`);
      const records = response.collection || [];
      if (records.length === 0) break;

      for (const record of records) {
        const text = `${record.title || ''} ${record.abstract || ''}`;
        const substances = detectSubstances(text);
        if (substances.length === 0) continue;

        const transformed = this.transformRecord(record, server, substances);
        const validated = this.validate(transformed);
        if (validated) papers.push(validated);
      }

      const message = response.messages?.[0];
      const total = message?.total ?? 0;
      cursor += records.length;
      if (cursor >= total || records.length < 100) break;
    }

    return papers;
  }

  private transformRecord(
    record: BiorxivRecord,
    server: string,
    substances: ResearchPaper['substances']
  ): Partial<ResearchPaper> {
    const doiSlug = (record.doi || '').replace(/[^a-zA-Z0-9]+/g, '-');
    const authors = (record.authors || '')
      .split(';')
      .map(a => cleanText(a))
      .filter((a): a is string => Boolean(a))
      .map(name => ({ name }));

    const year = record.date ? parseInt(record.date.slice(0, 4), 10) : undefined;
    const journalLabel = server === 'biorxiv' ? 'bioRxiv' : 'medRxiv';

    return {
      id: this.generateId('pp', doiSlug),
      doi: record.doi,
      title: cleanText(record.title) || record.title || 'Untitled preprint',
      authors,
      journal: journalLabel,
      publicationDate: record.date,
      year: Number.isNaN(year) ? undefined : year,
      abstract: cleanText(record.abstract)?.slice(0, 5000),
      substances,
      publicationType: ['Preprint'],
      isOpenAccess: true,
      url: record.doi ? `https://doi.org/${record.doi}` : undefined,
      crawledAt: this.getTimestamp()
    };
  }

  private isoDay(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  transform(rawData: unknown): Partial<ResearchPaper> {
    return rawData as Partial<ResearchPaper>;
  }

  validate(data: unknown): ResearchPaper | null {
    try {
      return ResearchPaperSchema.parse(data);
    } catch (error) {
      logger.warn(`[PreprintCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }
}

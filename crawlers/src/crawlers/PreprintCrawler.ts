import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import { ResearchPaper, ResearchPaperSchema } from '../models/types.js';
import { detectSubstances, SUBSTANCE_QUERY_TERMS } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

/** Europe PMC REST search result (resultType=core) */
interface EuropePmcResult {
  id?: string; // e.g. PPR1307002
  source?: string; // 'PPR' for preprints
  doi?: string;
  title?: string;
  authorString?: string; // "Last F, Last F."
  authorList?: { author?: Array<{ fullName?: string; firstName?: string; lastName?: string; affiliation?: string }> };
  firstPublicationDate?: string; // YYYY-MM-DD
  pubYear?: string | number;
  abstractText?: string;
  keywordList?: { keyword?: string[] };
  bookOrReportDetails?: { publisher?: string };
  isOpenAccess?: string; // 'Y' | 'N'
  citedByCount?: number;
  fullTextUrlList?: { fullTextUrl?: Array<{ url?: string; documentStyle?: string }> };
}

interface EuropePmcResponse {
  hitCount?: number;
  nextCursorMark?: string;
  resultList?: { result?: EuropePmcResult[] };
}

/**
 * Preprint crawler — research 6-18 months ahead of the journals.
 *
 * Europe PMC indexes preprints from bioRxiv, medRxiv, Research Square,
 * SSRN, Preprints.org, PsyArXiv and more, and supports term search, so a
 * per-substance query finds every relevant preprint directly instead of
 * paging through every life-science preprint posted in the last month.
 * API docs: https://europepmc.org/RestfulWebService
 */
export class PreprintCrawler extends BaseCrawler<ResearchPaper> {
  private static readonly PAGE_SIZE = 100;
  /** Pages per query term (100 records each) */
  private static readonly MAX_PAGES = 5;

  constructor() {
    super({
      name: 'PreprintCrawler',
      baseUrl: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
      rateLimit: 3,
      concurrency: 1,
      retries: 3,
      timeout: 60000
    });
  }

  async crawl(query?: string): Promise<CrawlResult<ResearchPaper>> {
    const papers = new Map<string, ResearchPaper>();
    const errors: string[] = [];
    const startTime = Date.now();
    const terms = query ? [query] : PreprintCrawler.getDefaultQueries();

    for (const term of terms) {
      try {
        const found = await this.searchTerm(term);
        for (const paper of found) papers.set(paper.id, paper);
        logger.info(`[PreprintCrawler] "${term}": ${found.length} preprints`);
      } catch (error) {
        errors.push(`Europe PMC "${term}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return {
      success: errors.length === 0,
      data: Array.from(papers.values()),
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: papers.size + errors.length,
        successful: papers.size,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  private async searchTerm(term: string): Promise<ResearchPaper[]> {
    const papers: ResearchPaper[] = [];
    let cursor = '*';
    for (let page = 0; page < PreprintCrawler.MAX_PAGES; page++) {
      const response = await this.request<EuropePmcResponse>('/search', {
        params: {
          query: `(${term}) AND (SRC:PPR)`,
          format: 'json',
          resultType: 'core',
          pageSize: PreprintCrawler.PAGE_SIZE,
          sort: 'FIRST_PDATE_D desc',
          cursorMark: cursor
        }
      });
      const results = response.resultList?.result ?? [];
      for (const record of results) {
        const text = `${record.title || ''} ${record.abstractText || ''}`;
        const substances = detectSubstances(text);
        if (substances.length === 0) continue;
        const validated = this.validate(this.transformRecord(record, substances));
        if (validated) papers.push(validated);
      }
      if (results.length < PreprintCrawler.PAGE_SIZE || !response.nextCursorMark || response.nextCursorMark === cursor) break;
      cursor = response.nextCursorMark;
    }
    return papers;
  }

  private transformRecord(record: EuropePmcResult, substances: ResearchPaper['substances']): Partial<ResearchPaper> {
    const doi = record.doi?.trim();
    const idBase = doi ? doi.replace(/[^a-zA-Z0-9]+/g, '-') : `epmc-${record.id}`;

    const authors = (record.authorList?.author ?? [])
      .map(a => ({
        name: cleanText(a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ')) || '',
        affiliation: cleanText(a.affiliation)
      }))
      .filter(a => a.name);
    const fallbackAuthors = (record.authorString || '')
      .split(/,\s*|;\s*/)
      .map(a => cleanText(a.replace(/\.$/, '')))
      .filter((a): a is string => Boolean(a))
      .map(name => ({ name }));

    const year = record.pubYear ? parseInt(String(record.pubYear), 10) : record.firstPublicationDate ? parseInt(record.firstPublicationDate.slice(0, 4), 10) : undefined;
    const server = record.bookOrReportDetails?.publisher || 'Preprint server';
    const url = doi
      ? `https://doi.org/${doi}`
      : record.id ? `https://europepmc.org/article/PPR/${record.id}` : undefined;

    return {
      id: this.generateId('pp', idBase),
      doi,
      title: cleanText(record.title) || record.title || 'Untitled preprint',
      authors: authors.length > 0 ? authors : fallbackAuthors,
      journal: server,
      publicationDate: record.firstPublicationDate,
      year: year !== undefined && !Number.isNaN(year) ? year : undefined,
      abstract: cleanText(record.abstractText)?.slice(0, 5000),
      keywords: record.keywordList?.keyword?.slice(0, 20),
      substances,
      citationCount: typeof record.citedByCount === 'number' ? record.citedByCount : undefined,
      publicationType: ['Preprint'],
      isOpenAccess: true,
      url,
      crawledAt: this.getTimestamp()
    };
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

  static getDefaultQueries(): string[] {
    return [
      ...SUBSTANCE_QUERY_TERMS.filter(t => t !== 'psychedelic'),
      'psychedelic', 'esketamine', '"5-MeO-DMT"', 'psilocin', 'cannabidiol'
    ];
  }
}

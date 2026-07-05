import axios, { AxiosInstance } from 'axios';
import { ResearchPaper } from '../models/types.js';
import { logger } from '../utils/logger.js';

interface OpenAlexWork {
  doi?: string; // "https://doi.org/10.1234/abcd"
  cited_by_count?: number;
  open_access?: { is_oa?: boolean };
}

interface OpenAlexResponse {
  results?: OpenAlexWork[];
}

/**
 * Enriches stored research papers with citation counts and open-access
 * flags from OpenAlex (free, no key; a mailto gets the polite pool).
 * Also the future hook for author disambiguation and institution links.
 * API docs: https://docs.openalex.org
 */
export class OpenAlexEnricher {
  private client: AxiosInstance;
  private static readonly BATCH_SIZE = 50; // OpenAlex OR-filter limit

  constructor(mailto?: string) {
    const email = mailto || process.env.OPENALEX_MAILTO;
    this.client = axios.create({
      baseURL: 'https://api.openalex.org',
      timeout: 60000,
      params: email ? { mailto: email } : {},
      headers: {
        'User-Agent': 'Neuly Research Crawler/1.0 (https://neuly.io; research@neuly.io)'
      }
    });
  }

  /**
   * Enrich papers that have DOIs. Returns only the papers whose
   * citationCount or isOpenAccess actually changed.
   */
  async enrich(papers: ResearchPaper[]): Promise<ResearchPaper[]> {
    const withDoi = papers.filter(p => p.doi);
    logger.info(`[OpenAlexEnricher] Enriching ${withDoi.length}/${papers.length} papers with DOIs`);

    const updated: ResearchPaper[] = [];

    for (let i = 0; i < withDoi.length; i += OpenAlexEnricher.BATCH_SIZE) {
      const batch = withDoi.slice(i, i + OpenAlexEnricher.BATCH_SIZE);
      try {
        const byDoi = await this.fetchBatch(batch.map(p => p.doi!));

        for (const paper of batch) {
          const work = byDoi.get(normalizeDoi(paper.doi!));
          if (!work) continue;

          const citationCount = work.cited_by_count;
          const isOpenAccess = work.open_access?.is_oa;
          const changed =
            (citationCount !== undefined && citationCount !== paper.citationCount) ||
            (isOpenAccess !== undefined && isOpenAccess !== paper.isOpenAccess);

          if (changed) {
            updated.push({
              ...paper,
              citationCount: citationCount ?? paper.citationCount,
              isOpenAccess: isOpenAccess ?? paper.isOpenAccess,
              crawledAt: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        logger.warn(`[OpenAlexEnricher] Batch ${i / OpenAlexEnricher.BATCH_SIZE + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Polite pacing between batches
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    logger.info(`[OpenAlexEnricher] ${updated.length} papers updated`);
    return updated;
  }

  private async fetchBatch(dois: string[]): Promise<Map<string, OpenAlexWork>> {
    const filter = `doi:${dois.map(normalizeDoi).join('|')}`;
    const response = await this.client.get<OpenAlexResponse>('/works', {
      params: { filter, 'per-page': OpenAlexEnricher.BATCH_SIZE, select: 'doi,cited_by_count,open_access' }
    });

    const byDoi = new Map<string, OpenAlexWork>();
    for (const work of response.data.results || []) {
      if (work.doi) {
        byDoi.set(normalizeDoi(work.doi), work);
      }
    }
    return byDoi;
  }
}

/** Normalize "https://doi.org/10.X/Y" and bare "10.X/Y" to the same key */
function normalizeDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
}

import { describe, it, expect } from 'vitest';
import { BaseCrawler, CrawlResult } from './BaseCrawler.js';
import { CrawledData } from '../models/types.js';

// Minimal shape for the dedupe test; cast into the entity union at the class
// boundary because BaseCrawler is generic over CrawledData.
interface StubItem {
  id: string;
  crawledAt: string;
}
type StubEntity = StubItem & CrawledData;

/**
 * The same entity routinely matches several search queries. run() must
 * return one row per id — duplicate ids in a single Postgres
 * INSERT ... ON CONFLICT statement are a hard error
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 */
class StubCrawler extends BaseCrawler<StubEntity> {
  constructor(private resultsByQuery: Record<string, string[]>) {
    super({ name: 'Stub', baseUrl: 'http://localhost' });
  }

  async crawl(query: string): Promise<CrawlResult<StubEntity>> {
    const ids = this.resultsByQuery[query] ?? [];
    const data = ids.map(id => ({ id, crawledAt: new Date().toISOString() }) as StubEntity);
    return {
      success: true,
      data,
      stats: { total: data.length, successful: data.length, failed: 0, duration: 0 }
    };
  }

  transform(raw: unknown): Partial<StubEntity> { return raw as Partial<StubEntity>; }
  validate(data: unknown): StubEntity | null { return data as StubEntity; }
}

describe('BaseCrawler.run cross-query deduplication', () => {
  it('returns one row per id when queries overlap', async () => {
    const crawler = new StubCrawler({
      'psilocybin depression': ['ct_a', 'ct_b', 'ct_c'],
      'psychedelic therapy': ['ct_b', 'ct_c', 'ct_d'],
      'MDMA PTSD': ['ct_a', 'ct_e']
    });

    const result = await crawler.run(['psilocybin depression', 'psychedelic therapy', 'MDMA PTSD']);

    expect(result.success).toBe(true);
    const ids = (result.data ?? []).map(item => item.id).sort();
    expect(ids).toEqual(['ct_a', 'ct_b', 'ct_c', 'ct_d', 'ct_e']);
    expect(result.stats.successful).toBe(5);
  });

  it('passes through when there is no overlap', async () => {
    const crawler = new StubCrawler({
      'q1': ['x1', 'x2'],
      'q2': ['x3']
    });

    const result = await crawler.run(['q1', 'q2']);
    expect((result.data ?? []).length).toBe(3);
  });
});

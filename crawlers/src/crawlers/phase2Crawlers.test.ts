import { describe, it, expect } from 'vitest';
import { LegislationCrawler } from './LegislationCrawler.js';
import { FundingCrawler } from './FundingCrawler.js';
import { PreprintCrawler } from './PreprintCrawler.js';
import { GrantsCrawler } from './GrantsCrawler.js';

/**
 * Fixture-based tests: the external APIs are stubbed by overriding the
 * crawler's request method, so these exercise the real transform,
 * validation, tagging, and dedup logic against realistic payloads.
 */

type Requestable = { request: (url: string, opts?: unknown) => Promise<unknown> };
function stubRequest(crawler: object, fn: (url: string, opts?: unknown) => Promise<unknown>): void {
  (crawler as unknown as Requestable).request = fn;
}

describe('LegislationCrawler', () => {
  const federalRegisterFixture = {
    count: 2,
    results: [
      {
        document_number: '2026-12345',
        title: 'Schedules of Controlled Substances: Placement of Psilocybin in Schedule II',
        abstract: 'The DEA proposes to transfer psilocybin from schedule I to schedule II.',
        type: 'Proposed Rule',
        publication_date: '2026-06-15',
        html_url: 'https://www.federalregister.gov/documents/2026/06/15/2026-12345',
        agencies: [{ name: 'Drug Enforcement Administration' }]
      },
      {
        // missing document_number -> skipped
        title: 'Broken document',
        html_url: 'https://example.gov/broken'
      }
    ]
  };

  const legiscanFixture = {
    searchresult: {
      summary: { count: 1, page: '1 of 1' },
      '0': {
        relevance: 99,
        bill_id: 1888999,
        bill_number: 'SB303',
        state: 'CO',
        title: 'Concerning natural medicine psilocybin services',
        last_action: 'Governor Signed',
        last_action_date: '2026-05-28',
        url: 'https://legiscan.com/CO/bill/SB303/2026'
      }
    }
  };

  it('maps Federal Register documents and skips malformed ones', async () => {
    const crawler = new LegislationCrawler('test-key');
    stubRequest(crawler, async (url: string) =>
      url.includes('federalregister') ? federalRegisterFixture : legiscanFixture
    );

    const result = await crawler.crawl('psilocybin');
    expect(result.success).toBe(true);

    const federal = result.data!.filter(b => b.jurisdiction === 'US-Federal');
    expect(federal).toHaveLength(1);
    expect(federal[0].billNumber).toBe('2026-12345');
    expect(federal[0].status).toBe('Proposed Rule');
    expect(federal[0].agencies).toEqual(['Drug Enforcement Administration']);
    expect(federal[0].substances).toContain('Psilocybin');
    expect(federal[0].id).toBe('leg_fr-2026-12345');
  });

  it('maps LegiScan bills and skips the summary entry', async () => {
    const crawler = new LegislationCrawler('test-key');
    stubRequest(crawler, async (url: string) =>
      url.includes('federalregister') ? { results: [] } : legiscanFixture
    );

    const result = await crawler.crawl('psilocybin');
    const state = result.data!.filter(b => b.jurisdiction === 'CO');
    expect(state).toHaveLength(1);
    expect(state[0].billNumber).toBe('SB303');
    expect(state[0].lastAction).toBe('Governor Signed');
    expect(state[0].lastActionDate).toBe('2026-05-28');
    expect(state[0].substances).toContain('Psilocybin');
  });

  it('skips LegiScan entirely without an API key', async () => {
    delete process.env.LEGISCAN_API_KEY;
    const crawler = new LegislationCrawler();
    let legiscanCalled = false;
    stubRequest(crawler, async (url: string) => {
      if (url.includes('legiscan')) legiscanCalled = true;
      return { results: [] };
    });

    const result = await crawler.crawl('psilocybin');
    expect(result.success).toBe(true);
    expect(legiscanCalled).toBe(false);
  });
});

describe('FundingCrawler', () => {
  const eftsFixture = {
    hits: {
      total: { value: 1 },
      hits: [
        {
          _id: '0001213900-26-034355:formd.xml',
          _source: {
            ciks: ['0001873324'],
            display_names: ['Psilera Inc.  (CIK 0001873324)'],
            file_date: '2026-04-12',
            file_type: 'D',
            adsh: '0001213900-26-034355'
          }
        }
      ]
    }
  };

  it('maps Form D filings with a working EDGAR link', async () => {
    const crawler = new FundingCrawler();
    stubRequest(crawler, async () => eftsFixture);

    const result = await crawler.crawl('psilocybin');
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);

    const event = result.data![0];
    expect(event.companyName).toBe('Psilera Inc.');
    expect(event.cik).toBe('0001873324');
    expect(event.filedAt).toBe('2026-04-12');
    expect(event.url).toBe('https://www.sec.gov/Archives/edgar/data/1873324/000121390026034355/0001213900-26-034355-index.htm');
  });

  it('merges the same filing matched by multiple terms', async () => {
    const crawler = new FundingCrawler();
    stubRequest(crawler, async () => eftsFixture);

    const result = await crawler.crawl(); // default terms, same fixture each time
    expect(result.data).toHaveLength(1);
    expect(result.data![0].matchedTerms!.length).toBeGreaterThan(1);
  });
});

describe('PreprintCrawler', () => {
  const biorxivFixture = {
    messages: [{ status: 'ok', count: 2, total: 2, cursor: 0 }],
    collection: [
      {
        doi: '10.1101/2026.06.01.657001',
        title: 'Psilocybin alters cortical dynamics in treatment-resistant depression',
        authors: 'Doe, J.; Smith, A.',
        date: '2026-06-20',
        category: 'neuroscience',
        abstract: 'We show psilocybin modulates...',
        server: 'biorxiv'
      },
      {
        doi: '10.1101/2026.06.02.657002',
        title: 'A CRISPR screen in yeast',
        authors: 'Roe, R.',
        date: '2026-06-21',
        category: 'genetics',
        abstract: 'Nothing psychedelic here.',
        server: 'biorxiv'
      }
    ]
  };

  it('keeps only substance-relevant preprints and maps them to ResearchPaper', async () => {
    const crawler = new PreprintCrawler();
    stubRequest(crawler, async () => biorxivFixture);

    const result = await crawler.crawl();
    expect(result.success).toBe(true);
    // fixture served for both biorxiv and medrxiv; each keeps 1 of 2
    expect(result.data!.length).toBe(2);

    const paper = result.data![0];
    expect(paper.title).toContain('Psilocybin');
    expect(paper.publicationType).toEqual(['Preprint']);
    expect(paper.isOpenAccess).toBe(true);
    expect(paper.authors.map(a => a.name)).toEqual(['Doe, J.', 'Smith, A.']);
    expect(paper.year).toBe(2026);
    expect(paper.url).toBe('https://doi.org/10.1101/2026.06.01.657001');
  });
});

describe('GrantsCrawler', () => {
  const reporterFixture = {
    meta: { total: 2, offset: 0, limit: 500 },
    results: [
      {
        project_num: '5R01MH134466-02',
        project_title: 'Neural mechanisms of psilocybin-assisted therapy',
        abstract_text: 'This project examines psilocybin...',
        fiscal_year: 2026,
        award_amount: 745123,
        organization: { org_name: 'JOHNS HOPKINS UNIVERSITY' },
        agency_ic_admin: { name: 'National Institute of Mental Health', abbreviation: 'NIMH' },
        principal_investigators: [{ full_name: 'Jane Q Researcher' }],
        project_start_date: '2025-04-01T00:00:00Z',
        project_end_date: '2028-03-31T00:00:00Z'
      },
      {
        // matched by loose text search but not substance-relevant -> filtered out
        project_num: '1R21DA059999-01',
        project_title: 'Anesthesia dosing protocols in surgery',
        abstract_text: 'Standard anesthesia protocols...',
        fiscal_year: 2026,
        award_amount: 210000,
        organization: { org_name: 'SOMEWHERE UNIVERSITY' },
        principal_investigators: [{ full_name: 'John Doe' }]
      }
    ]
  };

  it('maps grants and drops non-substance-relevant matches', async () => {
    const crawler = new GrantsCrawler();
    stubRequest(crawler, async () => reporterFixture);

    const result = await crawler.crawl();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);

    const grant = result.data![0];
    expect(grant.projectNumber).toBe('5R01MH134466-02');
    expect(grant.piNames).toEqual(['Jane Q Researcher']);
    expect(grant.agency).toBe('NIMH');
    expect(grant.awardAmount).toBe(745123);
    expect(grant.substances).toContain('Psilocybin');
    expect(grant.startDate).toBe('2025-04-01');
  });
});

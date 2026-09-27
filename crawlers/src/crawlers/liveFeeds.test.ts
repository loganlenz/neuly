import { describe, it, expect } from 'vitest';
import { NewsCrawler } from './NewsCrawler.js';
import { MarketCrawler, moveBucket, quoteMatchesCompany } from './MarketCrawler.js';
import { Company } from '../models/types.js';

/**
 * Fixture-based tests for the live feeds (news + market quotes). External
 * APIs are stubbed by overriding the crawler's request method.
 */

type Requestable = { request: (url: string, opts?: unknown) => Promise<unknown> };
function stubRequest(crawler: object, fn: (url: string, opts?: unknown) => Promise<unknown>): void {
  (crawler as unknown as Requestable).request = fn;
}

const company = (overrides: Partial<Company>): Company => ({
  id: 'comp_x',
  name: 'Example',
  type: 'Biotech',
  stage: 'Public',
  substances: [],
  crawledAt: '2026-09-27T00:00:00Z',
  ...overrides
});

const compass = company({ id: 'comp_compass', name: 'COMPASS Pathways', ticker: 'CMPS', cik: '1816590', substances: ['Psilocybin'] });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('NewsCrawler', () => {
  const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items}</channel></rss>`;
  const item = (title: string, publisher: string, date: Date) =>
    `<item><title>${title} - ${publisher}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(title)}</link>` +
    `<pubDate>${date.toUTCString()}</pubDate><source url="https://example.com">${publisher}</source></item>`;

  it('keeps sector headlines, strips the publisher suffix, and tags substances and companies', () => {
    const crawler = new NewsCrawler({ companies: [compass] });
    const items = crawler.parseGoogleNewsRss(rss(
      item('CMPS stock jumps after psilocybin trial readout', 'Stocktwits', daysAgo(1)) +
      item('Local bakery wins award', 'Gazette', daysAgo(1)) +
      item('COMPASS Pathways (CMPS) Stock Price, News, Quote &amp; History', 'Yahoo Finance', daysAgo(1)) +
      item('FDA hearing on psychedelic therapy', 'HCPLive', daysAgo(2))
    ), 'psilocybin');

    expect(items.map(i => i.title)).toEqual([
      'CMPS stock jumps after psilocybin trial readout',
      'FDA hearing on psychedelic therapy'
    ]);
    expect(items[0]).toMatchObject({
      publisher: 'Stocktwits',
      category: 'News',
      substances: ['Psilocybin'],
      companies: ['COMPASS Pathways'],
      source: 'Google News'
    });
  });

  it('drops items older than the retention window', () => {
    const crawler = new NewsCrawler({ maxAgeDays: 30 });
    const items = crawler.parseGoogleNewsRss(rss(item('Psilocybin retreat opens', 'Wire', daysAgo(45))), 'psilocybin');
    expect(items).toHaveLength(0);
  });

  it('collapses the same story reached by several queries into one id', async () => {
    const crawler = new NewsCrawler();
    const feed = rss(item('Oregon psilocybin fees rescinded', 'Marijuana Moment', daysAgo(1)));
    stubRequest(crawler, async () => feed);
    const result = await crawler.crawl();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  it('turns recent SEC filings into labelled feed items with document links', () => {
    const crawler = new NewsCrawler({ companies: [compass] });
    const recent = daysAgo(3).toISOString().slice(0, 10);
    const old = daysAgo(400).toISOString().slice(0, 10);
    const items = crawler.parseSecSubmissions({
      filings: {
        recent: {
          accessionNumber: ['0001816590-26-000059', '0001940258-26-000011', '0001816590-26-000001', '0001816590-25-000001'],
          form: ['8-K', '4', 'SC 14F1', '10-K'],
          filingDate: [recent, recent, recent, old],
          primaryDocument: ['cmps-8k.htm', 'xslF345X06/form4.xml', 'x.htm', 'cmps-10k.htm'],
          items: ['2.02,9.01', '', '', '']
        }
      }
    }, compass);

    expect(items.map(i => i.title)).toEqual([
      'COMPASS Pathways: Current report (8-K) — financial results',
      'COMPASS Pathways: Insider transaction (Form 4)'
    ]);
    expect(items[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1816590/000181659026000059/cmps-8k.htm');
    // XSL rendering prefix is stripped so the link opens the raw filing
    expect(items[1].url).toBe('https://www.sec.gov/Archives/edgar/data/1816590/000194025826000011/form4.xml');
    expect(items[0]).toMatchObject({ category: 'SEC Filing', companies: ['COMPASS Pathways'], substances: ['Psilocybin'] });
  });
});

describe('MarketCrawler', () => {
  const chart = (name: string, price: number, closes: number[], tradedAt = Date.now()) => ({
    chart: {
      result: [{
        meta: { longName: name, currency: 'USD', fullExchangeName: 'NasdaqGS', regularMarketPrice: price, regularMarketTime: Math.floor(tradedAt / 1000) },
        timestamp: closes.map((_, i) => Math.floor(daysAgo(closes.length - i).getTime() / 1000)),
        indicators: { quote: [{ close: closes }] }
      }]
    }
  });

  it('buckets daily moves so only threshold crossings register as changes', () => {
    expect(moveBucket(2.4)).toBe('flat');
    expect(moveBucket(-6)).toBe('down 5%+');
    expect(moveBucket(12)).toBe('up 10%+');
    expect(moveBucket(25)).toBe('up 20%+');
    expect(moveBucket(undefined)).toBe('flat');
  });

  it('matches listings to companies by distinctive name words only', () => {
    expect(quoteMatchesCompany('COMPASS Pathways plc', compass)).toBe(true);
    expect(quoteMatchesCompany('AtaiBeckley Inc.', company({ name: 'Atai Life Sciences' }))).toBe(true);
    expect(quoteMatchesCompany('Definium Therapeutics, Inc.', company({ name: 'MindMed', legalName: 'Definium Therapeutics, Inc.' }))).toBe(true);
    // Recycled ticker: NUMI now belongs to an unrelated ETF
    expect(quoteMatchesCompany('Nuveen Municipal Income ETF', company({ name: 'Numinus Wellness' }))).toBe(false);
    // Generic words alone never prove a match
    expect(quoteMatchesCompany('Other Therapeutics Inc', company({ name: 'Seelos Therapeutics' }))).toBe(false);
  });

  it('quotes matching listings, derives the day change, and skips recycled or stale tickers', async () => {
    const crawler = new MarketCrawler({
      companies: [
        compass,
        company({ id: 'comp_numi', name: 'Numinus Wellness', ticker: 'NUMI' }),
        company({ id: 'comp_seel', name: 'Seelos Therapeutics', ticker: 'SEEL' })
      ]
    });
    stubRequest(crawler, async (url) => {
      if (url.includes('company_tickers')) return { 0: { cik_str: 1816590, ticker: 'CMPS', title: 'COMPASS Pathways plc' } };
      if (url.includes('CMPS')) return chart('COMPASS Pathways plc', 11, [9, 10, 11]);
      if (url.includes('NUMI')) return chart('Nuveen Municipal Income ETF', 23, [23, 23]);
      return chart('Seelos Therapeutics Inc', 0.5, [0.5, 0.5], daysAgo(30).getTime());
    });

    const result = await crawler.crawl();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data![0]).toMatchObject({
      id: 'quote_cmps',
      ticker: 'CMPS',
      companyId: 'comp_compass',
      price: 11,
      previousClose: 10,
      change: 1,
      changePercent: 10,
      moveBucket: 'up 10%+'
    });
    expect(result.data![0].history).toHaveLength(3);
    expect(result.errors?.some(e => e.includes('NUMI') && e.includes('does not match'))).toBe(true);
    expect(result.errors?.some(e => e.includes('SEEL') && e.includes('stale'))).toBe(true);
  });

  it('follows the SEC ticker after a rename', async () => {
    const crawler = new MarketCrawler({
      companies: [company({ name: 'MindMed', legalName: 'Definium Therapeutics, Inc.', ticker: 'MNMD', cik: '1813814' })]
    });
    const requested: string[] = [];
    stubRequest(crawler, async (url) => {
      requested.push(url);
      if (url.includes('company_tickers')) return { 0: { cik_str: 1813814, ticker: 'DFTX', title: 'Definium Therapeutics, Inc.' } };
      return chart('Definium Therapeutics, Inc.', 36, [35, 36]);
    });
    const result = await crawler.crawl();
    expect(requested.some(u => u.includes('/DFTX'))).toBe(true);
    expect(result.data![0].ticker).toBe('DFTX');
  });
});

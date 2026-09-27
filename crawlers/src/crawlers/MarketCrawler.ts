import { BaseCrawler, CrawlResult } from '../core/BaseCrawler.js';
import { Company, MarketQuote, MarketQuoteSchema } from '../models/types.js';
import { logger } from '../utils/logger.js';

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        currency?: string;
        fullExchangeName?: string;
        exchangeName?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketVolume?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        regularMarketTime?: number;
        longName?: string;
        shortName?: string;
      };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
    error?: { description?: string } | null;
  };
}

export interface MarketCrawlerOptions {
  companies?: Company[];
}

/** SEC bulk ticker file entry (https://www.sec.gov/files/company_tickers.json) */
interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Quotes older than this are from a halted/delisted listing, not the live market */
const MAX_QUOTE_AGE_DAYS = 10;

/** Words too generic to prove a quote belongs to a company */
const GENERIC_NAME_WORDS = new Set([
  'inc', 'corp', 'corporation', 'ltd', 'limited', 'plc', 'llc', 'the', 'and', 'group', 'holdings', 'company',
  'therapeutics', 'sciences', 'science', 'life', 'health', 'healthcare', 'pharma', 'pharmaceuticals', 'biosciences',
  'bio', 'biotech', 'medicine', 'medicines', 'medical', 'wellness', 'innovations', 'scientific', 'research', 'global'
]);

function nameTokens(name: string | undefined): string[] {
  return (name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
}

/**
 * Tickers get recycled: after a rename or delisting the old symbol can
 * belong to an unrelated issuer (NUMI went from Numinus to a Nuveen ETF).
 * A quote is only attributed to a company when the listing's name shares a
 * distinctive word with the company's name or legal name.
 */
export function quoteMatchesCompany(listingName: string | undefined, company: Pick<Company, 'name' | 'legalName'>): boolean {
  const listing = nameTokens(listingName);
  if (listing.length === 0) return false;
  // Prefix match catches merged names ("AtaiBeckley" ↔ "Atai")
  return [...nameTokens(company.name), ...nameTokens(company.legalName)].some(token =>
    listing.some(word => word === token || (token.length >= 4 && word.startsWith(token)))
  );
}

/**
 * Bucket a daily move so the diff engine emits a change event when a stock
 * crosses a threshold (flat → up 10%+), not on every tick.
 */
export function moveBucket(changePercent: number | undefined): string {
  if (changePercent === undefined || !Number.isFinite(changePercent)) return 'flat';
  const magnitude = Math.abs(changePercent);
  const direction = changePercent >= 0 ? 'up' : 'down';
  if (magnitude >= 20) return `${direction} 20%+`;
  if (magnitude >= 10) return `${direction} 10%+`;
  if (magnitude >= 5) return `${direction} 5%+`;
  return 'flat';
}

/**
 * Market data for every publicly traded company in the companies table:
 * latest price, day change, range, volume and one month of daily closes.
 * Source: Yahoo Finance chart endpoint (no key, delayed quotes).
 */
export class MarketCrawler extends BaseCrawler<MarketQuote> {
  private companies: Company[];

  constructor(options: MarketCrawlerOptions = {}) {
    super({
      name: 'MarketCrawler',
      baseUrl: 'https://query1.finance.yahoo.com',
      rateLimit: 4,
      concurrency: 3,
      retries: 2,
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeulyResearch/1.0; +https://neuly.io)' }
    });
    this.companies = options.companies ?? [];
  }

  async crawl(): Promise<CrawlResult<MarketQuote>> {
    const startTime = Date.now();
    const errors: string[] = [];
    const listed = uniqueByTicker(await this.resolveTickers());

    const results = await Promise.all(listed.map(async company => {
      try {
        const response = await this.request<YahooChartResponse>(`/v8/finance/chart/${encodeURIComponent(company.ticker!)}`, {
          params: { range: '1mo', interval: '1d' }
        });
        const meta = response.chart?.result?.[0]?.meta;
        const listingName = meta?.longName || meta?.shortName;
        if (!quoteMatchesCompany(listingName, company)) {
          errors.push(`${company.ticker}: listing "${listingName ?? 'unknown'}" does not match ${company.name} — skipped`);
          return null;
        }
        if (meta?.regularMarketTime && Date.now() - meta.regularMarketTime * 1000 > MAX_QUOTE_AGE_DAYS * 86_400_000) {
          errors.push(`${company.ticker}: last trade ${new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10)} — stale listing skipped`);
          return null;
        }
        const quote = this.validate(this.transform({ response, company }));
        if (!quote) errors.push(`${company.ticker}: no quote data`);
        return quote;
      } catch (error) {
        errors.push(`${company.ticker} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return null;
      }
    }));

    const quotes = results.filter((q): q is MarketQuote => q !== null);
    logger.info(`[MarketCrawler] ${quotes.length}/${listed.length} tickers quoted`);

    // Delisted or renamed tickers fail individually; that is expected noise
    // as long as the rest of the market came back.
    return {
      success: quotes.length > 0 || listed.length === 0,
      data: quotes,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: listed.length,
        successful: quotes.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * The SEC's CIK → ticker map is authoritative after renames (MindMed →
   * DFTX), so any company with a CIK trades under whatever symbol the SEC
   * lists today; companies without one keep their stored ticker (OTC and
   * foreign listings).
   */
  private async resolveTickers(): Promise<Company[]> {
    const byCik = new Map<number, SecTickerEntry>();
    try {
      const data = await this.request<Record<string, SecTickerEntry>>('https://www.sec.gov/files/company_tickers.json', {
        headers: { 'User-Agent': 'Neuly Research contact@neuly.io' }
      });
      for (const entry of Object.values(data)) {
        if (!byCik.has(entry.cik_str)) byCik.set(entry.cik_str, entry);
      }
    } catch (error) {
      logger.warn(`[MarketCrawler] SEC ticker map unavailable, using stored tickers: ${error instanceof Error ? error.message : error}`);
    }

    const resolved: Company[] = [];
    for (const company of this.companies) {
      const sec = company.cik ? byCik.get(parseInt(company.cik, 10)) : undefined;
      const ticker = sec?.ticker || company.ticker;
      if (ticker) resolved.push({ ...company, ticker });
    }
    return resolved;
  }

  transform(input: unknown): Partial<MarketQuote> {
    const { response, company } = input as { response: YahooChartResponse; company: Company };
    const result = response.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return {};

    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const history = (result?.timestamp ?? [])
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter((p): p is { date: string; close: number } => typeof p.close === 'number')
      .map(p => ({ date: p.date, close: round(p.close) }));

    // The last close before today's session is the true previous close;
    // chartPreviousClose is the close before the whole 1-month window.
    const previousClose = history.length >= 2 ? history[history.length - 2].close : meta.previousClose ?? meta.chartPreviousClose;
    const change = previousClose !== undefined ? meta.regularMarketPrice - previousClose : undefined;
    const changePercent = previousClose ? (change! / previousClose) * 100 : undefined;

    return {
      id: this.generateId('quote', company.ticker!),
      ticker: company.ticker!.toUpperCase(),
      companyId: company.id,
      companyName: company.name,
      exchange: meta.fullExchangeName || meta.exchangeName,
      currency: meta.currency,
      price: round(meta.regularMarketPrice),
      previousClose: previousClose !== undefined ? round(previousClose) : undefined,
      change: change !== undefined ? round(change) : undefined,
      changePercent: changePercent !== undefined ? round(changePercent) : undefined,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      volume: meta.regularMarketVolume,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      moveBucket: moveBucket(changePercent),
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : undefined,
      history,
      source: 'Yahoo Finance',
      crawledAt: this.getTimestamp()
    };
  }

  validate(data: unknown): MarketQuote | null {
    const result = MarketQuoteSchema.safeParse(data);
    return result.success ? result.data : null;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function uniqueByTicker(companies: Company[]): Company[] {
  const seen = new Map<string, Company>();
  for (const company of companies) {
    const key = company.ticker!.toUpperCase();
    if (!seen.has(key)) seen.set(key, company);
  }
  return Array.from(seen.values());
}

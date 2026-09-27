import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import { Company, NewsItem, NewsItemSchema } from '../models/types.js';
import { detectSubstances } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  source?: string | { '#text'?: string };
}

interface SecSubmissions {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
      primaryDocDescription?: string[];
      items?: string[];
    };
  };
}

export interface NewsCrawlerOptions {
  /** Tracked companies: named in coverage queries and matched in headlines */
  companies?: Company[];
  /** Only keep items published within this many days (default 120) */
  maxAgeDays?: number;
}

/** Topic searches run every crawl, independent of the companies table */
export const NEWS_TOPIC_QUERIES = [
  'psilocybin',
  'psychedelic therapy',
  'psychedelic medicine',
  'MDMA-assisted therapy',
  'ketamine therapy',
  'esketamine Spravato',
  'ibogaine',
  'LSD therapy',
  '5-MeO-DMT',
  'DMT depression',
  'ayahuasca',
  'psychedelic FDA',
  'psychedelic legislation',
  'psilocybin legalization',
  'natural medicine Colorado',
  'Oregon psilocybin services',
  'DEA psilocybin rescheduling',
  'psychedelic stocks',
  'psychedelic biotech funding',
  'kratom regulation'
];

/** SEC forms worth surfacing as industry news, with a readable label */
const SEC_FORM_LABELS: Record<string, string> = {
  '8-K': 'Current report (8-K)',
  '6-K': 'Foreign issuer report (6-K)',
  '10-Q': 'Quarterly report (10-Q)',
  '10-K': 'Annual report (10-K)',
  '20-F': 'Annual report (20-F)',
  '40-F': 'Annual report (40-F)',
  'S-1': 'IPO / registration (S-1)',
  'F-1': 'IPO / registration (F-1)',
  'S-3': 'Shelf registration (S-3)',
  'S-3ASR': 'Shelf registration (S-3ASR)',
  'F-3': 'Shelf registration (F-3)',
  '424B5': 'Offering prospectus (424B5)',
  '424B4': 'Offering prospectus (424B4)',
  '4': 'Insider transaction (Form 4)',
  'SC 13D': 'Activist stake (13D)',
  'SC 13G': 'Major holder stake (13G)',
  'SCHEDULE 13D': 'Activist stake (13D)',
  'SCHEDULE 13G': 'Major holder stake (13G)',
  'DEF 14A': 'Proxy statement (DEF 14A)'
};

/** 8-K item codes → what actually happened */
const EIGHT_K_ITEMS: Record<string, string> = {
  '1.01': 'material agreement',
  '1.02': 'agreement terminated',
  '2.01': 'acquisition / disposition',
  '2.02': 'financial results',
  '2.05': 'restructuring',
  '3.01': 'listing notice',
  '3.02': 'unregistered equity sale',
  '4.01': 'auditor change',
  '5.02': 'leadership change',
  '5.07': 'shareholder vote',
  '7.01': 'Reg FD disclosure',
  '8.01': 'other material event'
};

/** Auto-generated quote pages, not news ("XYZ Stock Price, News, Quote & History") */
const QUOTE_PAGE = /stock price, news, quote|stock quote,? price and forecast|stock price (today|quote)\b|\bquote & history\b/i;

const PSYCHEDELIC_HEADLINE = /psychedelic|hallucinogen|entheogen|plant medicine|natural medicine|magic mushroom|microdos/i;

/**
 * Industry news crawler — the platform's fastest-moving feed.
 *
 * 1. Google News RSS (no key): topic searches across substances, regulation
 *    and capital markets, plus a search per tracked public company. Items are
 *    kept only when the headline is actually about the sector (names a
 *    substance, psychedelic medicine, or a tracked company).
 * 2. SEC EDGAR submissions (no key): every recent material filing — 8-K/6-K,
 *    periodic reports, offerings, insider trades, 13D/G stakes — by each
 *    tracked company with a resolved CIK.
 */
export class NewsCrawler extends BaseCrawler<NewsItem> {
  private companies: Company[];
  private maxAgeDays: number;
  private readonly xmlParser = new XMLParser({ ignoreAttributes: false, isArray: name => name === 'item' });

  constructor(options: NewsCrawlerOptions = {}) {
    super({
      name: 'NewsCrawler',
      baseUrl: '',
      rateLimit: 2,
      concurrency: 2,
      retries: 2,
      timeout: 20000,
      headers: {
        // SEC requires a descriptive User-Agent with contact info
        'User-Agent': 'Neuly Research contact@neuly.io',
        'Accept': 'application/json, application/rss+xml, application/xml, text/xml, */*'
      }
    });
    this.companies = options.companies ?? [];
    this.maxAgeDays = options.maxAgeDays ?? 120;
  }

  async crawl(): Promise<CrawlResult<NewsItem>> {
    const startTime = Date.now();
    const items: NewsItem[] = [];
    const errors: string[] = [];

    const publicCompanies = this.companies.filter(c => c.ticker || c.stage === 'Public');
    const companyQueries = publicCompanies.map(c => `"${c.name}"`);
    const queries = [...NEWS_TOPIC_QUERIES, ...companyQueries];

    const newsResults = await Promise.all(queries.map(async query => {
      try {
        return await this.searchGoogleNews(query);
      } catch (error) {
        errors.push(`Google News "${query}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return [];
      }
    }));
    for (const batch of newsResults) items.push(...batch);
    logger.info(`[NewsCrawler] Google News: ${items.length} relevant items from ${queries.length} queries`);

    const filers = await this.withCiks(this.companies);
    const filingResults = await Promise.all(filers.map(async company => {
      try {
        return await this.recentSecFilings(company);
      } catch (error) {
        errors.push(`SEC filings for ${company.name} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return [];
      }
    }));
    const filingCount = filingResults.reduce((n, batch) => n + batch.length, 0);
    for (const batch of filingResults) items.push(...batch);
    logger.info(`[NewsCrawler] SEC EDGAR: ${filingCount} filings from ${filers.length} companies`);

    const unique = Array.from(new Map(items.map(item => [item.id, item])).values())
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

    // Individual feeds failing (a throttled query, a delisted filer) is
    // normal at this cadence; the crawl only fails when nothing came back.
    return {
      success: unique.length > 0 || errors.length === 0,
      data: unique,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: unique.length + errors.length,
        successful: unique.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /** Google News RSS search, restricted to the last week for freshness */
  private async searchGoogleNews(query: string): Promise<NewsItem[]> {
    const xml = await this.request<string>('https://news.google.com/rss/search', {
      params: { q: `${query} when:7d`, hl: 'en-US', gl: 'US', ceid: 'US:en' },
      responseType: 'text'
    });
    return this.parseGoogleNewsRss(xml, query);
  }

  /** Parse a Google News RSS document into relevant news items */
  parseGoogleNewsRss(xml: string, query: string): NewsItem[] {
    const parsed = this.xmlParser.parse(xml) as { rss?: { channel?: { item?: RssItem[] } } };
    const items: NewsItem[] = [];

    for (const raw of parsed.rss?.channel?.item ?? []) {
      const transformed = this.transform({ raw, query });
      if (!transformed.title || !this.isRelevant(transformed)) continue;
      const validated = this.validate(transformed);
      if (validated && this.isRecent(validated.publishedAt)) items.push(validated);
    }
    return items;
  }

  transform(input: unknown): Partial<NewsItem> {
    const { raw, query } = input as { raw: RssItem; query: string };
    const publisher = typeof raw.source === 'string' ? raw.source : raw.source?.['#text'];
    let title = cleanText(String(raw.title ?? '')) || '';
    // Google appends " - Publisher" to every headline
    if (publisher && title.endsWith(` - ${publisher}`)) {
      title = title.slice(0, -(publisher.length + 3)).trim();
    }
    const publishedAt = raw.pubDate ? new Date(raw.pubDate) : null;
    const text = title;

    return {
      // Keyed on publisher + headline: the same story reached through several
      // queries collapses to one row, while other outlets' coverage stays.
      id: this.generateId('news', hash(`${publisher ?? ''}|${title.toLowerCase()}`)),
      title,
      url: raw.link,
      publisher,
      publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : undefined,
      category: 'News',
      substances: detectSubstances(text),
      companies: this.companiesIn(text),
      query,
      source: 'Google News',
      crawledAt: this.getTimestamp()
    };
  }

  /**
   * Companies with a CIK — stored, or resolved from their ticker through the
   * SEC's bulk ticker map — so filings flow even before the companies
   * crawler has enriched a record.
   */
  private async withCiks(companies: Company[]): Promise<Company[]> {
    const needLookup = companies.some(c => !c.cik && c.ticker);
    const byTicker = new Map<string, string>();
    if (needLookup) {
      try {
        const data = await this.request<Record<string, { cik_str: number; ticker: string }>>('https://www.sec.gov/files/company_tickers.json');
        for (const entry of Object.values(data)) byTicker.set(entry.ticker.toUpperCase(), String(entry.cik_str));
      } catch (error) {
        logger.warn(`[NewsCrawler] SEC ticker map unavailable: ${error instanceof Error ? error.message : error}`);
      }
    }
    const seen = new Set<string>();
    const filers: Company[] = [];
    for (const company of companies) {
      const cik = company.cik || (company.ticker ? byTicker.get(company.ticker.toUpperCase()) : undefined);
      if (!cik || seen.has(cik)) continue;
      seen.add(cik);
      filers.push({ ...company, cik });
    }
    return filers;
  }

  /** Recent material SEC filings for one tracked company */
  private async recentSecFilings(company: Company): Promise<NewsItem[]> {
    const cik = String(company.cik).replace(/\D/g, '').padStart(10, '0');
    const data = await this.request<SecSubmissions>(`https://data.sec.gov/submissions/CIK${cik}.json`);
    return this.parseSecSubmissions(data, company);
  }

  parseSecSubmissions(data: SecSubmissions, company: Company): NewsItem[] {
    const recent = data.filings?.recent;
    if (!recent) return [];
    const cikInt = String(parseInt(String(company.cik), 10));
    const items: NewsItem[] = [];

    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i];
      const label = SEC_FORM_LABELS[form];
      if (!label) continue;
      const filedAt = recent.filingDate[i];
      if (!filedAt || !this.isRecent(filedAt)) continue;

      const accession = recent.accessionNumber[i];
      const doc = recent.primaryDocument[i];
      const url = doc
        ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession.replace(/-/g, '')}/${doc.replace(/^xsl[^/]+\//, '')}`
        : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikInt}`;
      const itemCodes = (recent.items?.[i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const events = itemCodes.map(code => EIGHT_K_ITEMS[code]).filter(Boolean);

      const validated = this.validate({
        id: this.generateId('news', `sec-${accession}`),
        title: `${company.name}: ${label}${events.length ? ` — ${events.join(', ')}` : ''}`,
        url,
        publisher: 'SEC EDGAR',
        publishedAt: new Date(`${filedAt}T00:00:00Z`).toISOString(),
        summary: recent.primaryDocDescription?.[i] || undefined,
        category: 'SEC Filing',
        substances: company.substances ?? [],
        companies: [company.name],
        query: form,
        source: 'SEC EDGAR',
        crawledAt: this.getTimestamp()
      });
      if (validated) items.push(validated);
    }
    return items;
  }

  /** A headline belongs in the feed when it is about the sector itself */
  private isRelevant(item: Partial<NewsItem>): boolean {
    const title = item.title ?? '';
    if (QUOTE_PAGE.test(title)) return false;
    return (item.substances?.length ?? 0) > 0
      || (item.companies?.length ?? 0) > 0
      || PSYCHEDELIC_HEADLINE.test(title);
  }

  /** Tracked companies named in text: word-bounded names (≥4 chars) or tickers */
  private companiesIn(text: string): string[] {
    const found: string[] = [];
    for (const company of this.companies) {
      const names = [company.name, company.legalName].filter((n): n is string => Boolean(n && n.length >= 4));
      const byName = names.some(name => new RegExp(`\\b${escapeRegex(stripSuffix(name))}\\b`, 'i').test(text));
      // Tickers match case-sensitively ("CMPS stock"), never inside words
      const byTicker = Boolean(company.ticker && company.ticker.length >= 3
        && new RegExp(`(^|[^A-Za-z])\\$?${escapeRegex(company.ticker.toUpperCase())}([^A-Za-z]|$)`).test(text));
      if (byName || byTicker) {
        found.push(company.name);
      }
    }
    return found;
  }

  private isRecent(date: string): boolean {
    const time = new Date(date).getTime();
    return Number.isFinite(time) && Date.now() - time <= this.maxAgeDays * 86_400_000;
  }

  validate(data: unknown): NewsItem | null {
    const result = NewsItemSchema.safeParse(data);
    if (!result.success) {
      logger.debug(`[NewsCrawler] Validation failed: ${result.error.message}`);
      return null;
    }
    return result.data;
  }
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "Cybin Inc." → "Cybin" so headlines that drop the suffix still match */
function stripSuffix(name: string): string {
  const stripped = name.replace(/[,.]?\s+(inc|corp|corporation|ltd|limited|plc|llc|co|sa|ag|nv|se)\.?$/i, '').trim();
  return stripped.length >= 4 ? stripped : name;
}

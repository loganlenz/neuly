import * as cheerio from 'cheerio';
import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import { Company, Person } from '../models/types.js';
import { normalizePersonName } from './PeopleCrawler.js';
import { logger } from '../utils/logger.js';

/**
 * Leadership from company websites.
 *
 * SEC filings cover public companies; Form D covers private companies that
 * raised money. The rest — and the full management team beyond Section 16
 * officers — is published by the companies themselves on their team /
 * leadership / about pages. This source finds that page from the homepage
 * navigation and extracts (name, title, headshot) triples from the common
 * card layouts: an image, a heading with the name, and a short line with
 * the title, all inside one container.
 */

export interface TeamMember {
  name: string;
  title: string;
  imageUrl?: string;
  pageUrl: string;
}

const TEAM_LINK = /\b(team|leadership|management|our[- ]people|people|about[- ]us|about|board|executives?|founders?|who[- ]we[- ]are)\b/i;
const TITLE_WORDS = /\b(chief|officer|ceo|cfo|coo|cmo|cso|cto|cbo|cco|clo|president|vice president|vp\b|svp|evp|director|head of|founder|co-founder|chair|chairman|chairwoman|chairperson|partner|principal|scientist|counsel|manager|lead|advisor|adviser|board member|fellow|physician|psychiatrist|psychologist|pharmacologist|professor|investigator|engineer|controller|treasurer|secretary|associate|analyst|coordinator)\b/i;
const NOT_TITLE = /\b(read more|learn more|linkedin|email|bio|close|view|contact|press|news|careers?|jobs?)\b/i;
/** Headlines, podcast episodes and interview teasers are not job titles */
const HEADLINE = /podcast|interview|episode|questions with|webinar|\||[?!]|\b(on|about|how|why)\b.*\b(the|a)\b/i;
const NAME_PARTICLES = new Set(['de', 'van', 'von', 'der', 'den', 'da', 'di', 'la', 'le', 'du', 'del', 'della', 'bin', 'al', 'y', 'e']);
const NAME_STOPWORDS = /^(on|with|and|the|at|for|in|of|to|from|by|our|your|new|meet|team|about|five|ten|top|commission|securities|committee|board|advisory|leadership|management|executive|scientific|medical|clinical)$/i;

/** "Chief Executive Officer" passes the generic name check; it is a title */
const TITLE_LINE = /^(chief|vice|senior|head|director|president|founder|co-founder|board|managing|executive|general|chair|interim|associate|principal|global)\b|\b(officer|director|president|founder|co-founder|manager|chair|chairman|counsel|scientist|advisor|adviser|partner|lead|head)$/i;

/** Stricter than normalizePersonName: every word capitalised (or a particle), no connector words, not a job title */
function looksLikeName(raw: string): string {
  if (TITLE_LINE.test(raw.trim())) return '';
  const name = normalizePersonName(raw);
  if (!name) return '';
  const words = name.split(' ');
  if (words.some(w => NAME_STOPWORDS.test(w))) return '';
  if (!words.every(w => NAME_PARTICLES.has(w.toLowerCase()) || /^[A-Z\u00C0-\u024F]/.test(w))) return '';
  return name;
}

export class TeamPageSource extends BaseCrawler<Person> {
  constructor() {
    super({
      name: 'TeamPages',
      baseUrl: '',
      rateLimit: 1,
      concurrency: 2,
      retries: 1,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeulyBot/1.0; +https://neuly.io; research@neuly.io)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
  }

  /** Team members for one company, or [] when no team page could be found */
  async fetchTeam(company: Pick<Company, 'name' | 'website'>): Promise<TeamMember[]> {
    if (!company.website) return [];
    let home: string;
    try {
      home = await this.request<string>(company.website, { responseType: 'text', transformResponse: [d => d], maxRedirects: 5 });
    } catch (error) {
      logger.debug(`[TeamPages] ${company.name}: homepage failed (${error instanceof Error ? error.message : error})`);
      return [];
    }
    const candidates = this.teamPageCandidates(home, company.website);
    // The homepage itself sometimes carries the team section
    const pages = [...candidates, company.website].slice(0, 4);
    for (const url of pages) {
      try {
        const html = url === company.website ? home : await this.request<string>(url, { responseType: 'text', transformResponse: [d => d], maxRedirects: 5 });
        const members = this.extractTeam(html, url);
        if (members.length >= 2) return members;
      } catch (error) {
        logger.debug(`[TeamPages] ${company.name}: ${url} failed (${error instanceof Error ? error.message : error})`);
      }
    }
    return [];
  }

  /** Links from the homepage that look like a team / leadership page, best first */
  teamPageCandidates(html: string, baseUrl: string): string[] {
    const $ = cheerio.load(html);
    const scored = new Map<string, number>();
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      const text = `${$(el).text()} ${href}`;
      if (!TEAM_LINK.test(text)) return;
      if (/\.(pdf|jpg|png)$/i.test(href) || /^(mailto|tel|javascript):/i.test(href)) return;
      let absolute: string;
      try { absolute = new URL(href, baseUrl).toString(); } catch { return; }
      if (new URL(absolute).hostname !== new URL(baseUrl).hostname) return;
      const score = /leadership|management|team|executives?/i.test(href) ? 3 : /leadership|management|team/i.test($(el).text()) ? 2 : 1;
      scored.set(absolute.split('#')[0], Math.max(scored.get(absolute) ?? 0, score));
    });
    return Array.from(scored.entries()).sort((a, b) => b[1] - a[1]).map(([url]) => url);
  }

  /**
   * Extract members from a page. Exported for tests. Strategy: every heading-
   * like element whose text is a plausible person name, paired with the
   * first title-looking text that follows it inside the same card, plus the
   * nearest image in that card.
   */
  extractTeam(html: string, pageUrl: string): TeamMember[] {
    const $ = cheerio.load(html);
    $('script, style, noscript, nav, footer, header, svg').remove();
    const members = new Map<string, TeamMember>();

    $('h1, h2, h3, h4, h5, h6, strong, b, [class*="name"], [class*="Name"], [class*="title"], [class*="Title"]').each((_i, el) => {
      const raw = cleanText(ownText($, el));
      if (!raw || raw.length > 60) return;
      const name = looksLikeName(raw);
      if (!name || members.has(name.toLowerCase())) return;

      // Walk up to the smallest container that reads like one card
      let card = $(el).parent();
      for (let depth = 0; depth < 5; depth++) {
        const next = card.parent();
        if (!next.length || next.is('body') || next.is('html')) break;
        const nextLines = blockLines($, next[0]);
        if (nextLines.length > 14 || nextLines.join(' ').length > 700) break;
        // Stop before the container that holds other people's cards too
        if (nextLines.filter(l => looksLikeName(l) && l !== raw).length > 0) break;
        card = next;
      }
      const lines = blockLines($, card[0]);
      const nameIdx = lines.findIndex(l => l.includes(raw));
      // The title sits on the lines right after the name — and before the
      // next person's name when several members share one container.
      const after: string[] = [];
      for (const line of nameIdx >= 0 ? lines.slice(nameIdx + 1, nameIdx + 4) : lines) {
        if (looksLikeName(line)) break;
        after.push(line);
      }
      const title = after.find(t => t.length >= 3 && t.length <= 70 && TITLE_WORDS.test(t) && !NOT_TITLE.test(t) && !HEADLINE.test(t));
      if (!title) return;

      const img = card.find('img').first();
      const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || (img.attr('srcset') || '').split(',')[0]?.trim().split(' ')[0];
      let imageUrl: string | undefined;
      if (src && !/\.svg$|logo|icon|placeholder|blank|spacer|data:image\/gif/i.test(src)) {
        try { imageUrl = new URL(src, pageUrl).toString(); } catch { imageUrl = undefined; }
      }
      members.set(name.toLowerCase(), { name, title: title.replace(/^[,:;\-\s]+/, '').trim(), imageUrl, pageUrl });
    });

    return Array.from(members.values()).slice(0, 60);
  }

  async crawl(): Promise<CrawlResult<Person>> {
    throw new Error('TeamPageSource is used through PeopleCrawler');
  }
  transform(rawData: unknown): Partial<Person> { return rawData as Partial<Person>; }
  validate(): Person | null { return null; }
}

/** Text of an element's own inline content (block children excluded) */
function ownText($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): string {
  const node = $(el);
  if (node.children().filter((_i, c) => BLOCK.has((c as { tagName?: string }).tagName ?? '')).length === 0) return node.text();
  return node.contents().filter((_i, c) => c.type === 'text' || !BLOCK.has((c as { tagName?: string }).tagName ?? '')).text();
}

const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'section', 'article', 'figure', 'figcaption', 'table', 'tr', 'td', 'th', 'br', 'span', 'a', 'small', 'em', 'i']);

/**
 * Text of a subtree as separate lines, one per element boundary, so
 * "<h3>Jane Doe</h3><p>Chief Executive Officer</p>" never collapses into
 * "Jane DoeChief Executive Officer".
 */
function blockLines($: cheerio.CheerioAPI, root: Parameters<cheerio.CheerioAPI>[0]): string[] {
  const lines: string[] = [];
  const walk = (node: Parameters<cheerio.CheerioAPI>[0]) => {
    for (const child of $(node).contents().toArray()) {
      if (child.type === 'text') {
        const text = cleanText((child as { data?: string }).data || '');
        if (text) lines.push(text);
      } else if (child.type === 'tag') {
        walk(child);
      }
    }
  };
  walk(root);
  return lines;
}

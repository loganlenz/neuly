import { XMLParser } from 'fast-xml-parser';
import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import { Company, Person } from '../models/types.js';
import { logger } from '../utils/logger.js';

/**
 * Officers and directors of public companies, straight from the SEC.
 *
 * Every insider of an SEC-reporting company must file ownership reports
 * (Forms 3, 4 and 5). Each filing is structured XML naming the reporting
 * owner and their relationship to the issuer — director, officer (with the
 * officer title), ten-percent owner. Pulling the recent ownership filings
 * for every tracked company therefore yields its current leadership and
 * board with provenance, refreshed as insiders trade, with no scraping of
 * company websites or LinkedIn.
 */

interface OwnershipDocument {
  ownershipDocument?: {
    documentType?: string;
    periodOfReport?: string;
    issuer?: { issuerCik?: string; issuerName?: string; issuerTradingSymbol?: string };
    reportingOwner?: Array<{
      reportingOwnerId?: { rptOwnerCik?: string; rptOwnerName?: string };
      reportingOwnerRelationship?: {
        isDirector?: string | number | boolean;
        isOfficer?: string | number | boolean;
        isTenPercentOwner?: string | number | boolean;
        isOther?: string | number | boolean;
        officerTitle?: string;
        otherText?: string;
      };
    }>;
  };
}

interface SecSubmissions {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
    };
  };
}

export interface Insider {
  /** Display name, "First Last" */
  name: string;
  ownerCik?: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  officerTitle?: string;
  /** Most recent filing date observed */
  asOf: string;
  formType: string;
  accessionNumber: string;
  issuerName: string;
}

export interface SecInsidersOptions {
  /** Ownership filings inspected per company (most recent first) */
  maxFilingsPerCompany?: number;
  /** Ignore filings older than this many days (default 730) */
  maxAgeDays?: number;
}

const OWNERSHIP_FORMS = new Set(['3', '3/A', '4', '4/A', '5', '5/A']);
const ENTITY_NAME = /\b(inc|llc|l\.?p\.?|ltd|limited|corp|corporation|plc|trust|fund|partners|capital|holdings?|management|advisors?|ventures?|group|associates|foundation|company|co\.|gmbh|sa|ag|bv|nv)\b/i;

const flag = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/**
 * SEC stores individual filer names as "LAST FIRST MIDDLE" (no comma).
 * Reorder to the display form and title-case the shouting.
 */
export function displayNameFromSec(raw: string): string {
  let text = cleanText(raw) || '';
  if (!text) return '';
  if (text.includes(',')) {
    const [last, rest] = text.split(',').map(s => s.trim());
    text = `${rest} ${last}`.trim();
  } else {
    const parts = text.split(' ').filter(Boolean);
    if (parts.length >= 2 && parts.length <= 4) {
      text = [...parts.slice(1), parts[0]].join(' ');
    }
  }
  // Keep already mixed-case names; title-case all-caps ones
  if (text === text.toUpperCase()) {
    text = text.toLowerCase().replace(/(^|[\s'\-])([a-z])/g, (_m, sep, ch) => `${sep}${ch.toUpperCase()}`)
      .replace(/\bMc([a-z])/g, (_m, ch) => `Mc${ch.toUpperCase()}`);
  }
  // Collapse stray initials punctuation
  return text.replace(/\s+/g, ' ').trim();
}

export class SecInsidersSource extends BaseCrawler<Person> {
  private readonly xml = new XMLParser({ ignoreAttributes: true, isArray: name => name === 'reportingOwner' });
  private readonly options: Required<SecInsidersOptions>;

  constructor(options: SecInsidersOptions = {}) {
    super({
      name: 'SEC Insiders',
      baseUrl: 'https://www.sec.gov',
      rateLimit: 4,
      concurrency: 2,
      retries: 2,
      timeout: 30000,
      headers: {
        'User-Agent': 'Neuly Research contact@neuly.io',
        'Accept': 'application/json, application/xml, text/xml, */*'
      }
    });
    this.options = { maxFilingsPerCompany: options.maxFilingsPerCompany ?? 12, maxAgeDays: options.maxAgeDays ?? 730 };
  }

  /** Current insiders of one company, deduplicated by owner (latest filing wins) */
  async fetchInsiders(company: Company): Promise<Insider[]> {
    if (!company.cik) return [];
    const cik = company.cik.replace(/^0+/, '').padStart(10, '0');
    const sub = await this.request<SecSubmissions>(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const recent = sub.filings?.recent;
    if (!recent) return [];

    const cutoff = new Date(Date.now() - this.options.maxAgeDays * 86400000).toISOString().slice(0, 10);
    const picks: Array<{ accession: string; doc: string; date: string; form: string }> = [];
    for (let i = 0; i < recent.form.length && picks.length < this.options.maxFilingsPerCompany; i++) {
      if (!OWNERSHIP_FORMS.has(recent.form[i])) continue;
      if (recent.filingDate[i] < cutoff) break; // list is newest-first
      const doc = recent.primaryDocument?.[i];
      if (!doc || !/\.xml$/i.test(doc)) continue;
      picks.push({ accession: recent.accessionNumber[i], doc, date: recent.filingDate[i], form: recent.form[i] });
    }

    const byOwner = new Map<string, Insider>();
    for (const pick of picks) {
      try {
        // The primary document is the rendered view (xslF345X06/...). The raw
        // XML sits at the same path without the stylesheet folder.
        const rawDoc = pick.doc.replace(/^xsl[^/]*\//i, '');
        const url = `/Archives/edgar/data/${Number(cik)}/${pick.accession.replace(/-/g, '')}/${rawDoc}`;
        const xml = await this.request<string>(url, { responseType: 'text', transformResponse: [d => d] });
        for (const insider of this.parseOwnership(xml, pick.form, pick.accession, pick.date)) {
          const key = insider.ownerCik ?? insider.name.toLowerCase();
          const prior = byOwner.get(key);
          if (!prior || insider.asOf > prior.asOf) byOwner.set(key, insider);
        }
      } catch (error) {
        logger.debug(`[SEC Insiders] ${company.name} ${pick.accession}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return Array.from(byOwner.values());
  }

  /** Parse one ownership XML document into insiders (exported for tests) */
  parseOwnership(xml: string, formType: string, accessionNumber: string, filingDate: string): Insider[] {
    let doc: OwnershipDocument;
    try {
      doc = this.xml.parse(xml) as OwnershipDocument;
    } catch {
      return [];
    }
    const root = doc.ownershipDocument;
    if (!root) return [];
    const issuerName = cleanText(root.issuer?.issuerName) || '';
    const asOf = parseDate(root.periodOfReport) || parseDate(filingDate) || filingDate;

    const insiders: Insider[] = [];
    for (const owner of root.reportingOwner ?? []) {
      const rawName = owner.reportingOwnerId?.rptOwnerName;
      if (!rawName) continue;
      const rel = owner.reportingOwnerRelationship ?? {};
      const isDirector = flag(rel.isDirector);
      const isOfficer = flag(rel.isOfficer);
      const isTenPercentOwner = flag(rel.isTenPercentOwner);
      // Funds and holding vehicles report as ten-percent owners; people are what we want
      if (ENTITY_NAME.test(rawName) && !isOfficer && !isDirector) continue;
      const name = displayNameFromSec(rawName);
      if (!name || name.split(' ').length < 2) continue;
      insiders.push({
        name,
        ownerCik: owner.reportingOwnerId?.rptOwnerCik ? String(owner.reportingOwnerId.rptOwnerCik).padStart(10, '0') : undefined,
        isDirector,
        isOfficer,
        isTenPercentOwner,
        officerTitle: cleanText(rel.officerTitle) || (rel.otherText ? cleanText(rel.otherText) : undefined),
        asOf,
        formType,
        accessionNumber,
        issuerName
      });
    }
    return insiders;
  }

  async crawl(): Promise<CrawlResult<Person>> {
    throw new Error('SecInsidersSource is used through PeopleCrawler');
  }

  transform(rawData: unknown): Partial<Person> {
    return rawData as Partial<Person>;
  }

  validate(): Person | null {
    return null;
  }
}

/** Human title for an insider: officer title, else board/ownership role */
export function insiderTitle(insider: Pick<Insider, 'isDirector' | 'isOfficer' | 'isTenPercentOwner' | 'officerTitle'>): string {
  const parts: string[] = [];
  if (insider.isOfficer && insider.officerTitle) parts.push(insider.officerTitle.replace(/\bsee remarks\b/i, 'Officer'));
  else if (insider.isOfficer) parts.push('Officer');
  if (insider.isDirector) parts.push(parts.length ? 'Director' : 'Board Director');
  if (parts.length === 0 && insider.isTenPercentOwner) parts.push('10% Owner');
  return parts.join(' & ') || 'Insider';
}

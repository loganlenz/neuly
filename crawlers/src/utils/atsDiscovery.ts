import axios, { AxiosInstance } from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from './logger.js';

export type AtsProvider = 'greenhouse' | 'lever' | 'ashby' | 'workable';

export interface AtsBoard {
  provider: AtsProvider;
  slug: string;
  company: string;
  url: string;
  jobCount: number;
  discoveredAt: string;
}

interface DiscoveryCache {
  boards: AtsBoard[];
  /** companyKey -> ISO timestamp of last unsuccessful probe */
  misses: Record<string, string>;
}

const MISS_RETRY_DAYS = 7;
/** Write the discovery cache after this many probed companies */
const SAVE_EVERY = 10;

/** Corporate suffixes that ATS slugs usually drop */
const NAME_SUFFIXES = [
  'inc', 'incorporated', 'corp', 'corporation', 'ltd', 'limited', 'plc', 'co',
  'life sciences', 'lifesciences', 'therapeutics', 'biosciences', 'bioscience',
  'pharmaceuticals', 'pharma', 'wellness', 'health', 'mental health', 'medicine',
  'group', 'holdings', 'labs', 'sciences'
];

/**
 * Generate plausible ATS board slugs for a company name.
 * E.g. "COMPASS Pathways" -> ["compasspathways", "compass-pathways", "compass"]
 * and "Atai Life Sciences" -> ["atailifesciences", "atai-life-sciences", "atai"]
 */
export function slugCandidates(companyName: string): string[] {
  const base = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!base) return [];

  // Progressively strip corporate suffixes: "numinus wellness" -> "numinus"
  let stripped = base;
  let didStrip = true;
  while (didStrip) {
    didStrip = false;
    for (const suffix of NAME_SUFFIXES) {
      if (stripped.endsWith(` ${suffix}`)) {
        stripped = stripped.slice(0, -suffix.length - 1).trim();
        didStrip = true;
      }
    }
  }

  const variants = new Set<string>();
  for (const name of [base, stripped]) {
    variants.add(name.replace(/[\s-]+/g, ''));
    variants.add(name.replace(/\s+/g, '-'));
  }
  variants.add(base.split(' ')[0]);

  return Array.from(variants).filter(slug => slug.length >= 3);
}

/**
 * Probes public ATS APIs (Greenhouse, Lever, Ashby, Workable) to discover
 * job boards for a list of companies. Hits and misses are cached on disk so
 * repeat runs only re-probe stale misses.
 */
export class AtsDiscovery {
  private client: AxiosInstance;
  private cachePath: string;
  private requestDelayMs: number;
  private rateLimited = new Set<AtsProvider>();

  constructor(options: { cacheDir?: string; requestDelayMs?: number } = {}) {
    this.cachePath = join(options.cacheDir ?? join(process.cwd(), 'data'), 'ats_boards.json');
    this.requestDelayMs = options.requestDelayMs ?? 500;
    this.client = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': 'Neuly Research Crawler/1.0 (https://neuly.io; research@neuly.io)',
        'Accept': 'application/json'
      },
      // Probing: 404s are expected, don't throw on them
      validateStatus: status => status === 200 || status === 404
    });
  }

  /**
   * Return all known boards for the given companies, probing for
   * companies that aren't in the cache (or whose misses have gone stale).
   */
  async discover(companyNames: string[]): Promise<AtsBoard[]> {
    const cache = this.loadCache();
    const knownCompanies = new Set(cache.boards.map(b => companyKey(b.company)));
    const now = Date.now();
    let probed = 0;

    for (const name of companyNames) {
      const key = companyKey(name);
      if (knownCompanies.has(key)) continue;
      const lastMiss = cache.misses[key];
      if (lastMiss && now - Date.parse(lastMiss) < MISS_RETRY_DAYS * 24 * 60 * 60 * 1000) {
        continue;
      }
      const boards = await this.probeCompany(name);
      if (boards.length > 0) {
        cache.boards.push(...boards);
        knownCompanies.add(key);
        delete cache.misses[key];
        logger.info(`[AtsDiscovery] Found ${boards.length} board(s) for ${name}: ${boards.map(b => `${b.provider}/${b.slug}`).join(', ')}`);
      } else {
        cache.misses[key] = new Date().toISOString();
        logger.debug(`[AtsDiscovery] No ATS board found for ${name}`);
      }
      // Persist as we go: a long first run over a hundred-plus companies must
      // not lose its work if the process is stopped part-way.
      if (++probed % SAVE_EVERY === 0) this.saveCache(cache);
    }
    this.saveCache(cache);
    return cache.boards;
  }

  /**
   * Probe one company: the four providers run in parallel, each walking the
   * slug candidates in order until one answers. A provider that rate-limits
   * us (429) is skipped for the rest of the run rather than hammered.
   */
  private async probeCompany(companyName: string): Promise<AtsBoard[]> {
    const candidates = slugCandidates(companyName);
    const providers: AtsProvider[] = ['greenhouse', 'lever', 'ashby', 'workable'];
    const results = await Promise.all(providers.map(async provider => {
      if (this.rateLimited.has(provider)) return null;
      for (const slug of candidates) {
        await this.delay(this.requestDelayMs);
        const board = await this.probe(provider, slug, companyName);
        if (board) return board;
        if (this.rateLimited.has(provider)) return null;
      }
      return null;
    }));
    return results.filter((b): b is AtsBoard => b !== null);
  }

  private async probe(provider: AtsProvider, slug: string, company: string): Promise<AtsBoard | null> {
    try {
      switch (provider) {
        case 'greenhouse': {
          const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
          const res = await this.client.get(url);
          if (res.status === 200 && Array.isArray(res.data?.jobs)) {
            return this.board(provider, slug, company, url, res.data.jobs.length);
          }
          return null;
        }
        case 'lever': {
          const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
          const res = await this.client.get(url);
          if (res.status === 200 && Array.isArray(res.data)) {
            return this.board(provider, slug, company, url, res.data.length);
          }
          return null;
        }
        case 'ashby': {
          const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
          const res = await this.client.get(url);
          if (res.status === 200 && Array.isArray(res.data?.jobs)) {
            return this.board(provider, slug, company, url, res.data.jobs.length);
          }
          return null;
        }
        case 'workable': {
          const url = `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
          const res = await this.client.get(url);
          if (res.status === 200 && Array.isArray(res.data?.jobs)) {
            return this.board(provider, slug, company, url, res.data.jobs.length);
          }
          return null;
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429 && !this.rateLimited.has(provider)) {
        this.rateLimited.add(provider);
        logger.warn(`[AtsDiscovery] ${provider} is rate limiting probes (429); skipping it for the rest of this run`);
      }
      logger.debug(`[AtsDiscovery] Probe failed for ${provider}/${slug}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  private board(provider: AtsProvider, slug: string, company: string, url: string, jobCount: number): AtsBoard {
    return { provider, slug, company, url, jobCount, discoveredAt: new Date().toISOString() };
  }

  private loadCache(): DiscoveryCache {
    if (existsSync(this.cachePath)) {
      try {
        return JSON.parse(readFileSync(this.cachePath, 'utf-8'));
      } catch {
        logger.warn('[AtsDiscovery] Could not parse ats_boards.json; starting fresh');
      }
    }
    return { boards: [], misses: {} };
  }

  private saveCache(cache: DiscoveryCache): void {
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

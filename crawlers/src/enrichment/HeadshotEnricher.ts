import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import { Person } from '../models/types.js';
import { logger } from '../utils/logger.js';

/**
 * Headshots for people without one, from sources we may actually use:
 *
 *  1. Wikidata / Wikimedia Commons — notable researchers, founders and
 *     executives have a Wikidata item whose image (P18) is a freely licensed
 *     Commons file. The lookup is verified: the item must be a human whose
 *     description fits the person's role, so "John Smith" never picks up a
 *     footballer.
 *  2. Company team pages — already captured by the People crawler when it
 *     reads a company's leadership page (image next to the name).
 *
 * No LinkedIn, no Google Images, no scraping of social profiles.
 */

interface WikidataSearchHit {
  id: string;
  label?: string;
  description?: string;
}

interface WikidataEntity {
  claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
  descriptions?: Record<string, { value?: string }>;
}

const ROLE_HINTS: Record<string, RegExp> = {
  Researcher: /psycholog|psychiatr|neuro|pharmacolog|scientist|researcher|professor|physician|chemist|biolog|academic|anesthesi|medical|clinician|doctor/i,
  Clinician: /psychiatr|physician|clinician|doctor|psycholog|therapist|medical|anesthesi/i,
  Executive: /executive|businessperson|business|entrepreneur|chief|founder|ceo|investor|financier|pharmaceutical|biotech|company|manager|director/i,
  Investor: /investor|venture|financier|businessperson|entrepreneur|executive/i,
  Advocate: /activist|advocate|writer|author|founder|researcher|psychedelic|drug policy|philanthrop/i,
  Educator: /educator|teacher|professor|academic|author|writer|lecturer/i,
  Other: /psychedelic|psycholog|psychiatr|neuro|researcher|executive|entrepreneur|author|writer/i
};

export function commonsThumbnailUrl(fileName: string, width = 480): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName.replace(/ /g, '_'))}?width=${width}`;
}

/** Does a Wikidata description plausibly describe this person? Exported for tests. */
export function descriptionFits(person: Pick<Person, 'role' | 'organization' | 'expertise' | 'researchAreas'>, description: string | undefined): boolean {
  if (!description) return false;
  const d = description.toLowerCase();
  if (/psychedelic|psilocybin|mdma|ketamine|lsd|ayahuasca|ibogaine|entheogen/i.test(d)) return true;
  if (person.organization && d.includes(person.organization.toLowerCase().split(/[,(]/)[0].trim())) return true;
  const hint = ROLE_HINTS[person.role] ?? ROLE_HINTS.Other;
  return hint.test(d);
}

export interface HeadshotEnricherOptions {
  /** Max Wikidata lookups per run (default 250) */
  maxLookups?: number;
  /** Re-check people whose last lookup found nothing after this many days (default 60) */
  retryAfterDays?: number;
}

export class HeadshotEnricher extends BaseCrawler<Person> {
  private readonly options: Required<HeadshotEnricherOptions>;

  constructor(options: HeadshotEnricherOptions = {}) {
    super({
      name: 'Headshots',
      baseUrl: 'https://www.wikidata.org/w/api.php',
      rateLimit: 1, // Wikimedia asks for ≤1 req/s from unauthenticated bots
      concurrency: 1,
      retries: 2,
      timeout: 20000,
      headers: {
        'User-Agent': 'NeulyBot/1.0 (https://neuly.io; research@neuly.io)',
        'Accept': 'application/json'
      }
    });
    this.options = { maxLookups: options.maxLookups ?? Number(process.env.HEADSHOT_LOOKUPS_PER_RUN ?? 250), retryAfterDays: options.retryAfterDays ?? 60 };
  }

  /** People that gained an image this run (only these are upserted) */
  async enrich(people: Person[]): Promise<Person[]> {
    const cutoff = new Date(Date.now() - this.options.retryAfterDays * 86400000).toISOString();
    const due = people
      .filter(p => !p.imageUrl)
      .filter(p => {
        const checked = (p as Person & { imageCheckedAt?: string }).imageCheckedAt;
        return !checked || checked < cutoff;
      })
      // Curated and well-evidenced people first: most likely to be on Wikidata
      .sort((a, b) => score(b) - score(a))
      .slice(0, this.options.maxLookups);

    const updated: Person[] = [];
    let found = 0;
    for (const person of due) {
      try {
        const hit = await this.lookup(person);
        const stamped = { ...person, imageCheckedAt: new Date().toISOString() } as Person;
        if (hit) {
          found++;
          updated.push({ ...stamped, imageUrl: hit.url, imageSource: 'Wikimedia Commons', imageAttribution: `${hit.fileName} (Wikidata ${hit.qid})` });
        } else {
          updated.push(stamped);
        }
      } catch (error) {
        logger.debug(`[Headshots] ${person.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    logger.info(`[Headshots] ${due.length} people checked, ${found} headshots found`);
    return updated;
  }

  /** Wikidata search → verified human with an image */
  async lookup(person: Person): Promise<{ url: string; fileName: string; qid: string } | null> {
    const search = await this.request<{ search?: WikidataSearchHit[] }>('', {
      params: { action: 'wbsearchentities', search: person.name.replace(/^(dr|prof|professor)\.?\s+/i, ''), language: 'en', type: 'item', limit: 5, format: 'json' }
    });
    const hits = (search.search ?? []).filter(h => descriptionFits(person, h.description));
    if (hits.length === 0) return null;

    const entities = await this.request<{ entities?: Record<string, WikidataEntity> }>('', {
      params: { action: 'wbgetentities', ids: hits.map(h => h.id).join('|'), props: 'claims|descriptions', languages: 'en', format: 'json' }
    });
    for (const hit of hits) {
      const entity = entities.entities?.[hit.id];
      const instanceOf = entity?.claims?.P31?.map(c => (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id) ?? [];
      if (!instanceOf.includes('Q5')) continue; // must be a human
      const image = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (typeof image !== 'string' || !image) continue;
      return { url: commonsThumbnailUrl(image), fileName: image, qid: hit.id };
    }
    return null;
  }

  async crawl(): Promise<CrawlResult<Person>> {
    throw new Error('HeadshotEnricher runs through the orchestrator');
  }
  transform(rawData: unknown): Partial<Person> { return rawData as Partial<Person>; }
  validate(): Person | null { return null; }
}

function score(p: Person): number {
  let n = 0;
  if (p.source === 'Curated' || p.source?.includes('Curated')) n += 100;
  if (p.role === 'Executive') n += 20;
  n += Math.min(30, (p.publications?.count ?? 0) / 10);
  n += Math.min(10, (p.evidence?.length ?? 0));
  if (p.bio) n += 5;
  return n + (cleanText(p.name)?.length ? 0 : -100);
}

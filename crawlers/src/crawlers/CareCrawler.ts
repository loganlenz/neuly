import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import { CareProvider, CareProviderSchema } from '../models/types.js';
import { logger } from '../utils/logger.js';

/**
 * A record from Oregon Psilocybin Services' public licensee directory.
 * Field names vary between releases of the directory app, so every
 * candidate key is tried.
 */
type OregonLicenseeRecord = Record<string, unknown>;

interface CuratedProvider {
  name: string;
  type: CareProvider['type'];
  substances: CareProvider['substances'];
  services?: string[];
  city?: string;
  state?: string;
  country: string;
  website: string;
  acceptsInsurance?: boolean;
  description?: string;
}

/**
 * Care provider crawler.
 *
 * Licensed rows come from state regulators that publish their licensee
 * directories — today Oregon Psilocybin Services (the endpoint can be
 * overridden with OREGON_PSILOCYBIN_API). A curated list of established
 * clinics, telehealth platforms and training-affiliated centers rounds out
 * the directory; those rows are flagged `verified: false` unless a license
 * record confirms them, so the UI can tell the two apart.
 */
export class CareCrawler extends BaseCrawler<CareProvider> {
  /** Oregon Psilocybin Services public directory (consenting licensees) */
  private static readonly OREGON_ENDPOINTS = [
    process.env.OREGON_PSILOCYBIN_API,
    'https://psilocybin.oregon.gov/api/public/ApprovedLicenses/GetConsentingLicenses',
    'https://psilocybin.oregon.gov/api/ApprovedLicenses/GetConsentingLicenses'
  ].filter((u): u is string => Boolean(u));

  private static readonly OREGON_DIRECTORY_URL = 'https://psilocybin.oregon.gov/license-directory';

  /**
   * Established providers with public websites. Kept deliberately short and
   * limited to organisations that operate openly under existing law
   * (ketamine clinics, telehealth, state-regulated psilocybin programs,
   * research centers) — not an endorsement.
   */
  private static readonly CURATED: CuratedProvider[] = [
    { name: 'Mindbloom', type: 'Telehealth', substances: ['Ketamine'], services: ['At-home ketamine therapy', 'Integration coaching'], country: 'United States', website: 'https://mindbloom.com', acceptsInsurance: false, description: 'Guided at-home ketamine therapy with licensed clinicians.' },
    { name: 'Journey Clinical', type: 'Telehealth', substances: ['Ketamine'], services: ['Ketamine-assisted psychotherapy (via partner therapists)'], city: 'New York', state: 'NY', country: 'United States', website: 'https://journeyclinical.com', description: 'Medical platform enabling licensed therapists to offer ketamine-assisted psychotherapy.' },
    { name: 'Numinus Wellness', type: 'Clinic', substances: ['Ketamine', 'Psilocybin', 'MDMA'], services: ['Ketamine-assisted therapy', 'Clinical trials', 'Practitioner training'], city: 'Vancouver', state: 'BC', country: 'Canada', website: 'https://numinus.com', description: 'Clinic network offering ketamine-assisted therapy and hosting psychedelic clinical trials.' },
    { name: 'Field Trip Health', type: 'Clinic', substances: ['Ketamine'], services: ['Ketamine-assisted therapy'], city: 'Toronto', state: 'ON', country: 'Canada', website: 'https://fieldtriphealth.com', description: 'Ketamine-assisted therapy clinics in North America.' },
    { name: 'Nushama', type: 'Clinic', substances: ['Ketamine'], services: ['Ketamine infusion therapy', 'Integration'], city: 'New York', state: 'NY', country: 'United States', website: 'https://nushama.com', description: 'Ketamine wellness center in Manhattan.' },
    { name: 'Ketamine Wellness Centers', type: 'Clinic', substances: ['Ketamine'], services: ['Ketamine infusion therapy'], city: 'Phoenix', state: 'AZ', country: 'United States', website: 'https://ketaminewellnesscenters.com', description: 'Multi-state network of ketamine infusion clinics.' },
    { name: 'Actify Neurotherapies', type: 'Clinic', substances: ['Ketamine'], services: ['Ketamine infusion therapy', 'Spravato (esketamine)'], city: 'Denver', state: 'CO', country: 'United States', website: 'https://actifyneuro.com', acceptsInsurance: true, description: 'Ketamine and esketamine treatment centers.' },
    { name: 'Sage Integrative Health', type: 'Clinic', substances: ['Ketamine'], services: ['Ketamine-assisted psychotherapy', 'Integration groups'], city: 'Berkeley', state: 'CA', country: 'United States', website: 'https://sageintegrativehealth.org', description: 'Integrative psychiatry and ketamine-assisted psychotherapy practice.' },
    { name: 'Synthesis Institute (Oregon)', type: 'Research Center', substances: ['Psilocybin'], services: ['Facilitator training'], state: 'OR', country: 'United States', website: 'https://www.synthesisinstitute.com', description: 'Psilocybin facilitator training program approved in Oregon.' },
    { name: 'InnerTrek', type: 'Research Center', substances: ['Psilocybin'], services: ['Oregon facilitator training'], city: 'Portland', state: 'OR', country: 'United States', website: 'https://innertrek.org', description: 'Oregon-licensed psilocybin facilitator training program.' },
    { name: 'Beond Ibogaine', type: 'Retreat', substances: ['Ibogaine'], services: ['Medically supervised ibogaine treatment'], city: 'Cancún', country: 'Mexico', website: 'https://beondibogaine.com', description: 'Medically supervised ibogaine treatment center.' },
    { name: 'Ambio Life Sciences', type: 'Retreat', substances: ['Ibogaine'], services: ['Ibogaine treatment', 'Veteran programs'], city: 'Tijuana', country: 'Mexico', website: 'https://ambio.life', description: 'Ibogaine treatment programs with published outcomes research.' },
    { name: 'Imperial College Centre for Psychedelic Research', type: 'Research Center', substances: ['Psilocybin', 'DMT', 'LSD'], services: ['Clinical trials'], city: 'London', country: 'United Kingdom', website: 'https://www.imperial.ac.uk/psychedelic-research-centre', description: 'Academic psychedelic research center running clinical studies.' },
    { name: 'Johns Hopkins Center for Psychedelic and Consciousness Research', type: 'Research Center', substances: ['Psilocybin'], services: ['Clinical trials'], city: 'Baltimore', state: 'MD', country: 'United States', website: 'https://hopkinspsychedelic.org', description: 'Academic center studying psilocybin for depression, addiction and existential distress.' },
    { name: 'Usona Institute', type: 'Research Center', substances: ['Psilocybin'], services: ['Clinical trials'], city: 'Madison', state: 'WI', country: 'United States', website: 'https://usonainstitute.org', description: 'Non-profit medical research organization running psilocybin trials.' },
    { name: 'Awakn Clinics', type: 'Clinic', substances: ['Ketamine'], services: ['Ketamine-assisted therapy for addiction'], city: 'Bristol', country: 'United Kingdom', website: 'https://awaknlifesciences.com', description: 'Ketamine-assisted psychotherapy clinics focused on alcohol use disorder.' }
  ];

  private readonly skipRemote: boolean;

  constructor(options: { skipRemote?: boolean } = {}) {
    super({
      name: 'CareCrawler',
      baseUrl: '',
      rateLimit: 2,
      concurrency: 1,
      retries: 2,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Neuly Research Platform (research@neuly.io)'
      }
    });
    this.skipRemote = options.skipRemote ?? false;
  }

  async crawl(_query?: string): Promise<CrawlResult<CareProvider>> {
    const startTime = Date.now();
    const errors: string[] = [];
    const providers = new Map<string, CareProvider>();

    // 1. State-licensed service centers
    if (this.skipRemote) {
      logger.debug('[CareCrawler] skipRemote set — curated providers only');
    } else try {
      const licensed = await this.crawlOregon();
      for (const p of licensed) providers.set(p.id, p);
      logger.info(`[CareCrawler] Oregon Psilocybin Services: ${licensed.length} licensed service centers`);
    } catch (error) {
      // The directory is a JavaScript app whose backing API is not always
      // reachable from servers; a miss is logged, not fatal, and the
      // curated rows still ship.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`[CareCrawler] Oregon licensee directory unavailable: ${msg}`);
      errors.push(`Oregon licensee directory unavailable: ${msg}`);
    }

    // 2. Curated providers
    for (const curated of CareCrawler.CURATED) {
      const record: Partial<CareProvider> = {
        id: this.generateId('care', curated.name),
        name: curated.name,
        type: curated.type,
        substances: curated.substances,
        services: curated.services,
        location: { city: curated.city, state: curated.state, country: curated.country },
        website: curated.website,
        acceptsInsurance: curated.acceptsInsurance,
        verified: false,
        description: curated.description,
        source: 'Curated (public website)',
        sourceUrl: curated.website,
        crawledAt: this.getTimestamp()
      };
      const validated = this.validate(record);
      if (validated && !providers.has(validated.id)) providers.set(validated.id, validated);
    }

    return {
      // success=false with data still present: the orchestrator upserts the
      // rows but skips removal detection for this run.
      success: errors.length === 0,
      data: Array.from(providers.values()),
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: providers.size + errors.length,
        successful: providers.size,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /** Oregon Psilocybin Services consenting-licensee directory → service centers */
  private async crawlOregon(): Promise<CareProvider[]> {
    let records: OregonLicenseeRecord[] | undefined;
    let lastError: unknown;
    for (const endpoint of CareCrawler.OREGON_ENDPOINTS) {
      try {
        const response = await this.request<unknown>(endpoint, {
          headers: { Referer: CareCrawler.OREGON_DIRECTORY_URL }
        });
        records = extractRecords(response);
        if (records) break;
        lastError = new Error(`unexpected response shape from ${endpoint}`);
      } catch (error) {
        lastError = error;
      }
    }
    if (!records) throw lastError instanceof Error ? lastError : new Error('no endpoint answered');

    const providers: CareProvider[] = [];
    for (const record of records) {
      const provider = this.transformOregon(record);
      const validated = provider ? this.validate(provider) : null;
      if (validated) providers.push(validated);
    }
    return providers;
  }

  private transformOregon(record: OregonLicenseeRecord): Partial<CareProvider> | null {
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = record[key];
        if (value !== undefined && value !== null && String(value).trim()) return cleanText(String(value));
      }
      return undefined;
    };

    const licenseType = pick('licenseType', 'LicenseType', 'licenseTypeName', 'type');
    // Only service centers deliver care; manufacturers, labs and facilitators are skipped
    if (!licenseType || !/service\s*center/i.test(licenseType)) return null;

    const name = pick('businessName', 'BusinessName', 'tradeName', 'dbaName', 'licenseeName', 'LicenseeName', 'name', 'Name');
    if (!name) return null;
    const licenseNumber = pick('licenseNumber', 'LicenseNumber', 'licenseId', 'LicenseId');
    const website = normalizeUrl(pick('website', 'Website', 'webSite', 'url'));

    return {
      id: this.generateId('care', `or-${licenseNumber || name}`),
      name,
      type: 'Service Center',
      substances: ['Psilocybin'],
      services: ['Licensed psilocybin administration sessions'],
      location: {
        address: pick('address', 'Address', 'streetAddress', 'premisesAddress'),
        city: pick('city', 'City'),
        state: 'OR',
        country: 'United States'
      },
      website,
      phone: pick('phone', 'Phone', 'phoneNumber', 'PhoneNumber'),
      email: pick('email', 'Email', 'emailAddress'),
      licenseType: 'Oregon Psilocybin Service Center',
      licenseNumber,
      licenseStatus: pick('licenseStatus', 'LicenseStatus', 'status', 'Status') || 'Active',
      verified: true,
      source: 'Oregon Psilocybin Services licensee directory',
      sourceUrl: CareCrawler.OREGON_DIRECTORY_URL,
      crawledAt: this.getTimestamp()
    };
  }

  transform(rawData: unknown): Partial<CareProvider> {
    return rawData as Partial<CareProvider>;
  }

  validate(data: unknown): CareProvider | null {
    try {
      return CareProviderSchema.parse(data);
    } catch (error) {
      logger.warn(`[CareCrawler] Validation failed for ${(data as Partial<CareProvider>)?.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  static getCurated(): readonly CuratedProvider[] {
    return CareCrawler.CURATED;
  }
}

/** Directory responses are either a bare array or wrapped ({data|result|items: [...]}) */
function extractRecords(response: unknown): OregonLicenseeRecord[] | undefined {
  if (Array.isArray(response)) return response as OregonLicenseeRecord[];
  if (response && typeof response === 'object') {
    for (const key of ['data', 'result', 'results', 'items', 'licenses', 'value']) {
      const value = (response as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as OregonLicenseeRecord[];
    }
  }
  return undefined;
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

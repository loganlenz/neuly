import { BaseCrawler, CrawlResult, cleanText } from '../core/BaseCrawler.js';
import {
  Company,
  CompanySchema,
  ClinicalTrial,
  Substance
} from '../models/types.js';
import { detectSubstances } from '../utils/substances.js';
import { logger } from '../utils/logger.js';

/** SEC bulk ticker → CIK map (https://www.sec.gov/files/company_tickers.json) */
interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** https://data.sec.gov/submissions/CIK##########.json */
interface SecSubmissions {
  cik?: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  stateOfIncorporation?: string;
  fiscalYearEnd?: string;
  website?: string;
  addresses?: {
    business?: { city?: string; stateOrCountry?: string; stateOrCountryDescription?: string };
  };
  filings?: {
    recent?: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
      primaryDocDescription?: string[];
    };
  };
}

/** EDGAR full-text search (https://efts.sec.gov/LATEST/search-index) */
interface EftsResponse {
  hits?: { total?: { value?: number } };
  aggregations?: {
    entity_filter?: { buckets?: Array<{ key: string; doc_count: number }> };
  };
}

interface KnownCompany {
  name: string;
  legalName?: string;
  ticker?: string;
  type: Company['type'];
  stage: Company['stage'];
  substances: Substance[];
  focus?: string;
  website?: string;
}

export interface CompanyCrawlerOptions {
  /** Stored clinical trials: industry sponsors become companies */
  trials?: ClinicalTrial[];
  /** Skip EDGAR full-text discovery (tests / offline) */
  skipDiscovery?: boolean;
}

interface Candidate {
  name: string;
  cik?: string;
  ticker?: string;
  source: string;
  evidence: string[];
  substances: Substance[];
  type?: Company['type'];
  stage?: Company['stage'];
  focus?: string;
  website?: string;
  legalName?: string;
}

/** SIC codes that mean "this filer is a drug, device, healthcare or research company" */
const HEALTH_SIC = new Set([
  '2833', '2834', '2835', '2836', '3841', '3845', '5047', '5122', '5912',
  '8000', '8011', '8049', '8050', '8051', '8060', '8062', '8071', '8082', '8090', '8093',
  '8731', '8732', '8734'
]);

/** Filer names that are vehicles, not operating companies */
const VEHICLE_NAME = /acquisition\s+corp|\bspac\b|\btrust\b|\betf\b|\bfunds?\b|series solutions|\bspv\b|master partnership|\bl\.?p\.?$|capital corp|holdings? ii\b|opportunit(y|ies) fund|\bventures? (fund|i{1,3})\b/i;

const LEGAL_SUFFIX = /[,.]?\s*\b(inc|incorporated|corp|corporation|ltd|limited|plc|llc|pbc|n\.?v\.?|ag|gmbh|sa|s\.a\.|co|company|holdings?|group)\b\.?/gi;

/** Normalise a company name for matching across sources */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Company crawler.
 *
 * Three sources feed one dataset:
 *  1. A curated list of companies in the space (names, tickers, focus). Every
 *     public one is enriched from SEC EDGAR — the CIK is resolved from the
 *     SEC ticker file or an EDGAR entity search, never hard-coded.
 *  2. EDGAR full-text search: every SEC filer whose filings mention a tracked
 *     substance. Vehicles (SPACs, ETFs, trusts) and filers outside
 *     pharma/biotech/healthcare SIC codes are dropped.
 *  3. ClinicalTrials.gov: every industry lead sponsor of a tracked trial.
 *
 * Documentation: https://www.sec.gov/developer, https://efts.sec.gov/LATEST/search-index
 */
export class CompanyCrawler extends BaseCrawler<Company> {
  private static readonly KNOWN_COMPANIES: KnownCompany[] = [
    { name: 'COMPASS Pathways', ticker: 'CMPS', type: 'Biotech', stage: 'Public', substances: ['Psilocybin'], focus: 'Treatment-Resistant Depression', website: 'https://compasspathways.com' },
    { name: 'Atai Life Sciences', ticker: 'ATAI', type: 'Biotech', stage: 'Public', substances: ['Psilocybin', 'MDMA', 'Ketamine', 'DMT', 'Ibogaine', '5-MeO-DMT'], focus: 'Mental Health Platform', website: 'https://atai.life' },
    { name: 'MindMed', legalName: 'Mind Medicine (MindMed) Inc.', ticker: 'MNMD', type: 'Biotech', stage: 'Public', substances: ['LSD', 'MDMA', 'Psilocybin', 'DMT'], focus: 'Brain Health Medicines', website: 'https://mindmed.co' },
    { name: 'Cybin Inc', legalName: 'Cybin Inc.', ticker: 'CYBN', type: 'Biotech', stage: 'Public', substances: ['Psilocybin', 'DMT'], focus: 'Depression and Anxiety', website: 'https://cybin.com' },
    { name: 'Numinus Wellness', ticker: 'NUMI', type: 'Healthcare', stage: 'Public', substances: ['Psilocybin', 'MDMA', 'Ketamine'], focus: 'Mental Health Clinics', website: 'https://numinus.com' },
    { name: 'Awakn Life Sciences', ticker: 'AWKN', type: 'Biotech', stage: 'Public', substances: ['Ketamine', 'MDMA'], focus: 'Addiction Treatment', website: 'https://awaknlifesciences.com' },
    { name: 'Enveric Biosciences', ticker: 'ENVB', type: 'Biotech', stage: 'Public', substances: ['Psilocybin'], focus: 'Cancer-Related Distress', website: 'https://enveric.com' },
    { name: 'Tryp Therapeutics', ticker: 'TRYP', type: 'Biotech', stage: 'Public', substances: ['Psilocybin'], focus: 'Eating Disorders and Chronic Pain', website: 'https://tryptherapeutics.com' },
    { name: 'Lykos Therapeutics', type: 'Biotech', stage: 'Private', substances: ['MDMA'], focus: 'PTSD Treatment', website: 'https://lykospbc.com' },
    { name: 'Beckley Psytech', type: 'Biotech', stage: 'Private', substances: ['Psilocybin', '5-MeO-DMT'], focus: 'Depression and Addiction', website: 'https://beckleypsytech.com' },
    { name: 'Small Pharma', type: 'Biotech', stage: 'Private', substances: ['DMT'], focus: 'Major Depressive Disorder', website: 'https://smallpharma.com' },
    { name: 'Journey Clinical', type: 'Healthcare', stage: 'Private', substances: ['Ketamine'], focus: 'Ketamine-Assisted Therapy Platform', website: 'https://journeyclinical.com' },
    { name: 'GH Research', ticker: 'GHRS', type: 'Biotech', stage: 'Public', substances: ['5-MeO-DMT'], focus: 'Treatment-Resistant Depression', website: 'https://ghres.com' },
    { name: 'Relmada Therapeutics', ticker: 'RLMD', type: 'Biotech', stage: 'Public', substances: ['Ketamine'], focus: 'Major Depressive Disorder', website: 'https://relmada.com' },
    { name: 'Seelos Therapeutics', ticker: 'SEEL', type: 'Biotech', stage: 'Public', substances: ['Ketamine'], focus: 'Treatment-Resistant Depression and PTSD', website: 'https://seelostherapeutics.com' },
    { name: 'Bright Minds Biosciences', ticker: 'DRUG', type: 'Biotech', stage: 'Public', substances: ['Psilocybin', 'Other'], focus: 'Serotonin Agonists for Neuropsychiatry', website: 'https://brightmindsbio.com' },
    { name: 'Incannex Healthcare', ticker: 'IXHL', type: 'Biotech', stage: 'Public', substances: ['Psilocybin', 'Cannabis'], focus: 'Generalized Anxiety Disorder', website: 'https://incannex.com' },
    { name: 'Clearmind Medicine', ticker: 'CMND', type: 'Biotech', stage: 'Public', substances: ['Other'], focus: 'Alcohol Use Disorder', website: 'https://clearmindmedicine.com' },
    { name: 'Silo Pharma', ticker: 'SILO', type: 'Biotech', stage: 'Public', substances: ['Psilocybin', 'Ketamine'], focus: 'CNS and Rare Diseases', website: 'https://silopharma.com' },
    { name: 'PharmaTher Holdings', ticker: 'PHRRF', type: 'Pharma', stage: 'Public', substances: ['Ketamine'], focus: 'Specialty Ketamine and CNS', website: 'https://pharmather.com' },
    { name: 'Optimi Health', ticker: 'OPTHF', type: 'Pharma', stage: 'Public', substances: ['Psilocybin', 'MDMA'], focus: 'GMP Psychedelic Manufacturing', website: 'https://optimihealth.ca' },
    { name: 'Algernon Pharmaceuticals', ticker: 'AGNPF', type: 'Biotech', stage: 'Public', substances: ['DMT'], focus: 'Stroke Recovery', website: 'https://algernonpharmaceuticals.com' },
    { name: 'Mydecine Innovations Group', ticker: 'MYCOF', type: 'Biotech', stage: 'Public', substances: ['Psilocybin'], focus: 'Smoking Cessation and PTSD', website: 'https://mydecine.com' },
    { name: 'Braxia Scientific', ticker: 'BRAXF', type: 'Healthcare', stage: 'Public', substances: ['Ketamine'], focus: 'Ketamine Clinics and Research', website: 'https://braxiascientific.com' },
    { name: 'Psyence Biomedical', ticker: 'PBM', type: 'Biotech', stage: 'Public', substances: ['Psilocybin'], focus: 'Palliative Care Distress', website: 'https://psyencebiomed.com' },
    { name: 'Delix Therapeutics', type: 'Biotech', stage: 'Series B', substances: ['Other'], focus: 'Non-Hallucinogenic Psychoplastogens', website: 'https://delixtherapeutics.com' },
    { name: 'Gilgamesh Pharmaceuticals', type: 'Biotech', stage: 'Series B', substances: ['Psilocybin', 'DMT', 'Other'], focus: 'Novel Psychedelic-Inspired Medicines', website: 'https://gilgameshpharma.com' },
    { name: 'Transcend Therapeutics', type: 'Biotech', stage: 'Series A', substances: ['MDMA'], focus: 'PTSD (Methylone / TSND-201)', website: 'https://transcendtherapeutics.com' },
    { name: 'Terran Biosciences', type: 'Biotech', stage: 'Series A', substances: ['Psilocybin', 'MDMA', 'DMT'], focus: 'CNS Drug Development Platform', website: 'https://terranbio.com' },
    { name: 'Sensorium Therapeutics', type: 'Biotech', stage: 'Seed', substances: ['Other'], focus: 'Nature-Derived Neurotherapeutics', website: 'https://sensoriumtx.com' },
    { name: 'Freedom Biosciences', type: 'Biotech', stage: 'Seed', substances: ['Ketamine'], focus: 'Next-Generation Ketamine Therapeutics', website: 'https://freedombiosciences.com' },
    { name: 'Reunion Neuroscience', type: 'Biotech', stage: 'Private', substances: ['Psilocybin'], focus: 'Postpartum Depression', website: 'https://reunionneuro.com' },
    { name: 'Eleusis', type: 'Biotech', stage: 'Private', substances: ['LSD', 'Psilocybin'], focus: 'Psychedelics for Inflammation and Mental Health', website: 'https://eleusisltd.com' },
    { name: 'Journey Colab', type: 'Biotech', stage: 'Series A', substances: ['Mescaline'], focus: 'Addiction (Synthetic Mescaline)', website: 'https://journeycolab.com' },
    { name: 'Ceruvia Lifesciences', type: 'Biotech', stage: 'Private', substances: ['LSD', 'Psilocybin'], focus: 'Cluster Headache and OCD', website: 'https://ceruvia.com' },
    { name: 'Psilera', type: 'Biotech', stage: 'Seed', substances: ['DMT', 'Psilocybin'], focus: 'Neuroplastogen Drug Design', website: 'https://psilera.com' },
    { name: 'Usona Institute', type: 'Non-Profit', stage: 'Private', substances: ['Psilocybin'], focus: 'Major Depressive Disorder', website: 'https://usonainstitute.org' },
    { name: 'Mindbloom', type: 'Healthcare', stage: 'Private', substances: ['Ketamine'], focus: 'At-Home Ketamine Therapy', website: 'https://mindbloom.com' },
    { name: 'Osmind', type: 'Technology', stage: 'Series A', substances: ['Ketamine'], focus: 'EHR and Platform for Psychiatry Clinics', website: 'https://osmind.org' },
    { name: 'Fluence', type: 'Healthcare', stage: 'Private', substances: ['Psilocybin', 'MDMA', 'Ketamine'], focus: 'Psychedelic Therapy Training', website: 'https://fluencetraining.com' },
    { name: 'MAPS', legalName: 'Multidisciplinary Association for Psychedelic Studies', type: 'Non-Profit', stage: 'Private', substances: ['MDMA', 'Psilocybin', 'LSD', 'Ibogaine', 'Ayahuasca'], focus: 'Psychedelic Research and Policy', website: 'https://maps.org' },
    { name: 'Heffter Research Institute', type: 'Non-Profit', stage: 'Private', substances: ['Psilocybin'], focus: 'Funding Psilocybin Research', website: 'https://heffter.org' },
    { name: 'Beckley Foundation', type: 'Non-Profit', stage: 'Private', substances: ['LSD', 'Psilocybin', 'DMT'], focus: 'Psychedelic Science and Drug Policy Reform', website: 'https://beckleyfoundation.org' },
    // Plant and fungal medicines beyond the classic psychedelics
    { name: 'Filament Health', legalName: 'Filament Health Corp.', type: 'Pharma', stage: 'Public', substances: ['Psilocybin', 'Other'], focus: 'Botanical Psychedelic Drug Development', website: 'https://filament.health' },
    { name: 'Charlotte\'s Web', ticker: 'CWBHF', type: 'Pharma', stage: 'Public', substances: ['Cannabis'], focus: 'Hemp-Derived CBD Wellness', website: 'https://charlottesweb.com' },
    { name: 'Jazz Pharmaceuticals', ticker: 'JAZZ', type: 'Pharma', stage: 'Public', substances: ['Cannabis'], focus: 'Cannabinoid Epilepsy Medicines (Epidiolex)', website: 'https://jazzpharma.com' },
    { name: 'Tilray Brands', ticker: 'TLRY', type: 'Pharma', stage: 'Public', substances: ['Cannabis'], focus: 'Medical Cannabis', website: 'https://tilray.com' }
  ];

  /** Substance terms searched in EDGAR full-text discovery */
  private static readonly DISCOVERY_TERMS = [
    'psilocybin', 'psychedelic', 'MDMA', 'ibogaine', 'ayahuasca', '5-MeO-DMT',
    'ketamine-assisted', 'esketamine', 'kratom', 'kava', 'psilocin', 'dimethyltryptamine'
  ];

  /** How far back EDGAR full-text discovery looks */
  private static readonly DISCOVERY_YEARS = 3;

  /** Minimum filings mentioning a term before a filer is considered */
  private static readonly DISCOVERY_MIN_DOCS = 3;

  /** Cap on submissions lookups per run (rate-limit hygiene) */
  private static readonly DISCOVERY_MAX_LOOKUPS = 80;

  private readonly options: CompanyCrawlerOptions;
  private tickerMap: Map<string, SecTickerEntry> | null = null;
  private nameMap: Map<string, SecTickerEntry> | null = null;
  /** Discovery and enrichment both read submissions; fetch each CIK once per run */
  private submissionsCache = new Map<string, Promise<SecSubmissions>>();

  constructor(options: CompanyCrawlerOptions = {}) {
    super({
      name: 'SEC EDGAR',
      baseUrl: 'https://data.sec.gov',
      rateLimit: 5, // SEC allows 10/sec
      concurrency: 2,
      retries: 3,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        // SEC requires a User-Agent with contact info
        'User-Agent': 'Neuly Research Platform (research@neuly.io)'
      }
    });
    this.options = options;
  }

  async crawl(_query?: string): Promise<CrawlResult<Company>> {
    const startTime = Date.now();
    const errors: string[] = [];
    const candidates = new Map<string, Candidate>(); // key: normalized name

    // 1. Curated list
    for (const known of CompanyCrawler.KNOWN_COMPANIES) {
      candidates.set(normalizeCompanyName(known.name), {
        name: known.name,
        legalName: known.legalName,
        ticker: known.ticker,
        type: known.type,
        stage: known.stage,
        substances: known.substances,
        focus: known.focus,
        website: known.website,
        source: 'Curated',
        evidence: []
      });
    }

    // 2. Industry sponsors of tracked trials
    const sponsorCandidates = this.fromTrialSponsors(this.options.trials ?? []);
    for (const candidate of sponsorCandidates) {
      this.mergeCandidate(candidates, candidate);
    }
    if (sponsorCandidates.length > 0) {
      logger.info(`[SEC EDGAR] ${sponsorCandidates.length} industry sponsors from ClinicalTrials.gov`);
    }

    // 3. SEC filers whose filings mention tracked substances
    if (!this.options.skipDiscovery) {
      try {
        const discovered = await this.discoverFromEdgar(candidates);
        for (const candidate of discovered) {
          this.mergeCandidate(candidates, candidate);
        }
        logger.info(`[SEC EDGAR] ${discovered.length} filers discovered via full-text search`);
      } catch (error) {
        errors.push(`EDGAR discovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Resolve CIKs + enrich every candidate
    const companies: Company[] = [];
    for (const candidate of candidates.values()) {
      try {
        const company = await this.buildCompany(candidate);
        if (company) companies.push(company);
      } catch (error) {
        errors.push(`Failed to process ${candidate.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    logger.info(`[SEC EDGAR] ${companies.length} companies (${errors.length} errors)`);
    return {
      success: errors.length === 0,
      data: companies,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: companies.length + errors.length,
        successful: companies.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  // ------------------------------------------------------------------
  // Sources
  // ------------------------------------------------------------------

  /** Industry lead sponsors of stored trials, with the NCT ids as evidence */
  private fromTrialSponsors(trials: ClinicalTrial[]): Candidate[] {
    const bySponsor = new Map<string, { name: string; trials: ClinicalTrial[] }>();
    for (const trial of trials) {
      if (trial.sponsorClass !== 'INDUSTRY' || !trial.sponsor) continue;
      const key = normalizeCompanyName(trial.sponsor);
      if (!key) continue;
      const entry = bySponsor.get(key) ?? { name: cleanText(trial.sponsor) || trial.sponsor, trials: [] };
      entry.trials.push(trial);
      bySponsor.set(key, entry);
    }

    const candidates: Candidate[] = [];
    for (const { name, trials: sponsored } of bySponsor.values()) {
      const substances = Array.from(new Set(sponsored.flatMap(t => t.substances))) as Substance[];
      if (substances.length === 0) continue;
      const conditions = new Map<string, number>();
      for (const t of sponsored) for (const c of t.conditions) conditions.set(c, (conditions.get(c) ?? 0) + 1);
      const focus = Array.from(conditions.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
      candidates.push({
        name,
        substances,
        focus,
        type: 'Biotech',
        stage: 'Private',
        source: 'ClinicalTrials.gov sponsor',
        evidence: sponsored.map(t => `Sponsors ${t.nctId}`).slice(0, 25)
      });
    }
    return candidates;
  }

  /**
   * EDGAR full-text search per substance term. The entity aggregation
   * lists every filer with matching documents; filers outside health SIC
   * codes or that are investment vehicles are dropped after lookup.
   */
  private async discoverFromEdgar(existing: Map<string, Candidate>): Promise<Candidate[]> {
    const since = new Date();
    since.setFullYear(since.getFullYear() - CompanyCrawler.DISCOVERY_YEARS);
    const startdt = since.toISOString().slice(0, 10);

    const hits = new Map<string, { name: string; cik: string; ticker?: string; docs: number; terms: Set<string> }>();
    for (const term of CompanyCrawler.DISCOVERY_TERMS) {
      const response = await this.request<EftsResponse>('https://efts.sec.gov/LATEST/search-index', {
        params: {
          q: `"${term}"`,
          dateRange: 'custom',
          startdt,
          forms: '10-K,10-Q,8-K,6-K,20-F,40-F,S-1,F-1,1-A,DEF 14A,424B4'
        }
      });
      for (const bucket of response.aggregations?.entity_filter?.buckets ?? []) {
        const parsed = parseEntityKey(bucket.key);
        if (!parsed) continue;
        const entry = hits.get(parsed.cik) ?? { ...parsed, docs: 0, terms: new Set<string>() };
        entry.docs += bucket.doc_count;
        entry.terms.add(term);
        hits.set(parsed.cik, entry);
      }
    }

    const knownCiks = new Set<string>();
    for (const c of existing.values()) if (c.cik) knownCiks.add(c.cik);

    const ranked = Array.from(hits.values())
      .filter(h => h.docs >= CompanyCrawler.DISCOVERY_MIN_DOCS)
      .filter(h => !VEHICLE_NAME.test(h.name))
      .filter(h => !knownCiks.has(h.cik) && !existing.has(normalizeCompanyName(h.name)))
      .sort((a, b) => b.docs - a.docs)
      .slice(0, CompanyCrawler.DISCOVERY_MAX_LOOKUPS);

    const candidates: Candidate[] = [];
    for (const hit of ranked) {
      let submissions: SecSubmissions;
      try {
        submissions = await this.fetchSubmissions(hit.cik);
      } catch (error) {
        logger.debug(`[SEC EDGAR] submissions lookup failed for ${hit.name}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      if (!isHealthFiler(submissions)) continue;

      const terms = Array.from(hit.terms);
      const substances = detectSubstances(terms.join(' '));
      candidates.push({
        name: cleanDisplayName(submissions.name || hit.name),
        legalName: submissions.name,
        cik: hit.cik,
        ticker: submissions.tickers?.[0] || hit.ticker,
        substances: substances.length > 0 ? substances : ['Other'],
        type: typeFromSic(submissions.sic),
        stage: (submissions.tickers?.length || hit.ticker) ? 'Public' : 'Private',
        source: 'SEC EDGAR full-text search',
        evidence: [`${hit.docs} SEC filings since ${startdt} mention ${terms.join(', ')}`]
      });
    }
    return candidates;
  }

  private mergeCandidate(candidates: Map<string, Candidate>, incoming: Candidate): void {
    const key = normalizeCompanyName(incoming.name);
    if (!key) return;
    const current = candidates.get(key);
    if (!current) {
      candidates.set(key, incoming);
      return;
    }
    // Curated data wins on descriptive fields; evidence and substances union
    current.cik = current.cik || incoming.cik;
    current.ticker = current.ticker || incoming.ticker;
    current.focus = current.focus || incoming.focus;
    current.website = current.website || incoming.website;
    current.substances = Array.from(new Set([...current.substances, ...incoming.substances])) as Substance[];
    current.evidence = Array.from(new Set([...current.evidence, ...incoming.evidence]));
    if (current.source !== incoming.source) {
      current.source = `${current.source}; ${incoming.source}`;
    }
  }

  // ------------------------------------------------------------------
  // SEC EDGAR enrichment
  // ------------------------------------------------------------------

  private async buildCompany(candidate: Candidate): Promise<Company | null> {
    const cik = candidate.cik || await this.resolveCik(candidate).catch(() => undefined);

    let company: Partial<Company> = {
      id: this.generateId('co', candidate.name),
      name: candidate.name,
      legalName: candidate.legalName,
      type: candidate.type ?? 'Biotech',
      stage: candidate.stage ?? (cik ? 'Public' : 'Private'),
      ticker: candidate.ticker,
      substances: candidate.substances,
      focus: candidate.focus,
      website: candidate.website,
      source: candidate.source,
      evidence: candidate.evidence.length > 0 ? candidate.evidence : undefined,
      crawledAt: this.getTimestamp()
    };

    if (cik) {
      try {
        const submissions = await this.fetchSubmissions(cik);
        company = this.mergeSubmissions(company, cik, submissions);
      } catch (error) {
        logger.warn(`[SEC EDGAR] Could not fetch SEC data for ${candidate.name} (CIK ${cik}): ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return this.validate(company);
  }

  /**
   * Resolve a filer's CIK: SEC ticker file by ticker, then by exact
   * normalised name, then an EDGAR entity search on the name.
   */
  private async resolveCik(candidate: Candidate): Promise<string | undefined> {
    await this.loadTickerMap();
    if (candidate.ticker) {
      const byTicker = this.tickerMap!.get(candidate.ticker.toUpperCase());
      if (byTicker) return padCik(byTicker.cik_str);
    }
    for (const name of [candidate.legalName, candidate.name]) {
      if (!name) continue;
      const byName = this.nameMap!.get(normalizeCompanyName(name));
      if (byName) return padCik(byName.cik_str);
    }

    // Only look further for companies we expect to file with the SEC
    if (!candidate.ticker && candidate.stage !== 'Public') return undefined;

    const query = candidate.legalName || candidate.name;
    const response = await this.request<EftsResponse>('https://efts.sec.gov/LATEST/search-index', {
      params: { q: `"${query}"`, forms: '10-K,10-Q,8-K,6-K,20-F,40-F,S-1,F-1' }
    });
    const wanted = normalizeCompanyName(query);
    for (const bucket of response.aggregations?.entity_filter?.buckets ?? []) {
      const parsed = parseEntityKey(bucket.key);
      if (!parsed) continue;
      const got = normalizeCompanyName(parsed.name);
      if (got === wanted || got.startsWith(wanted) || wanted.startsWith(got)) {
        return parsed.cik;
      }
      if (candidate.ticker && parsed.ticker?.split(',').map(t => t.trim()).includes(candidate.ticker.toUpperCase())) {
        return parsed.cik;
      }
    }
    return undefined;
  }

  private async loadTickerMap(): Promise<void> {
    if (this.tickerMap) return;
    this.tickerMap = new Map();
    this.nameMap = new Map();
    try {
      const data = await this.request<Record<string, SecTickerEntry>>('https://www.sec.gov/files/company_tickers.json');
      for (const entry of Object.values(data)) {
        this.tickerMap.set(entry.ticker.toUpperCase(), entry);
        const key = normalizeCompanyName(entry.title);
        if (key && !this.nameMap.has(key)) this.nameMap.set(key, entry);
      }
      logger.debug(`[SEC EDGAR] Loaded ${this.tickerMap.size} tickers`);
    } catch (error) {
      logger.warn(`[SEC EDGAR] Could not load company_tickers.json: ${error instanceof Error ? error.message : error}`);
    }
  }

  private fetchSubmissions(cik: string): Promise<SecSubmissions> {
    const key = padCik(cik);
    let pending = this.submissionsCache.get(key);
    if (!pending) {
      pending = this.request<SecSubmissions>(`/submissions/CIK${key}.json`);
      pending.catch(() => this.submissionsCache.delete(key));
      this.submissionsCache.set(key, pending);
    }
    return pending;
  }

  private mergeSubmissions(company: Partial<Company>, cik: string, sub: SecSubmissions): Partial<Company> {
    const normalizedCik = padCik(cik);
    const filings: Company['secFilings'] = [];
    const recent = sub.filings?.recent;
    if (recent) {
      const relevantForms = new Set(['10-K', '10-Q', '8-K', '6-K', '20-F', '40-F', 'S-1', 'F-1', 'DEF 14A', 'D', 'D/A']);
      for (let i = 0; i < recent.form.length && filings.length < 25; i++) {
        if (!relevantForms.has(recent.form[i])) continue;
        const accNum = recent.accessionNumber[i].replace(/-/g, '');
        const doc = recent.primaryDocument?.[i];
        filings.push({
          type: recent.form[i],
          date: recent.filingDate[i],
          url: doc
            ? `https://www.sec.gov/Archives/edgar/data/${Number(normalizedCik)}/${accNum}/${doc}`
            : `https://www.sec.gov/Archives/edgar/data/${Number(normalizedCik)}/${accNum}/${recent.accessionNumber[i]}-index.htm`
        });
      }
    }

    const business = sub.addresses?.business;
    const website = company.website || normalizeWebsite(sub.website);

    return {
      ...company,
      legalName: sub.name || company.legalName,
      ticker: sub.tickers?.[0] || company.ticker,
      stockExchange: sub.exchanges?.[0] || undefined,
      stage: company.stage === 'Private' && (sub.tickers?.length ?? 0) > 0 ? 'Public' : company.stage,
      cik: normalizedCik,
      sic: sub.sic || undefined,
      sicDescription: sub.sicDescription || undefined,
      headquarters: business?.city
        ? {
            city: titleCase(business.city),
            state: business.stateOrCountry && US_STATE_CODES.has(business.stateOrCountry.toUpperCase()) ? business.stateOrCountry.toUpperCase() : undefined,
            country: countryFromSec(business.stateOrCountry, business.stateOrCountryDescription)
          }
        : company.headquarters,
      website,
      secFilings: filings.length > 0 ? filings : undefined
    };
  }

  transform(rawData: unknown): Partial<Company> {
    return rawData as Partial<Company>;
  }

  validate(data: unknown): Company | null {
    try {
      return CompanySchema.parse(data);
    } catch (error) {
      logger.warn(`[SEC EDGAR] Validation failed for ${(data as Partial<Company>)?.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  static getKnownTickers(): string[] {
    return CompanyCrawler.KNOWN_COMPANIES.filter(c => c.ticker).map(c => c.ticker!);
  }

  static getKnownCompanies(): readonly KnownCompany[] {
    return CompanyCrawler.KNOWN_COMPANIES;
  }
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function padCik(cik: string | number): string {
  return String(cik).replace(/^0+/, '').padStart(10, '0');
}

/** "COMPASS Pathways plc  (CMPS)  (CIK 0001816590)" → parts */
export function parseEntityKey(key: string): { name: string; cik: string; ticker?: string } | undefined {
  const cikMatch = key.match(/\(CIK\s*(\d+)\)/i);
  if (!cikMatch) return undefined;
  const withoutCik = key.replace(/\s*\(CIK\s*\d+\)\s*/i, '').trim();
  const tickerMatch = withoutCik.match(/\(([A-Z0-9.,\s-]+)\)\s*$/);
  const name = tickerMatch ? withoutCik.slice(0, tickerMatch.index).trim() : withoutCik;
  return { name, cik: padCik(cikMatch[1]), ticker: tickerMatch?.[1]?.split(',')[0]?.trim() };
}

function isHealthFiler(sub: SecSubmissions): boolean {
  if (sub.sic && HEALTH_SIC.has(sub.sic)) return true;
  return /pharma|biolog|medic|health|drug|laborator|surgical|hospital/i.test(sub.sicDescription || '');
}

function typeFromSic(sic?: string): Company['type'] {
  switch (sic) {
    case '2834': case '2833': case '2835': return 'Pharma';
    case '2836': return 'Biotech';
    case '8731': case '8732': case '8734': return 'Research';
    case '8000': case '8011': case '8049': case '8050': case '8051': case '8060': case '8062': case '8071': case '8082': case '8090': case '8093':
      return 'Healthcare';
    default: return 'Biotech';
  }
}

/** "CYBIN INC." → "Cybin Inc." ; keeps mixed-case names as filed */
function cleanDisplayName(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return titleCase(trimmed).replace(/\b(Inc|Ltd|Plc|Llc|Corp)\b/g, m => m === 'Plc' ? 'plc' : m === 'Llc' ? 'LLC' : m);
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase());
}

function normalizeWebsite(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

const US_STATE_CODES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR']);

/** EDGAR uses US postal codes for states and its own codes for countries */
function countryFromSec(code?: string, description?: string): string {
  if (code && US_STATE_CODES.has(code.toUpperCase())) return 'United States';
  if (description) return titleCase(description);
  return code || 'United States';
}

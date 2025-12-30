import * as cheerio from 'cheerio';
import { BaseCrawler, CrawlResult, parseDate, cleanText } from '../core/BaseCrawler.js';
import {
  Company,
  CompanySchema,
  Substance,
  Indication,
  SUBSTANCES,
  CLINICAL_PHASES
} from '../models/types.js';
import { logger } from '../utils/logger.js';

interface SECCompanyInfo {
  cik: string;
  name: string;
  ticker?: string;
  exchange?: string;
  sic?: string;
  sicDescription?: string;
  stateOfIncorporation?: string;
  fiscalYearEnd?: string;
  filings?: SECFiling[];
}

interface SECFiling {
  accessionNumber: string;
  form: string;
  filingDate: string;
  description?: string;
  primaryDocument?: string;
  url: string;
}

interface SECSearchResult {
  hits?: {
    hits?: Array<{
      _id: string;
      _source: {
        ciks?: string[];
        display_names?: string[];
        tickers?: string[];
        exchanges?: string[];
      };
    }>;
  };
}

interface SECCompanyFacts {
  cik: number;
  entityName: string;
  facts?: {
    'us-gaap'?: Record<string, {
      label: string;
      description: string;
      units: Record<string, Array<{
        val: number;
        accn: string;
        fy: number;
        fp: string;
        form: string;
        filed: string;
      }>>;
    }>;
    dei?: Record<string, {
      label: string;
      description: string;
      units: Record<string, Array<{
        val: string | number;
        accn: string;
        fy: number;
        fp: string;
        form: string;
        filed: string;
      }>>;
    }>;
  };
}

/**
 * Crawler for company data from SEC EDGAR and other sources
 * Focuses on psychedelic biotech and pharmaceutical companies
 * Documentation: https://www.sec.gov/developer
 */
export class CompanyCrawler extends BaseCrawler<Company> {
  // Known psychedelic companies with their tickers/CIKs
  private static readonly KNOWN_COMPANIES: Array<{
    name: string;
    ticker?: string;
    cik?: string;
    type: Company['type'];
    stage: Company['stage'];
    substances: Substance[];
    focus?: string;
    website?: string;
  }> = [
    {
      name: 'COMPASS Pathways',
      ticker: 'CMPS',
      cik: '0001816736',
      type: 'Biotech',
      stage: 'Public',
      substances: ['Psilocybin'],
      focus: 'Treatment-Resistant Depression',
      website: 'https://compasspathways.com'
    },
    {
      name: 'Atai Life Sciences',
      ticker: 'ATAI',
      cik: '0001842952',
      type: 'Biotech',
      stage: 'Public',
      substances: ['Psilocybin', 'MDMA', 'Ketamine', 'DMT', 'Ibogaine'],
      focus: 'Mental Health Platform',
      website: 'https://atailifesciences.com'
    },
    {
      name: 'MindMed',
      ticker: 'MNMD',
      cik: '0001821806',
      type: 'Biotech',
      stage: 'Public',
      substances: ['LSD', 'MDMA', 'Psilocybin', 'DMT'],
      focus: 'Brain Health Medicines',
      website: 'https://mindmed.co'
    },
    {
      name: 'Cybin Inc',
      ticker: 'CYBN',
      cik: '0001831560',
      type: 'Biotech',
      stage: 'Public',
      substances: ['Psilocybin', 'DMT'],
      focus: 'Depression and Anxiety',
      website: 'https://cybin.com'
    },
    {
      name: 'Numinus Wellness',
      ticker: 'NUMI',
      type: 'Healthcare',
      stage: 'Public',
      substances: ['Psilocybin', 'MDMA', 'Ketamine'],
      focus: 'Mental Health Clinics',
      website: 'https://numinus.com'
    },
    {
      name: 'Awakn Life Sciences',
      ticker: 'AWKN',
      type: 'Biotech',
      stage: 'Public',
      substances: ['Ketamine', 'MDMA'],
      focus: 'Addiction Treatment',
      website: 'https://awaknlifesciences.com'
    },
    {
      name: 'Enveric Biosciences',
      ticker: 'ENVB',
      cik: '0001784851',
      type: 'Biotech',
      stage: 'Public',
      substances: ['Psilocybin'],
      focus: 'Cancer-Related Distress',
      website: 'https://enveric.com'
    },
    {
      name: 'Tryp Therapeutics',
      ticker: 'TRYP',
      type: 'Biotech',
      stage: 'Public',
      substances: ['Psilocybin'],
      focus: 'Eating Disorders and Chronic Pain',
      website: 'https://tryptherapeutics.com'
    },
    {
      name: 'Lykos Therapeutics',
      type: 'Biotech',
      stage: 'Private',
      substances: ['MDMA'],
      focus: 'PTSD Treatment',
      website: 'https://lfrx.com'
    },
    {
      name: 'Usona Institute',
      type: 'Non-Profit',
      stage: 'Private',
      substances: ['Psilocybin'],
      focus: 'Major Depressive Disorder',
      website: 'https://usonainstitute.org'
    },
    {
      name: 'Beckley Psytech',
      type: 'Biotech',
      stage: 'Private',
      substances: ['Psilocybin', '5-MeO-DMT'],
      focus: 'Depression and Addiction',
      website: 'https://beckleypsytech.com'
    },
    {
      name: 'Small Pharma',
      type: 'Biotech',
      stage: 'Private',
      substances: ['DMT'],
      focus: 'Major Depressive Disorder',
      website: 'https://smallpharma.com'
    },
    {
      name: 'Journey Clinical',
      type: 'Healthcare',
      stage: 'Private',
      substances: ['Ketamine'],
      focus: 'Ketamine-Assisted Therapy Platform',
      website: 'https://journeyclinical.com'
    },
    {
      name: 'Field Trip Health',
      type: 'Healthcare',
      stage: 'Private',
      substances: ['Ketamine', 'Psilocybin'],
      focus: 'Psychedelic-Assisted Therapy Clinics',
      website: 'https://fieldtriphealth.com'
    },
    {
      name: 'Synthesis Institute',
      type: 'Healthcare',
      stage: 'Private',
      substances: ['Psilocybin'],
      focus: 'Psilocybin Retreats and Training',
      website: 'https://synthesisinstitute.com'
    }
  ];

  constructor() {
    super({
      name: 'SEC EDGAR',
      baseUrl: 'https://data.sec.gov',
      rateLimit: 5, // SEC allows 10/sec, we're being conservative
      concurrency: 2,
      retries: 3,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        // SEC requires a User-Agent with contact info
        'User-Agent': 'Neuly Research Platform (research@neuly.io)'
      }
    });
  }

  /**
   * Main crawl method - fetches company data from SEC and known company list
   */
  async crawl(query?: string): Promise<CrawlResult<Company>> {
    const companies: Company[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    logger.info(`[SEC EDGAR] Starting company crawl`);

    for (const knownCompany of CompanyCrawler.KNOWN_COMPANIES) {
      try {
        let companyData: Partial<Company> = {
          id: this.generateId('co', knownCompany.name.toLowerCase().replace(/\s+/g, '-')),
          name: knownCompany.name,
          type: knownCompany.type,
          stage: knownCompany.stage,
          ticker: knownCompany.ticker,
          substances: knownCompany.substances,
          focus: knownCompany.focus,
          website: knownCompany.website,
          crawledAt: this.getTimestamp()
        };

        // Fetch additional data from SEC if we have a CIK
        if (knownCompany.cik) {
          try {
            const secData = await this.fetchSECCompanyData(knownCompany.cik);
            companyData = this.mergeSecData(companyData, secData);
          } catch (error) {
            logger.warn(`[SEC EDGAR] Could not fetch SEC data for ${knownCompany.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        const validated = this.validate(companyData);
        if (validated) {
          companies.push(validated);
          logger.debug(`[SEC EDGAR] Processed company: ${knownCompany.name}`);
        }

      } catch (error) {
        errors.push(`Failed to process ${knownCompany.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

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

  /**
   * Fetch company data from SEC EDGAR API
   */
  private async fetchSECCompanyData(cik: string): Promise<SECCompanyInfo> {
    // Normalize CIK to 10 digits with leading zeros
    const normalizedCik = cik.replace(/^0+/, '').padStart(10, '0');

    // Fetch company facts (financial data)
    const factsUrl = `/submissions/CIK${normalizedCik}.json`;

    const response = await this.request<{
      cik: string;
      entityType: string;
      sic: string;
      sicDescription: string;
      name: string;
      tickers: string[];
      exchanges: string[];
      stateOfIncorporation: string;
      fiscalYearEnd: string;
      filings: {
        recent: {
          accessionNumber: string[];
          form: string[];
          filingDate: string[];
          primaryDocument: string[];
          primaryDocDescription: string[];
        };
      };
    }>(factsUrl);

    // Extract recent filings (10-K, 10-Q, 8-K)
    const filings: SECFiling[] = [];
    const recentFilings = response.filings.recent;

    if (recentFilings) {
      const relevantForms = ['10-K', '10-Q', '8-K', 'S-1', 'DEF 14A'];
      for (let i = 0; i < Math.min(recentFilings.form.length, 20); i++) {
        if (relevantForms.includes(recentFilings.form[i])) {
          const accNum = recentFilings.accessionNumber[i].replace(/-/g, '');
          filings.push({
            accessionNumber: recentFilings.accessionNumber[i],
            form: recentFilings.form[i],
            filingDate: recentFilings.filingDate[i],
            description: recentFilings.primaryDocDescription?.[i],
            primaryDocument: recentFilings.primaryDocument?.[i],
            url: `https://www.sec.gov/Archives/edgar/data/${normalizedCik}/${accNum}/${recentFilings.primaryDocument[i]}`
          });
        }
      }
    }

    return {
      cik: normalizedCik,
      name: response.name,
      ticker: response.tickers?.[0],
      exchange: response.exchanges?.[0],
      sic: response.sic,
      sicDescription: response.sicDescription,
      stateOfIncorporation: response.stateOfIncorporation,
      fiscalYearEnd: response.fiscalYearEnd,
      filings
    };
  }

  /**
   * Merge SEC data with existing company data
   */
  private mergeSecData(
    companyData: Partial<Company>,
    secData: SECCompanyInfo
  ): Partial<Company> {
    return {
      ...companyData,
      legalName: secData.name,
      ticker: secData.ticker || companyData.ticker,
      stockExchange: secData.exchange,
      secFilings: secData.filings?.map(f => ({
        type: f.form,
        date: f.filingDate,
        url: f.url
      }))
    };
  }

  /**
   * Transform raw data to our schema
   */
  transform(rawData: unknown): Partial<Company> {
    // For this crawler, transform is handled inline since we're working with known company data
    return rawData as Partial<Company>;
  }

  /**
   * Validate data against Zod schema
   */
  validate(data: unknown): Company | null {
    try {
      return CompanySchema.parse(data);
    } catch (error) {
      logger.warn(`[SEC EDGAR] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Search for companies by name (searches SEC full-text)
   */
  async searchCompanies(query: string): Promise<SECCompanyInfo[]> {
    try {
      // Use SEC's company search endpoint
      const response = await this.request<{
        companies: Array<{
          cik: string;
          name: string;
          ticker?: string;
        }>;
      }>('/cgi-bin/browse-edgar', {
        baseURL: 'https://www.sec.gov',
        params: {
          action: 'getcompany',
          company: query,
          type: '',
          dateb: '',
          owner: 'include',
          count: '40',
          output: 'json'
        }
      });

      return response.companies?.map(c => ({
        cik: c.cik,
        name: c.name,
        ticker: c.ticker
      })) || [];
    } catch (error) {
      logger.error(`[SEC EDGAR] Company search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return [];
    }
  }

  /**
   * Get list of known psychedelic company tickers
   */
  static getKnownTickers(): string[] {
    return CompanyCrawler.KNOWN_COMPANIES
      .filter(c => c.ticker)
      .map(c => c.ticker!);
  }

  /**
   * Get list of known psychedelic companies
   */
  static getKnownCompanies(): typeof CompanyCrawler.KNOWN_COMPANIES {
    return CompanyCrawler.KNOWN_COMPANIES;
  }
}

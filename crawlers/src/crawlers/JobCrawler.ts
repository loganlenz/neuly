import * as cheerio from 'cheerio';
import { BaseCrawler, CrawlResult, parseDate, cleanText, extractNumber } from '../core/BaseCrawler.js';
import {
  JobPosting,
  JobPostingSchema,
  Substance,
  SUBSTANCES
} from '../models/types.js';
import { logger } from '../utils/logger.js';

interface JobSource {
  name: string;
  type: 'api' | 'rss' | 'html';
  url: string;
  searchParams?: Record<string, string>;
}

/**
 * Crawler for job postings related to psychedelic medicine industry
 * Aggregates from multiple job boards and company career pages
 */
export class JobCrawler extends BaseCrawler<JobPosting> {
  // Job sources to crawl
  private static readonly JOB_SOURCES: JobSource[] = [
    {
      name: 'Greenhouse - COMPASS Pathways',
      type: 'api',
      url: 'https://boards-api.greenhouse.io/v1/boards/compasspathways/jobs'
    },
    {
      name: 'Greenhouse - MindMed',
      type: 'api',
      url: 'https://boards-api.greenhouse.io/v1/boards/mindmed/jobs'
    },
    {
      name: 'Greenhouse - Cybin',
      type: 'api',
      url: 'https://boards-api.greenhouse.io/v1/boards/cybin/jobs'
    },
    {
      name: 'Greenhouse - Atai',
      type: 'api',
      url: 'https://boards-api.greenhouse.io/v1/boards/atai/jobs'
    },
    {
      name: 'Lever - Numinus',
      type: 'api',
      url: 'https://api.lever.co/v0/postings/numinus'
    }
  ];

  // Keywords for identifying psychedelic-related jobs
  private static readonly PSYCHEDELIC_KEYWORDS = [
    'psychedelic',
    'psilocybin',
    'mdma',
    'ketamine',
    'lsd',
    'ibogaine',
    'dmt',
    'mental health',
    'depression',
    'ptsd',
    'anxiety',
    'clinical trial',
    'drug development',
    'neuroscience',
    'psychiatry',
    'therapy',
    'research scientist',
    'pharmacology'
  ];

  constructor() {
    super({
      name: 'JobCrawler',
      baseUrl: '',
      rateLimit: 2,
      concurrency: 3,
      retries: 3,
      timeout: 30000
    });
  }

  /**
   * Main crawl method - fetches jobs from all configured sources
   */
  async crawl(query?: string): Promise<CrawlResult<JobPosting>> {
    const jobs: JobPosting[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    logger.info(`[JobCrawler] Starting job crawl from ${JobCrawler.JOB_SOURCES.length} sources`);

    for (const source of JobCrawler.JOB_SOURCES) {
      try {
        logger.debug(`[JobCrawler] Crawling ${source.name}`);
        const sourceJobs = await this.crawlSource(source);
        jobs.push(...sourceJobs);
        logger.info(`[JobCrawler] Found ${sourceJobs.length} jobs from ${source.name}`);
      } catch (error) {
        const errorMsg = `Failed to crawl ${source.name}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error(`[JobCrawler] ${errorMsg}`);
      }
    }

    // Deduplicate by title + company
    const uniqueJobs = this.deduplicateJobs(jobs);

    return {
      success: errors.length === 0,
      data: uniqueJobs,
      errors: errors.length > 0 ? errors : undefined,
      stats: {
        total: uniqueJobs.length + errors.length,
        successful: uniqueJobs.length,
        failed: errors.length,
        duration: Date.now() - startTime
      }
    };
  }

  /**
   * Crawl a specific job source
   */
  private async crawlSource(source: JobSource): Promise<JobPosting[]> {
    switch (source.type) {
      case 'api':
        if (source.url.includes('greenhouse')) {
          return this.crawlGreenhouse(source);
        } else if (source.url.includes('lever')) {
          return this.crawlLever(source);
        }
        return [];
      default:
        return [];
    }
  }

  /**
   * Crawl Greenhouse job board API
   */
  private async crawlGreenhouse(source: JobSource): Promise<JobPosting[]> {
    interface GreenhouseJob {
      id: number;
      title: string;
      location: {
        name: string;
      };
      departments: Array<{ name: string }>;
      updated_at: string;
      absolute_url: string;
      content?: string;
    }

    interface GreenhouseResponse {
      jobs: GreenhouseJob[];
    }

    const response = await this.request<GreenhouseResponse>(source.url, {
      params: { content: 'true' }
    });

    const companyName = this.extractCompanyFromUrl(source.url);
    const jobs: JobPosting[] = [];

    for (const job of response.jobs || []) {
      try {
        const transformed = this.transformGreenhouseJob(job, companyName, source);
        const validated = this.validate(transformed);
        if (validated) {
          jobs.push(validated);
        }
      } catch (error) {
        logger.warn(`[JobCrawler] Failed to process job ${job.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return jobs;
  }

  /**
   * Crawl Lever job board API
   */
  private async crawlLever(source: JobSource): Promise<JobPosting[]> {
    interface LeverJob {
      id: string;
      text: string;
      categories: {
        commitment?: string;
        department?: string;
        location?: string;
        team?: string;
      };
      createdAt: number;
      hostedUrl: string;
      applyUrl: string;
      descriptionPlain?: string;
    }

    const response = await this.request<LeverJob[]>(source.url);
    const companyName = this.extractCompanyFromUrl(source.url);
    const jobs: JobPosting[] = [];

    for (const job of response || []) {
      try {
        const transformed = this.transformLeverJob(job, companyName, source);
        const validated = this.validate(transformed);
        if (validated) {
          jobs.push(validated);
        }
      } catch (error) {
        logger.warn(`[JobCrawler] Failed to process job ${job.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return jobs;
  }

  /**
   * Transform Greenhouse job to our schema
   */
  private transformGreenhouseJob(
    job: { id: number; title: string; location: { name: string }; departments: Array<{ name: string }>; updated_at: string; absolute_url: string; content?: string },
    companyName: string,
    source: JobSource
  ): Partial<JobPosting> {
    const location = this.parseLocation(job.location?.name || '');
    const department = job.departments?.[0]?.name || '';
    const jobType = this.categorizeJobType(job.title, department);

    // Extract description text from HTML content
    let description: string | undefined;
    if (job.content) {
      const $ = cheerio.load(job.content);
      description = cleanText($.text());
    }

    return {
      id: this.generateId('job', `gh-${job.id}`),
      title: job.title,
      company: companyName,
      type: jobType,
      location,
      description: description?.slice(0, 5000), // Limit description length
      postedDate: parseDate(job.updated_at),
      applicationUrl: job.absolute_url,
      source: source.name,
      sourceUrl: job.absolute_url,
      crawledAt: this.getTimestamp()
    };
  }

  /**
   * Transform Lever job to our schema
   */
  private transformLeverJob(
    job: { id: string; text: string; categories: { commitment?: string; department?: string; location?: string; team?: string }; createdAt: number; hostedUrl: string; applyUrl: string; descriptionPlain?: string },
    companyName: string,
    source: JobSource
  ): Partial<JobPosting> {
    const location = this.parseLocation(job.categories?.location || '');
    const department = job.categories?.department || job.categories?.team || '';
    const jobType = this.categorizeJobType(job.text, department);
    const employmentType = this.parseEmploymentType(job.categories?.commitment);

    return {
      id: this.generateId('job', `lv-${job.id}`),
      title: job.text,
      company: companyName,
      type: jobType,
      employmentType,
      location,
      description: cleanText(job.descriptionPlain)?.slice(0, 5000),
      postedDate: job.createdAt ? new Date(job.createdAt).toISOString().split('T')[0] : undefined,
      applicationUrl: job.applyUrl || job.hostedUrl,
      source: source.name,
      sourceUrl: job.hostedUrl,
      crawledAt: this.getTimestamp()
    };
  }

  /**
   * Transform raw data (generic method required by base class)
   */
  transform(rawData: unknown): Partial<JobPosting> {
    return rawData as Partial<JobPosting>;
  }

  /**
   * Validate data against Zod schema
   */
  validate(data: unknown): JobPosting | null {
    try {
      return JobPostingSchema.parse(data);
    } catch (error) {
      logger.warn(`[JobCrawler] Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Extract company name from job board URL
   */
  private extractCompanyFromUrl(url: string): string {
    const companyMap: Record<string, string> = {
      'compasspathways': 'COMPASS Pathways',
      'mindmed': 'MindMed',
      'cybin': 'Cybin',
      'atai': 'Atai Life Sciences',
      'numinus': 'Numinus Wellness',
      'fieldtriphealth': 'Field Trip Health',
      'awakn': 'Awakn Life Sciences'
    };

    for (const [key, value] of Object.entries(companyMap)) {
      if (url.toLowerCase().includes(key)) {
        return value;
      }
    }

    // Extract from URL path
    const match = url.match(/boards\/(\w+)\/jobs|postings\/(\w+)/);
    if (match) {
      const name = match[1] || match[2];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }

    return 'Unknown';
  }

  /**
   * Parse location string into structured format
   */
  private parseLocation(locationStr: string): JobPosting['location'] {
    const isRemote = /remote|work from home|wfh|anywhere/i.test(locationStr);

    // Common location patterns
    const patterns = [
      // "City, State, Country"
      /^(.+?),\s*([A-Z]{2}),?\s*(.+)?$/i,
      // "City, Country"
      /^(.+?),\s*(.+)$/,
      // Just city or country
      /^(.+)$/
    ];

    for (const pattern of patterns) {
      const match = locationStr.match(pattern);
      if (match) {
        return {
          city: match[1]?.trim(),
          state: match[2]?.length === 2 ? match[2].toUpperCase() : undefined,
          country: match[3]?.trim() || (match[2]?.length > 2 ? match[2].trim() : undefined),
          remote: isRemote
        };
      }
    }

    return { remote: isRemote };
  }

  /**
   * Categorize job type based on title and department
   */
  private categorizeJobType(title: string, department: string): JobPosting['type'] {
    const combined = `${title} ${department}`.toLowerCase();

    if (/research|scientist|study|lab|preclinical|clinical research/i.test(combined)) {
      return 'Research';
    }
    if (/clinical|therapist|psychiatr|psycholog|medical|physician|nurse|practitioner/i.test(combined)) {
      return 'Clinical';
    }
    if (/engineer|developer|software|data|tech|it|devops|infrastructure/i.test(combined)) {
      return 'Engineering';
    }
    if (/policy|regulatory|government|affairs|compliance|legal/i.test(combined)) {
      return 'Policy';
    }
    if (/marketing|communications|brand|content|social media|pr/i.test(combined)) {
      return 'Marketing';
    }
    if (/business|finance|accounting|operations|hr|people|admin|executive|ceo|cfo|cto/i.test(combined)) {
      return 'Business';
    }
    if (/operations|supply chain|manufacturing|quality/i.test(combined)) {
      return 'Operations';
    }

    return 'Other';
  }

  /**
   * Parse employment type from commitment string
   */
  private parseEmploymentType(commitment?: string): JobPosting['employmentType'] {
    if (!commitment) return undefined;

    const normalized = commitment.toLowerCase();

    if (/full[\s-]?time/i.test(normalized)) return 'Full-time';
    if (/part[\s-]?time/i.test(normalized)) return 'Part-time';
    if (/contract|freelance|consultant/i.test(normalized)) return 'Contract';
    if (/intern/i.test(normalized)) return 'Internship';
    if (/remote/i.test(normalized)) return 'Remote';

    return undefined;
  }

  /**
   * Deduplicate jobs by title + company
   */
  private deduplicateJobs(jobs: JobPosting[]): JobPosting[] {
    const seen = new Set<string>();
    const unique: JobPosting[] = [];

    for (const job of jobs) {
      const key = `${job.company.toLowerCase()}-${job.title.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(job);
      }
    }

    return unique;
  }

  /**
   * Get list of job sources
   */
  static getJobSources(): JobSource[] {
    return JobCrawler.JOB_SOURCES;
  }

  /**
   * Get search keywords
   */
  static getSearchKeywords(): string[] {
    return JobCrawler.PSYCHEDELIC_KEYWORDS;
  }
}

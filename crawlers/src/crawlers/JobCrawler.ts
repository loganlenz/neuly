import * as cheerio from 'cheerio';
import { BaseCrawler, CrawlResult, parseDate, cleanText, extractNumber } from '../core/BaseCrawler.js';
import {
  JobPosting,
  JobPostingSchema,
  Substance,
  SUBSTANCES
} from '../models/types.js';
import { AtsDiscovery, AtsBoard, AtsProvider } from '../utils/atsDiscovery.js';
import { logger } from '../utils/logger.js';

export interface JobCrawlerOptions {
  /**
   * Company names to auto-discover ATS boards for (usually the names
   * from the companies table). When omitted, only seed boards are crawled.
   */
  companies?: string[];
  /** Directory for the discovery cache (defaults to ./data) */
  cacheDir?: string;
}

/**
 * Crawler for job postings related to psychedelic medicine industry.
 * Crawls a set of seed ATS boards plus any boards auto-discovered from
 * the companies table via the public Greenhouse/Lever/Ashby/Workable APIs.
 */
export class JobCrawler extends BaseCrawler<JobPosting> {
  // Boards that are always crawled, independent of discovery
  private static readonly SEED_BOARDS: AtsBoard[] = [
    { provider: 'greenhouse', slug: 'compasspathways', company: 'COMPASS Pathways', url: 'https://boards-api.greenhouse.io/v1/boards/compasspathways/jobs', jobCount: 0, discoveredAt: '' },
    { provider: 'greenhouse', slug: 'mindmed', company: 'MindMed', url: 'https://boards-api.greenhouse.io/v1/boards/mindmed/jobs', jobCount: 0, discoveredAt: '' },
    { provider: 'greenhouse', slug: 'cybin', company: 'Cybin', url: 'https://boards-api.greenhouse.io/v1/boards/cybin/jobs', jobCount: 0, discoveredAt: '' },
    { provider: 'greenhouse', slug: 'atai', company: 'Atai Life Sciences', url: 'https://boards-api.greenhouse.io/v1/boards/atai/jobs', jobCount: 0, discoveredAt: '' },
    { provider: 'lever', slug: 'numinus', company: 'Numinus Wellness', url: 'https://api.lever.co/v0/postings/numinus', jobCount: 0, discoveredAt: '' }
  ];

  private options: JobCrawlerOptions;

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

  constructor(options: JobCrawlerOptions = {}) {
    super({
      name: 'JobCrawler',
      baseUrl: '',
      rateLimit: 2,
      concurrency: 3,
      retries: 3,
      timeout: 30000
    });
    this.options = options;
  }

  /**
   * Collect the boards to crawl: seed boards plus boards auto-discovered
   * for the provided company names, deduplicated by provider+slug.
   */
  private async resolveBoards(): Promise<AtsBoard[]> {
    const boards = new Map<string, AtsBoard>();

    for (const board of JobCrawler.SEED_BOARDS) {
      boards.set(`${board.provider}/${board.slug}`, board);
    }

    const companies = this.options.companies ?? [];
    if (companies.length > 0) {
      const discovery = new AtsDiscovery({ cacheDir: this.options.cacheDir });
      const discovered = await discovery.discover(companies);
      for (const board of discovered) {
        boards.set(`${board.provider}/${board.slug}`, board);
      }
    }

    return Array.from(boards.values());
  }

  /**
   * Main crawl method - fetches jobs from all seed and discovered boards
   */
  async crawl(query?: string): Promise<CrawlResult<JobPosting>> {
    const jobs: JobPosting[] = [];
    const errors: string[] = [];
    const startTime = Date.now();

    const boards = await this.resolveBoards();
    logger.info(`[JobCrawler] Starting job crawl from ${boards.length} boards`);

    let previousProvider: string | null = null;
    for (const board of boards) {
      try {
        // Space out consecutive hits to the same ATS provider — Workable in
        // particular rate-limits bursts across accounts from one IP.
        if (previousProvider === board.provider) {
          await this.delay(board.provider === 'workable' ? 5000 : 1500);
        }
        previousProvider = board.provider;

        logger.debug(`[JobCrawler] Crawling ${board.provider}/${board.slug}`);
        const sourceJobs = await this.crawlBoard(board);
        jobs.push(...sourceJobs);
        logger.info(`[JobCrawler] Found ${sourceJobs.length} jobs from ${board.provider}/${board.slug}`);
      } catch (error) {
        const errorMsg = `Failed to crawl ${board.provider}/${board.slug}: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
   * Crawl a single ATS board
   */
  private async crawlBoard(board: AtsBoard): Promise<JobPosting[]> {
    switch (board.provider) {
      case 'greenhouse':
        return this.crawlGreenhouse(board);
      case 'lever':
        return this.crawlLever(board);
      case 'ashby':
        return this.crawlAshby(board);
      case 'workable':
        return this.crawlWorkable(board);
    }
  }

  /**
   * Crawl Greenhouse job board API
   */
  private async crawlGreenhouse(board: AtsBoard): Promise<JobPosting[]> {
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

    const response = await this.request<GreenhouseResponse>(board.url, {
      params: { content: 'true' }
    });

    const jobs: JobPosting[] = [];

    for (const job of response.jobs || []) {
      try {
        const transformed = this.transformGreenhouseJob(job, board.company, board);
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
  private async crawlLever(board: AtsBoard): Promise<JobPosting[]> {
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

    const response = await this.request<LeverJob[]>(board.url);
    const jobs: JobPosting[] = [];

    for (const job of response || []) {
      try {
        const transformed = this.transformLeverJob(job, board.company, board);
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
   * Crawl Ashby posting API
   */
  private async crawlAshby(board: AtsBoard): Promise<JobPosting[]> {
    interface AshbyJob {
      id: string;
      title: string;
      location?: string;
      department?: string;
      team?: string;
      employmentType?: string;
      isRemote?: boolean;
      publishedAt?: string;
      jobUrl: string;
      applyUrl?: string;
      descriptionHtml?: string;
    }

    interface AshbyResponse {
      jobs: AshbyJob[];
    }

    const response = await this.request<AshbyResponse>(board.url);
    const jobs: JobPosting[] = [];

    for (const job of response.jobs || []) {
      try {
        const location = { ...this.parseLocation(job.location || ''), ...(job.isRemote ? { remote: true } : {}) };

        let description: string | undefined;
        if (job.descriptionHtml) {
          const $ = cheerio.load(job.descriptionHtml);
          description = cleanText($.text());
        }

        const transformed: Partial<JobPosting> = {
          id: this.generateId('job', `as-${job.id}`),
          title: job.title,
          company: board.company,
          type: this.categorizeJobType(job.title, job.department || job.team || ''),
          employmentType: this.parseEmploymentType(job.employmentType),
          location,
          description: description?.slice(0, 5000),
          postedDate: parseDate(job.publishedAt),
          applicationUrl: job.applyUrl || job.jobUrl,
          source: `Ashby - ${board.company}`,
          sourceUrl: job.jobUrl,
          crawledAt: this.getTimestamp()
        };

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
   * Crawl Workable widget API
   */
  private async crawlWorkable(board: AtsBoard): Promise<JobPosting[]> {
    interface WorkableJob {
      title: string;
      shortcode: string;
      employment_type?: string;
      telecommuting?: boolean;
      department?: string;
      url: string;
      application_url?: string;
      published_on?: string;
      country?: string;
      city?: string;
      state?: string;
    }

    interface WorkableResponse {
      jobs: WorkableJob[];
    }

    const response = await this.request<WorkableResponse>(board.url);
    const jobs: JobPosting[] = [];

    for (const job of response.jobs || []) {
      try {
        const transformed: Partial<JobPosting> = {
          id: this.generateId('job', `wk-${job.shortcode}`),
          title: job.title,
          company: board.company,
          type: this.categorizeJobType(job.title, job.department || ''),
          employmentType: this.parseEmploymentType(job.employment_type),
          location: {
            city: job.city,
            state: job.state,
            country: job.country,
            remote: job.telecommuting === true
          },
          postedDate: parseDate(job.published_on),
          applicationUrl: job.application_url || job.url,
          source: `Workable - ${board.company}`,
          sourceUrl: job.url,
          crawledAt: this.getTimestamp()
        };

        const validated = this.validate(transformed);
        if (validated) {
          jobs.push(validated);
        }
      } catch (error) {
        logger.warn(`[JobCrawler] Failed to process job ${job.shortcode}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    board: AtsBoard
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
      source: `Greenhouse - ${companyName}`,
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
    board: AtsBoard
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
      source: `Lever - ${companyName}`,
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
   * Get list of seed boards
   */
  static getSeedBoards(): AtsBoard[] {
    return JobCrawler.SEED_BOARDS;
  }

  /**
   * Get search keywords
   */
  static getSearchKeywords(): string[] {
    return JobCrawler.PSYCHEDELIC_KEYWORDS;
  }
}

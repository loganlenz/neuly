import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { logger } from '../utils/logger.js';
import { CrawledData } from '../models/types.js';

export interface CrawlerConfig {
  name: string;
  baseUrl: string;
  rateLimit?: number; // requests per second
  concurrency?: number;
  retries?: number;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface CrawlResult<T> {
  success: boolean;
  data?: T[];
  errors?: string[];
  stats: {
    total: number;
    successful: number;
    failed: number;
    duration: number;
  };
}

export abstract class BaseCrawler<T extends CrawledData> {
  protected config: CrawlerConfig;
  protected client: AxiosInstance;
  protected limiter: ReturnType<typeof pLimit>;
  protected requestDelay: number;

  constructor(config: CrawlerConfig) {
    this.config = {
      rateLimit: 2,
      concurrency: 3,
      retries: 3,
      timeout: 30000,
      ...config
    };

    this.requestDelay = 1000 / (this.config.rateLimit || 2);
    this.limiter = pLimit(this.config.concurrency || 3);

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'User-Agent': 'Neuly Research Crawler/1.0 (https://neuly.io; research@neuly.io)',
        'Accept': 'application/json, application/xml, text/html',
        ...this.config.headers
      }
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      response => {
        logger.debug(`[${this.config.name}] ${response.config.method?.toUpperCase()} ${response.config.url} - ${response.status}`);
        return response;
      },
      error => {
        logger.error(`[${this.config.name}] Request failed: ${error.message}`);
        throw error;
      }
    );
  }

  /**
   * Make a rate-limited HTTP request with automatic retries
   */
  protected async request<R>(
    url: string,
    options?: AxiosRequestConfig
  ): Promise<R> {
    return this.limiter(async () => {
      // Rate limiting delay
      await this.delay(this.requestDelay);

      return pRetry(
        async () => {
          const response = await this.client.request<R>({
            url,
            ...options
          });
          return response.data;
        },
        {
          retries: this.config.retries,
          onFailedAttempt: error => {
            logger.warn(
              `[${this.config.name}] Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left. Error: ${error.message}`
            );
          }
        }
      );
    });
  }

  /**
   * Delay execution for rate limiting
   */
  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate a stable, deterministic ID for a crawled item.
   * The same entity must map to the same ID on every crawl so that
   * storage upserts deduplicate and the diff engine can detect changes.
   */
  protected generateId(prefix: string, identifier: string): string {
    const normalized = identifier
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${prefix}_${normalized}`;
  }

  /**
   * Get current timestamp in ISO format
   */
  protected getTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Abstract method to be implemented by specific crawlers
   * Defines the main crawling logic
   */
  abstract crawl(query?: string): Promise<CrawlResult<T>>;

  /**
   * Abstract method to validate crawled data
   */
  abstract validate(data: unknown): T | null;

  /**
   * Abstract method to transform raw data into the expected format
   */
  abstract transform(rawData: unknown): Partial<T>;

  /**
   * Run the crawler with error handling and statistics
   */
  async run(queries: string[]): Promise<CrawlResult<T>> {
    const startTime = Date.now();
    const allData: T[] = [];
    const errors: string[] = [];

    logger.info(`[${this.config.name}] Starting crawl with ${queries.length} queries`);

    for (const query of queries) {
      try {
        logger.info(`[${this.config.name}] Crawling: ${query}`);
        const result = await this.crawl(query);

        if (result.success && result.data) {
          allData.push(...result.data);
          logger.info(`[${this.config.name}] Found ${result.data.length} items for: ${query}`);
        }

        if (result.errors) {
          errors.push(...result.errors);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Query "${query}" failed: ${errorMessage}`);
        logger.error(`[${this.config.name}] Error crawling "${query}": ${errorMessage}`);
      }
    }

    const duration = Date.now() - startTime;

    const stats = {
      total: allData.length + errors.length,
      successful: allData.length,
      failed: errors.length,
      duration
    };

    logger.info(`[${this.config.name}] Crawl completed in ${duration}ms. Success: ${stats.successful}, Failed: ${stats.failed}`);

    return {
      success: errors.length === 0,
      data: allData,
      errors: errors.length > 0 ? errors : undefined,
      stats
    };
  }
}

/**
 * Helper function to safely parse dates
 */
export function parseDate(dateStr: string | undefined | null): string | undefined {
  if (!dateStr) return undefined;

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return undefined;
    return date.toISOString().split('T')[0];
  } catch {
    return undefined;
  }
}

/**
 * Helper function to clean and normalize text
 */
export function cleanText(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Helper function to extract numbers from strings
 */
export function extractNumber(str: string | undefined | null): number | undefined {
  if (!str) return undefined;
  const match = str.replace(/,/g, '').match(/[\d.]+/);
  if (!match) return undefined;
  const num = parseFloat(match[0]);
  return isNaN(num) ? undefined : num;
}

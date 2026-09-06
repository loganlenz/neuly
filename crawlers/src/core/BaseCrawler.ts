import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';
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
        // APIs explain rejected requests in the response body; axios's default
        // message only carries the status code. Surface the body so recorded
        // failures say WHICH parameter was rejected, not just "400".
        const body = error.response?.data
          ? ` — ${JSON.stringify(error.response.data).slice(0, 300)}`
          : '';
        error.message = `${error.message}${body}`;
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
          try {
            const response = await this.client.request<R>({
              url,
              ...options
            });
            return response.data;
          } catch (error) {
            // Rate limited: retrying on the default ~2s backoff just burns the
            // remaining attempts while the limit is still active. Wait out the
            // window (Retry-After header when given, 30s otherwise) first.
            if (axios.isAxiosError(error) && error.response?.status === 429) {
              const retryAfter = parseInt(String(error.response.headers['retry-after'] ?? ''), 10);
              const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter, 120) * 1000
                : 30000;
              logger.warn(`[${this.config.name}] Rate limited (429) on ${url}; waiting ${Math.round(waitMs / 1000)}s before retry`);
              await this.delay(waitMs);
              throw error;
            }
            // Other 4xx responses (404 gone, 400 bad query, 403 blocked) are
            // deterministic — retrying only burns time against the rate limit.
            if (axios.isAxiosError(error) && error.response && error.response.status >= 400 && error.response.status < 500) {
              throw new AbortError(error instanceof Error ? error : new Error(String(error)));
            }
            throw error;
          }
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

        // Keep whatever the query did return: one bad record or one failed
        // batch must not discard the hundreds of good rows beside it.
        if (result.data && result.data.length > 0) {
          allData.push(...result.data);
          logger.info(`[${this.config.name}] Found ${result.data.length} items for: ${query}${result.errors ? ` (${result.errors.length} errors)` : ''}`);
        }

        if (result.errors) {
          errors.push(...result.errors);
          for (const message of result.errors.slice(0, 2)) {
            logger.warn(`[${this.config.name}] "${query}": ${message}`);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Query "${query}" failed: ${errorMessage}`);
        logger.error(`[${this.config.name}] Error crawling "${query}": ${errorMessage}`);
      }
    }

    const duration = Date.now() - startTime;

    // The same entity routinely matches several search queries (a psilocybin
    // depression trial matches both 'psilocybin depression' and 'psychedelic
    // therapy'). Keep one row per id — duplicate ids in a single Postgres
    // INSERT ... ON CONFLICT statement are a hard error.
    const uniqueData = Array.from(new Map(allData.map(item => [item.id, item])).values());
    if (uniqueData.length < allData.length) {
      logger.info(`[${this.config.name}] Deduplicated ${allData.length} -> ${uniqueData.length} items across queries`);
    }

    const stats = {
      total: uniqueData.length + errors.length,
      successful: uniqueData.length,
      failed: errors.length,
      duration
    };

    logger.info(`[${this.config.name}] Crawl completed in ${duration}ms. Success: ${stats.successful}, Failed: ${stats.failed}`);

    return {
      success: errors.length === 0,
      data: uniqueData,
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

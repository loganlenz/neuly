import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { CrawledData, ChangeEvent, ClinicalTrial, ResearchPaper, Company, Person, JobPosting, Event, EducationalResource } from '../models/types.js';
import type { StorageBackend, ChangeEventQuery } from './storageBackend.js';
import { logger } from './logger.js';

export type DataType =
  | 'clinical_trials'
  | 'research_papers'
  | 'companies'
  | 'people'
  | 'jobs'
  | 'events'
  | 'educational_resources';

interface StorageOptions {
  baseDir?: string;
  format?: 'json' | 'jsonl';
  prettyPrint?: boolean;
}

export interface DataManifest {
  lastUpdated: string;
  counts: Record<DataType, number>;
  crawlHistory: Array<{
    type: DataType;
    timestamp: string;
    count: number;
    duration: number;
  }>;
}

/**
 * Storage utility for persisting crawled data
 * Supports JSON and JSONL formats with incremental updates
 */
export class DataStorage implements StorageBackend {
  private baseDir: string;
  private format: 'json' | 'jsonl';
  private prettyPrint: boolean;

  get label(): string {
    return `json:${this.baseDir}`;
  }

  constructor(options: StorageOptions = {}) {
    this.baseDir = options.baseDir || join(process.cwd(), 'data');
    this.format = options.format || 'json';
    this.prettyPrint = options.prettyPrint ?? true;

    // Ensure data directory exists
    this.ensureDir(this.baseDir);
  }

  /**
   * Save data to storage
   */
  async save<T extends CrawledData>(type: DataType, data: T[]): Promise<void> {
    const filePath = this.getFilePath(type);
    this.ensureDir(dirname(filePath));

    try {
      if (this.format === 'jsonl') {
        const content = data.map(item => JSON.stringify(item)).join('\n');
        writeFileSync(filePath, content, 'utf-8');
      } else {
        const content = this.prettyPrint
          ? JSON.stringify(data, null, 2)
          : JSON.stringify(data);
        writeFileSync(filePath, content, 'utf-8');
      }

      logger.info(`[Storage] Saved ${data.length} items to ${filePath}`);

      // Update manifest
      await this.updateManifest(type, data.length);

    } catch (error) {
      logger.error(`[Storage] Failed to save ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Load data from storage
   */
  async load<T extends CrawledData>(type: DataType): Promise<T[]> {
    const filePath = this.getFilePath(type);

    if (!existsSync(filePath)) {
      logger.warn(`[Storage] No data file found for ${type}`);
      return [];
    }

    try {
      const content = readFileSync(filePath, 'utf-8');

      if (this.format === 'jsonl') {
        return content
          .split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line) as T);
      } else {
        return JSON.parse(content) as T[];
      }

    } catch (error) {
      logger.error(`[Storage] Failed to load ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return [];
    }
  }

  /**
   * Append data to existing storage (for incremental updates)
   */
  async append<T extends CrawledData>(type: DataType, newData: T[]): Promise<void> {
    const existing = await this.load<T>(type);

    // Deduplicate by ID
    const existingIds = new Set(existing.map(item => item.id));
    const uniqueNew = newData.filter(item => !existingIds.has(item.id));

    const combined = [...existing, ...uniqueNew];
    await this.save(type, combined);

    logger.info(`[Storage] Appended ${uniqueNew.length} new items to ${type} (${newData.length - uniqueNew.length} duplicates skipped)`);
  }

  /**
   * Update existing items and add new ones
   */
  async upsert<T extends CrawledData>(type: DataType, data: T[]): Promise<void> {
    const existing = await this.load<T>(type);

    // Create map of existing items by ID
    const itemMap = new Map<string, T>();
    for (const item of existing) {
      itemMap.set(item.id, item);
    }

    // Update/add new items
    for (const item of data) {
      itemMap.set(item.id, item);
    }

    await this.save(type, Array.from(itemMap.values()));
    logger.info(`[Storage] Upserted ${data.length} items to ${type}`);
  }

  /**
   * Delete items by IDs
   */
  async delete(type: DataType, ids: string[]): Promise<void> {
    const existing = await this.load(type);
    const idSet = new Set(ids);
    const filtered = existing.filter(item => !idSet.has(item.id));

    await this.save(type, filtered);
    logger.info(`[Storage] Deleted ${ids.length} items from ${type}`);
  }

  /**
   * Get file path for a data type
   */
  private getFilePath(type: DataType): string {
    const extension = this.format === 'jsonl' ? 'jsonl' : 'json';
    return join(this.baseDir, `${type}.${extension}`);
  }

  /**
   * Ensure directory exists
   */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Update the data manifest
   */
  private async updateManifest(type: DataType, count: number): Promise<void> {
    const manifestPath = join(this.baseDir, 'manifest.json');
    let manifest: DataManifest;

    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } else {
      manifest = {
        lastUpdated: new Date().toISOString(),
        counts: {} as Record<DataType, number>,
        crawlHistory: []
      };
    }

    manifest.lastUpdated = new Date().toISOString();
    manifest.counts[type] = count;
    manifest.crawlHistory.push({
      type,
      timestamp: new Date().toISOString(),
      count,
      duration: 0
    });

    // Keep only last 100 history entries
    if (manifest.crawlHistory.length > 100) {
      manifest.crawlHistory = manifest.crawlHistory.slice(-100);
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<DataManifest | null> {
    const manifestPath = join(this.baseDir, 'manifest.json');

    if (!existsSync(manifestPath)) {
      return null;
    }

    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  }

  /**
   * Append change events to the change log (change_events.json).
   * The log is capped to the most recent 10,000 events.
   */
  async saveChangeEvents(events: ChangeEvent[]): Promise<void> {
    if (events.length === 0) return;

    const filePath = join(this.baseDir, 'change_events.json');
    let existing: ChangeEvent[] = [];

    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        logger.warn('[Storage] Could not parse change_events.json; starting fresh');
      }
    }

    const seen = new Set(existing.map(e => e.id));
    const combined = [...existing, ...events.filter(e => !seen.has(e.id))].slice(-10000);
    writeFileSync(filePath, JSON.stringify(combined, null, 2), 'utf-8');
    logger.info(`[Storage] Recorded ${events.length} change events`);
  }

  /**
   * Load change events, newest first
   */
  async loadChangeEvents(query: ChangeEventQuery = {}): Promise<ChangeEvent[]> {
    const filePath = join(this.baseDir, 'change_events.json');
    if (!existsSync(filePath)) return [];

    let events: ChangeEvent[];
    try {
      events = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return [];
    }

    let filtered = events;
    if (query.entityType) {
      filtered = filtered.filter(e => e.entityType === query.entityType);
    }
    if (query.since) {
      filtered = filtered.filter(e => e.detectedAt >= query.since!);
    }

    filtered.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    return filtered.slice(0, query.limit ?? 200);
  }

  /**
   * No held resources for file storage
   */
  async close(): Promise<void> {
    // no-op
  }

  /**
   * Clear all data for a type
   */
  async clear(type: DataType): Promise<void> {
    await this.save(type, []);
    logger.info(`[Storage] Cleared all data for ${type}`);
  }

  /**
   * Clear all data
   */
  async clearAll(): Promise<void> {
    const types: DataType[] = [
      'clinical_trials',
      'research_papers',
      'companies',
      'people',
      'jobs',
      'events',
      'educational_resources'
    ];

    for (const type of types) {
      await this.clear(type);
    }

    logger.info('[Storage] Cleared all data');
  }

  /**
   * Export all data as a single JSON object
   */
  async exportAll(): Promise<Record<DataType, CrawledData[]>> {
    const types: DataType[] = [
      'clinical_trials',
      'research_papers',
      'companies',
      'people',
      'jobs',
      'events',
      'educational_resources'
    ];

    const result: Record<string, CrawledData[]> = {};

    for (const type of types) {
      result[type] = await this.load(type);
    }

    return result as Record<DataType, CrawledData[]>;
  }

  /**
   * Generate a summary report of all data
   */
  async generateReport(): Promise<string> {
    const stats = await this.getStats();
    const allData = await this.exportAll();

    const lines: string[] = [
      '# Neuly Data Report',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Data Counts',
      ''
    ];

    for (const [type, data] of Object.entries(allData)) {
      lines.push(`- ${type}: ${data.length} items`);
    }

    if (stats?.crawlHistory) {
      lines.push('', '## Recent Crawl History', '');
      const recent = stats.crawlHistory.slice(-10);
      for (const entry of recent) {
        lines.push(`- ${entry.type}: ${entry.count} items at ${entry.timestamp}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Default storage instance
 */
export const storage = new DataStorage();

/**
 * Helper to save clinical trials
 */
export async function saveClinicalTrials(data: ClinicalTrial[]): Promise<void> {
  await storage.save('clinical_trials', data);
}

/**
 * Helper to save research papers
 */
export async function saveResearchPapers(data: ResearchPaper[]): Promise<void> {
  await storage.save('research_papers', data);
}

/**
 * Helper to save companies
 */
export async function saveCompanies(data: Company[]): Promise<void> {
  await storage.save('companies', data);
}

/**
 * Helper to save people
 */
export async function savePeople(data: Person[]): Promise<void> {
  await storage.save('people', data);
}

/**
 * Helper to save jobs
 */
export async function saveJobs(data: JobPosting[]): Promise<void> {
  await storage.save('jobs', data);
}

/**
 * Helper to save events
 */
export async function saveEvents(data: Event[]): Promise<void> {
  await storage.save('events', data);
}

/**
 * Helper to save educational resources
 */
export async function saveEducationalResources(data: EducationalResource[]): Promise<void> {
  await storage.save('educational_resources', data);
}

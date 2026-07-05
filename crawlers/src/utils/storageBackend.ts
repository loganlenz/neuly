import { CrawledData, ChangeEvent } from '../models/types.js';
import { DataType, DataManifest, DataStorage } from './storage.js';

export interface ChangeEventQuery {
  entityType?: string;
  since?: string; // ISO timestamp
  limit?: number;
}

/**
 * Common interface for storage backends (JSON files, Postgres).
 * Crawlers, the orchestrator, and the API server talk to this interface
 * so the backend can be swapped via DATABASE_URL without code changes.
 */
export interface StorageBackend {
  /** Human-readable backend description for logs */
  readonly label: string;

  load<T extends CrawledData>(type: DataType): Promise<T[]>;
  save<T extends CrawledData>(type: DataType, data: T[]): Promise<void>;
  upsert<T extends CrawledData>(type: DataType, data: T[]): Promise<void>;
  delete(type: DataType, ids: string[]): Promise<void>;
  getStats(): Promise<DataManifest | null>;

  saveChangeEvents(events: ChangeEvent[]): Promise<void>;
  loadChangeEvents(query?: ChangeEventQuery): Promise<ChangeEvent[]>;

  /** Release held resources (DB pools). No-op for file storage. */
  close(): Promise<void>;
}

/**
 * Create the configured storage backend.
 * DATABASE_URL set -> Postgres; otherwise JSON files in baseDir.
 */
export async function createStorage(options?: { baseDir?: string }): Promise<StorageBackend> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    // Lazy import so the pg dependency is only required when actually used
    const { PostgresStorage } = await import('./postgresStorage.js');
    const storage = new PostgresStorage(databaseUrl);
    await storage.init();
    return storage;
  }

  return new DataStorage({ baseDir: options?.baseDir });
}

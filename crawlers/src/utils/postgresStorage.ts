import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CrawledData, ChangeEvent } from '../models/types.js';
import { DataType, DataManifest, ALL_DATA_TYPES } from './storage.js';
import { StorageBackend, ChangeEventQuery } from './storageBackend.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENTITY_TABLES: readonly DataType[] = ALL_DATA_TYPES;

/**
 * Postgres storage backend. Entity payloads are stored as JSONB with
 * provenance columns (source, first_seen_at, updated_at); change events
 * and crawl runs get their own tables.
 */
export class PostgresStorage implements StorageBackend {
  private pool: pg.Pool;
  readonly label: string;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
    this.label = `postgres:${safeDbName(connectionString)}`;
  }

  /** Apply schema.sql (idempotent) so first run needs no manual migration step. */
  async init(): Promise<void> {
    const schema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
    await this.pool.query(schema);
    logger.debug('[PostgresStorage] Schema ensured');
  }

  private assertValidTable(type: DataType): void {
    if (!ENTITY_TABLES.includes(type)) {
      throw new Error(`Unknown data type: ${type}`);
    }
  }

  async load<T extends CrawledData>(type: DataType): Promise<T[]> {
    this.assertValidTable(type);
    const result = await this.pool.query(`SELECT data FROM ${type} ORDER BY updated_at DESC`);
    return result.rows.map(row => row.data as T);
  }

  async save<T extends CrawledData>(type: DataType, data: T[]): Promise<void> {
    this.assertValidTable(type);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${type}`);
      await this.insertRows(client, type, data);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.recordRun(type, data.length);
    logger.info(`[PostgresStorage] Saved ${data.length} items to ${type}`);
  }

  async upsert<T extends CrawledData>(type: DataType, data: T[]): Promise<void> {
    this.assertValidTable(type);
    if (data.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.insertRows(client, type, data);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await this.recordRun(type, data.length);
    logger.info(`[PostgresStorage] Upserted ${data.length} items to ${type}`);
  }

  private async insertRows(client: pg.PoolClient, type: DataType, data: CrawledData[]): Promise<void> {
    const BATCH = 500;
    for (let i = 0; i < data.length; i += BATCH) {
      const batch = data.slice(i, i + BATCH);
      const ids = batch.map(item => item.id);
      const payloads = batch.map(item => JSON.stringify(item));
      const sources = batch.map(item => ('source' in item && typeof item.source === 'string' ? item.source : null));

      await client.query(
        `INSERT INTO ${type} (id, data, source)
         SELECT * FROM unnest($1::text[], $2::jsonb[], $3::text[])
         ON CONFLICT (id) DO UPDATE
           SET data = excluded.data,
               source = excluded.source,
               updated_at = now()`,
        [ids, payloads, sources]
      );
    }
  }

  async delete(type: DataType, ids: string[]): Promise<void> {
    this.assertValidTable(type);
    if (ids.length === 0) return;
    await this.pool.query(`DELETE FROM ${type} WHERE id = ANY($1::text[])`, [ids]);
    logger.info(`[PostgresStorage] Deleted ${ids.length} items from ${type}`);
  }

  async getStats(): Promise<DataManifest | null> {
    const counts = {} as Record<DataType, number>;
    for (const type of ENTITY_TABLES) {
      const result = await this.pool.query(`SELECT count(*)::int AS n FROM ${type}`);
      counts[type] = result.rows[0].n;
    }

    const history = await this.pool.query(
      `SELECT data_type, item_count, duration_ms, error, ran_at
       FROM crawl_runs ORDER BY ran_at DESC LIMIT 100`
    );

    return {
      lastUpdated: history.rows[0]?.ran_at?.toISOString?.() ?? new Date().toISOString(),
      counts,
      crawlHistory: history.rows.reverse().map(row => ({
        type: row.data_type as DataType,
        timestamp: row.ran_at.toISOString(),
        count: row.item_count,
        duration: row.duration_ms,
        ...(row.error ? { error: row.error } : {})
      }))
    };
  }

  private async recordRun(type: DataType, count: number, durationMs = 0): Promise<void> {
    await this.pool.query(
      'INSERT INTO crawl_runs (data_type, item_count, duration_ms) VALUES ($1, $2, $3)',
      [type, count, durationMs]
    );
  }

  /** Record a failed crawl run so /api/stats shows what broke and why. */
  async recordFailure(type: DataType, error: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO crawl_runs (data_type, item_count, duration_ms, error) VALUES ($1, 0, 0, $2)',
      [type, error.slice(0, 500)]
    );
  }

  async saveChangeEvents(events: ChangeEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.pool.query(
      `INSERT INTO change_events (id, entity_type, entity_id, entity_title, change_type, fields, summary, detected_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::text[], $8::timestamptz[])
       ON CONFLICT (id) DO NOTHING`,
      [
        events.map(e => e.id),
        events.map(e => e.entityType),
        events.map(e => e.entityId),
        events.map(e => e.entityTitle),
        events.map(e => e.changeType),
        events.map(e => JSON.stringify(e.fields ?? [])),
        events.map(e => e.summary),
        events.map(e => e.detectedAt)
      ]
    );
    logger.info(`[PostgresStorage] Recorded ${events.length} change events`);
  }

  async loadChangeEvents(query: ChangeEventQuery = {}): Promise<ChangeEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.entityType) {
      params.push(query.entityType);
      conditions.push(`entity_type = $${params.length}`);
    }
    if (query.since) {
      params.push(query.since);
      conditions.push(`detected_at >= $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(query.limit ?? 200);

    const result = await this.pool.query(
      `SELECT id, entity_type, entity_id, entity_title, change_type, fields, summary, detected_at
       FROM change_events ${where}
       ORDER BY detected_at DESC LIMIT $${params.length}`,
      params
    );

    return result.rows.map(row => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityTitle: row.entity_title,
      changeType: row.change_type,
      fields: row.fields,
      summary: row.summary,
      detectedAt: row.detected_at.toISOString()
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function safeDbName(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

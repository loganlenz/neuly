import type { Response } from 'express';
import { ChangeEvent } from '../models/types.js';
import { ALL_DATA_TYPES, DataManifest, DataType } from '../utils/storage.js';
import { StorageBackend } from '../utils/storageBackend.js';
import { DEFAULT_SCHEDULE } from '../schedule.js';
import { logger } from '../utils/logger.js';

export interface DatasetFreshness {
  type: DataType;
  count: number;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  /** Human-readable crawl cadence(s) feeding this dataset */
  cadence: string[];
}

/**
 * Per-dataset freshness: item counts, last successful crawl, last error and
 * the schedule that refreshes it. Falls back to crawlHistory for manifests
 * written before lastRuns existed.
 */
export function buildFreshness(stats: DataManifest | null): DatasetFreshness[] {
  return ALL_DATA_TYPES.map(type => {
    const run = stats?.lastRuns?.[type];
    const history = (stats?.crawlHistory ?? []).filter(h => h.type === type);
    const lastAttempt = history[history.length - 1];
    const lastSuccess = [...history].reverse().find(h => !h.error);
    const lastError = run ? run.lastError : lastAttempt?.error;
    return {
      type,
      count: stats?.counts?.[type] ?? 0,
      lastSuccessAt: run?.lastSuccessAt ?? lastSuccess?.timestamp,
      lastAttemptAt: run?.lastAttemptAt ?? lastAttempt?.timestamp,
      ...(lastError ? { lastError } : {}),
      cadence: DEFAULT_SCHEDULE.filter(e => e.dataType === type).map(e => e.description)
    };
  });
}

export interface LiveHubOptions {
  /** How often the change log is polled while anyone is listening (ms) */
  pollMs?: number;
  /** Heartbeat interval keeping proxies from closing idle streams (ms) */
  heartbeatMs?: number;
}

/**
 * Server-Sent Events fan-out for the live site.
 *
 * Crawlers run in the scheduler process, so the web server learns about new
 * data by polling the shared change log — once per interval for everyone,
 * and only while at least one browser is connected. Each poll that finds
 * new change events broadcasts them, along with the per-dataset freshness,
 * so open pages refresh the affected datasets within seconds of a crawl.
 */
export class LiveHub {
  private clients = new Set<Response>();
  private cursor = new Date().toISOString();
  private seen = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private polling = false;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;

  constructor(private storage: StorageBackend, options: LiveHubOptions = {}) {
    this.pollMs = options.pollMs ?? 10_000;
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach an SSE client; the stream closes when the request does */
  async subscribe(res: Response): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable response buffering on nginx-style proxies (Render, etc.)
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 5000\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stop();
    });

    // Greet with the current freshness so the page can show "updated Xm ago"
    const stats = await this.storage.getStats().catch(() => null);
    this.send(res, 'hello', { serverTime: new Date().toISOString(), freshness: buildFreshness(stats) });
    this.start();
  }

  /** One poll: fetch change events newer than the cursor and broadcast them */
  async poll(): Promise<ChangeEvent[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const events = (await this.storage.loadChangeEvents({ since: this.cursor, limit: 500 }))
        .filter(e => !this.seen.has(e.id));
      if (events.length === 0) return [];

      for (const event of events) {
        this.seen.add(event.id);
        if (event.detectedAt > this.cursor) this.cursor = event.detectedAt;
      }
      // Bound memory: ids older than the cursor can never be returned again
      if (this.seen.size > 5000) {
        this.seen = new Set(events.map(e => e.id));
      }

      const stats = await this.storage.getStats().catch(() => null);
      const types = Array.from(new Set(events.map(e => e.entityType)));
      this.broadcast('changes', {
        serverTime: new Date().toISOString(),
        types,
        // Newest first, capped: a cold-start crawl can add thousands at once
        events: [...events].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)).slice(0, 100),
        total: events.length,
        freshness: buildFreshness(stats)
      });
      return events;
    } catch (error) {
      logger.warn(`[LiveHub] Poll failed: ${error instanceof Error ? error.message : error}`);
      return [];
    } finally {
      this.polling = false;
    }
  }

  private start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n');
    }, this.heartbeatMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private broadcast(event: string, data: unknown): void {
    for (const client of this.clients) this.send(client, event, data);
  }

  private send(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

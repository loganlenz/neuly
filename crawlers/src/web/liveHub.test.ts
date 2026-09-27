import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { Response } from 'express';
import { LiveHub, buildFreshness } from './liveHub.js';
import { ChangeEvent } from '../models/types.js';
import { DataManifest } from '../utils/storage.js';
import { StorageBackend, ChangeEventQuery } from '../utils/storageBackend.js';

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  headersSent = false;
  writeHead() { this.headersSent = true; return this; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  events(name: string) {
    return this.chunks
      .filter(c => c.startsWith(`event: ${name}\n`))
      .map(c => JSON.parse(c.split('\ndata: ')[1]));
  }
}

function fakeStorage(events: ChangeEvent[], stats: DataManifest | null = null): StorageBackend {
  return {
    label: 'fake',
    load: async () => [],
    save: async () => undefined,
    upsert: async () => undefined,
    delete: async () => undefined,
    getStats: async () => stats,
    recordFailure: async () => undefined,
    saveChangeEvents: async () => undefined,
    loadChangeEvents: async (query?: ChangeEventQuery) =>
      events.filter(e => !query?.since || e.detectedAt >= query.since),
    close: async () => undefined
  };
}

const change = (id: string, entityType: string, detectedAt: string): ChangeEvent => ({
  id, entityType, entityId: id, entityTitle: id, changeType: 'added', summary: `New ${id}`, detectedAt
});

describe('LiveHub', () => {
  it('greets new clients and broadcasts only change events newer than it has seen', async () => {
    const events: ChangeEvent[] = [];
    const hub = new LiveHub(fakeStorage(events), { pollMs: 60_000 });
    const res = new FakeResponse();
    await hub.subscribe(res as unknown as Response);
    expect(res.events('hello')).toHaveLength(1);

    const future = new Date(Date.now() + 1000).toISOString();
    events.push(change('a', 'news', future), change('b', 'clinical_trials', future));
    expect(await hub.poll()).toHaveLength(2);

    // Same events again (since is inclusive) are not re-broadcast
    expect(await hub.poll()).toHaveLength(0);

    const broadcasts = res.events('changes');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].types.sort()).toEqual(['clinical_trials', 'news']);
    expect(broadcasts[0].total).toBe(2);

    res.emit('close');
    expect(hub.clientCount).toBe(0);
    hub.stop();
  });
});

describe('buildFreshness', () => {
  it('reports every dataset with counts, last success, errors and cadence', () => {
    const stats: DataManifest = {
      lastUpdated: '2026-09-27T12:00:00Z',
      counts: { news: 40 } as DataManifest['counts'],
      crawlHistory: [
        { type: 'grants', timestamp: '2026-09-26T04:00:00Z', count: 10, duration: 0 },
        { type: 'grants', timestamp: '2026-09-27T04:00:00Z', count: 0, duration: 0, error: 'timeout' }
      ],
      lastRuns: { news: { lastAttemptAt: '2026-09-27T12:00:00Z', lastSuccessAt: '2026-09-27T12:00:00Z', count: 40 } }
    };
    const freshness = buildFreshness(stats);
    const news = freshness.find(f => f.type === 'news')!;
    expect(news).toMatchObject({ count: 40, lastSuccessAt: '2026-09-27T12:00:00Z' });
    expect(news.cadence[0]).toMatch(/15 min/);

    // Legacy manifests without lastRuns fall back to crawlHistory
    const grants = freshness.find(f => f.type === 'grants')!;
    expect(grants).toMatchObject({ lastSuccessAt: '2026-09-26T04:00:00Z', lastError: 'timeout' });
    expect(freshness.find(f => f.type === 'market_quotes')).toBeDefined();
  });
});

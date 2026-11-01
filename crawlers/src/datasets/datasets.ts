import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID, randomBytes } from 'crypto';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireUser, audit } from '../auth/auth.js';
import { StorageBackend } from '../utils/storageBackend.js';
import { ALL_DATA_TYPES, DataType } from '../utils/storage.js';
import { CrawledData } from '../models/types.js';
import { planFor } from '../web/plans.js';
import { toCsv } from '../web/gating.js';
import { filterDataset, QueryParams } from '../web/dataQuery.js';
import { logger } from '../utils/logger.js';

/**
 * User-built datasets.
 *
 * A dataset is a named collection with two kinds of members:
 *   - items: hand-picked entities (a trial, a company, a paper, ...)
 *   - queries: saved filters over a table (e.g. clinical_trials where
 *     substance=Psilocybin & phase=Phase 3) that resolve live on every read,
 *     so the dataset grows as crawls land new matching rows.
 *
 * Datasets can be exported (Pro+) as JSON/CSV and shared publicly (Pro+)
 * through a slug URL. Everything is scoped to the owning user.
 */

interface DatasetRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  share_slug: string | null;
  created_at: Date;
  updated_at: Date;
  item_count?: number;
  query_count?: number;
}

export interface DatasetItem {
  id: string;
  entityType: string;
  entityId: string;
  entityTitle: string;
  note?: string | null;
  addedAt: string;
}

export interface DatasetQuery {
  id: string;
  entityType: DataType;
  params: QueryParams;
  label?: string | null;
  createdAt: string;
}

/** Entity types that items may reference, mapped to the table they live in */
const ITEM_TYPE_TO_TABLE: Record<string, DataType> = {
  clinical_trials: 'clinical_trials', trial: 'clinical_trials', study: 'clinical_trials',
  research_papers: 'research_papers', paper: 'research_papers',
  companies: 'companies', company: 'companies',
  people: 'people', person: 'people',
  jobs: 'jobs', job: 'jobs',
  events: 'events', event: 'events',
  educational_resources: 'educational_resources', course: 'educational_resources',
  legislation: 'legislation', bill: 'legislation',
  funding_events: 'funding_events', funding: 'funding_events',
  grants: 'grants', grant: 'grants',
  care_providers: 'care_providers', provider: 'care_providers',
  news: 'news',
  market_quotes: 'market_quotes', quote: 'market_quotes'
};

export function tableForEntityType(type: string): DataType | undefined {
  return ITEM_TYPE_TO_TABLE[type];
}

function toDataset(row: DatasetRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isPublic: row.is_public,
    shareSlug: row.share_slug,
    shareUrl: row.is_public && row.share_slug ? `/datasets/shared/${row.share_slug}` : null,
    itemCount: row.item_count ?? undefined,
    queryCount: row.query_count ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const requireDb = (_req: Request, res: Response, next: NextFunction) => {
  if (!appDbAvailable()) {
    res.status(503).json({ error: 'Datasets require the Postgres backend (set DATABASE_URL)' });
    return;
  }
  next();
};

async function loadOwned(datasetId: string, userId: string): Promise<DatasetRow | null> {
  const result = await getAppDb().query(
    'SELECT * FROM datasets WHERE id = $1 AND user_id = $2', [datasetId, userId]);
  return result.rows[0] ?? null;
}

async function loadMembers(datasetId: string): Promise<{ items: DatasetItem[]; queries: DatasetQuery[] }> {
  const [items, queries] = await Promise.all([
    getAppDb().query(
      'SELECT id, entity_type, entity_id, entity_title, note, added_at FROM dataset_items WHERE dataset_id = $1 ORDER BY added_at DESC',
      [datasetId]),
    getAppDb().query(
      'SELECT id, entity_type, params, label, created_at FROM dataset_queries WHERE dataset_id = $1 ORDER BY created_at',
      [datasetId])
  ]);
  return {
    items: items.rows.map(r => ({
      id: r.id, entityType: r.entity_type, entityId: r.entity_id, entityTitle: r.entity_title,
      note: r.note, addedAt: r.added_at.toISOString()
    })),
    queries: queries.rows.map(r => ({
      id: r.id, entityType: r.entity_type, params: r.params ?? {}, label: r.label, createdAt: r.created_at.toISOString()
    }))
  };
}

/**
 * Resolve a dataset's members into live entity rows, grouped by table.
 * Items whose entity has since been removed are reported in `missing`.
 */
export async function resolveDataset(
  storage: StorageBackend,
  members: { items: DatasetItem[]; queries: DatasetQuery[] }
): Promise<{ rows: Record<string, CrawledData[]>; missing: DatasetItem[]; total: number }> {
  const wanted = new Map<DataType, Set<string>>();
  for (const item of members.items) {
    const table = tableForEntityType(item.entityType);
    if (!table) continue;
    if (!wanted.has(table)) wanted.set(table, new Set());
    wanted.get(table)!.add(item.entityId);
  }
  const tables = new Set<DataType>([...wanted.keys(), ...members.queries.map(q => q.entityType)]);

  const rows: Record<string, CrawledData[]> = {};
  const missing: DatasetItem[] = [];
  const cache = new Map<DataType, CrawledData[]>();
  const load = async (table: DataType) => {
    if (!cache.has(table)) cache.set(table, await storage.load(table));
    return cache.get(table)!;
  };

  for (const table of tables) {
    const all = await load(table);
    const picked = new Map<string, CrawledData>();
    const ids = wanted.get(table);
    if (ids) {
      const byId = new Map(all.map(r => [r.id, r] as const));
      // Items may be stored by a secondary key (nctId, ticker) from older UI paths
      const byAlt = new Map<string, CrawledData>();
      for (const r of all) {
        const alt = (r as { nctId?: string; pmid?: string; ticker?: string });
        if (alt.nctId) byAlt.set(alt.nctId, r);
        if (alt.pmid) byAlt.set(alt.pmid, r);
      }
      for (const id of ids) {
        const hit = byId.get(id) ?? byAlt.get(id);
        if (hit) picked.set(hit.id, hit);
        else missing.push(...members.items.filter(i => i.entityId === id && tableForEntityType(i.entityType) === table));
      }
    }
    for (const query of members.queries.filter(q => q.entityType === table)) {
      for (const r of filterDataset(table, all, query.params)) picked.set(r.id, r);
    }
    rows[table] = Array.from(picked.values());
  }

  const total = Object.values(rows).reduce((n, list) => n + list.length, 0);
  return { rows, missing, total };
}

function slug(): string {
  return randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 10) || randomUUID().slice(0, 8);
}

export function datasetsRouter(storage: StorageBackend): Router {
  const router = Router();
  router.use(requireDb);

  // ---- public share endpoint (no auth) ----
  router.get('/shared/:slug', async (req: Request, res: Response) => {
    try {
      const result = await getAppDb().query(
        `SELECT d.*, u.name AS owner_name FROM datasets d JOIN users u ON u.id = d.user_id
         WHERE d.share_slug = $1 AND d.is_public = true`, [req.params.slug]);
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: 'Shared dataset not found' });
      const members = await loadMembers(row.id);
      const resolved = await resolveDataset(storage, members);
      res.json({
        dataset: { ...toDataset(row), owner: row.owner_name || 'Neuly user', itemCount: members.items.length, queryCount: members.queries.length },
        queries: members.queries,
        data: resolved.rows,
        total: resolved.total
      });
    } catch (error) {
      logger.error(`[datasets] shared read failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Failed to load shared dataset' });
    }
  });

  router.use(requireUser);

  router.get('/', async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query(
      `SELECT d.*,
              (SELECT count(*)::int FROM dataset_items i WHERE i.dataset_id = d.id) AS item_count,
              (SELECT count(*)::int FROM dataset_queries q WHERE q.dataset_id = d.id) AS query_count
       FROM datasets d WHERE d.user_id = $1 ORDER BY d.updated_at DESC`, [req.user!.id]);
    const spec = planFor(req.user!.plan);
    res.json({
      data: result.rows.map(toDataset),
      limits: { maxDatasets: spec.maxDatasets, maxItems: spec.maxDatasetItems, maxQueries: spec.maxDatasetQueries, exports: spec.exports, sharing: spec.sharing }
    });
  });

  router.post('/', async (req: AuthedRequest, res: Response) => {
    const { name, description } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'A dataset name is required' });

    const spec = planFor(req.user!.plan);
    if (spec.maxDatasets !== null) {
      const count = await getAppDb().query('SELECT count(*)::int AS n FROM datasets WHERE user_id = $1', [req.user!.id]);
      if (count.rows[0].n >= spec.maxDatasets) {
        return res.status(403).json({ error: `The ${spec.name} plan includes ${spec.maxDatasets} dataset${spec.maxDatasets === 1 ? '' : 's'} — upgrade to Pro for unlimited datasets`, upgrade: '/pricing' });
      }
    }

    const id = `ds_${randomUUID()}`;
    const result = await getAppDb().query(
      `INSERT INTO datasets (id, user_id, name, description) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, req.user!.id, name.trim().slice(0, 120), typeof description === 'string' ? description.trim().slice(0, 1000) || null : null]
    );
    res.status(201).json({ data: { ...toDataset(result.rows[0]), itemCount: 0, queryCount: 0 } });
  });

  router.get('/:id', async (req: AuthedRequest, res: Response) => {
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });
    const members = await loadMembers(row.id);
    const resolve = req.query.resolve !== '0';
    const resolved = resolve ? await resolveDataset(storage, members) : null;
    res.json({
      data: { ...toDataset(row), itemCount: members.items.length, queryCount: members.queries.length },
      items: members.items,
      queries: members.queries,
      ...(resolved ? { rows: resolved.rows, total: resolved.total, missing: resolved.missing } : {})
    });
  });

  router.patch('/:id', async (req: AuthedRequest, res: Response) => {
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });
    const { name, description, isPublic } = req.body ?? {};
    const spec = planFor(req.user!.plan);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof name === 'string' && name.trim()) { params.push(name.trim().slice(0, 120)); sets.push(`name = $${params.length}`); }
    if (description !== undefined) { params.push(typeof description === 'string' ? description.trim().slice(0, 1000) || null : null); sets.push(`description = $${params.length}`); }
    if (typeof isPublic === 'boolean') {
      if (isPublic && !spec.sharing) {
        return res.status(403).json({ error: 'Public share links are a Pro feature', upgrade: '/pricing' });
      }
      params.push(isPublic); sets.push(`is_public = $${params.length}`);
      if (isPublic && !row.share_slug) { params.push(slug()); sets.push(`share_slug = $${params.length}`); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(row.id);
    const result = await getAppDb().query(
      `UPDATE datasets SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
    res.json({ data: toDataset(result.rows[0]) });
  });

  router.delete('/:id', async (req: AuthedRequest, res: Response) => {
    const result = await getAppDb().query('DELETE FROM datasets WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user!.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Dataset not found' });
    await audit(req.user!.id, 'dataset.deleted', req.params.id);
    res.json({ ok: true });
  });

  // ---- items ----
  router.post('/:id/items', async (req: AuthedRequest, res: Response) => {
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });
    const { entityType, entityId, entityTitle, note } = req.body ?? {};
    if (typeof entityType !== 'string' || !tableForEntityType(entityType) ||
        typeof entityId !== 'string' || !entityId.trim() ||
        typeof entityTitle !== 'string' || !entityTitle.trim()) {
      return res.status(400).json({ error: 'entityType (a known dataset type), entityId and entityTitle are required' });
    }

    const spec = planFor(req.user!.plan);
    if (spec.maxDatasetItems !== null) {
      const count = await getAppDb().query('SELECT count(*)::int AS n FROM dataset_items WHERE dataset_id = $1', [row.id]);
      if (count.rows[0].n >= spec.maxDatasetItems) {
        return res.status(403).json({ error: `The ${spec.name} plan allows ${spec.maxDatasetItems} items per dataset — upgrade to Pro for unlimited`, upgrade: '/pricing' });
      }
    }

    const result = await getAppDb().query(
      `INSERT INTO dataset_items (id, dataset_id, entity_type, entity_id, entity_title, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dataset_id, entity_type, entity_id) DO UPDATE SET entity_title = EXCLUDED.entity_title, note = COALESCE(EXCLUDED.note, dataset_items.note)
       RETURNING id, entity_type, entity_id, entity_title, note, added_at`,
      [`dsi_${randomUUID()}`, row.id, tableForEntityType(entityType), entityId.trim().slice(0, 300), entityTitle.trim().slice(0, 500),
        typeof note === 'string' ? note.trim().slice(0, 1000) || null : null]
    );
    await getAppDb().query('UPDATE datasets SET updated_at = now() WHERE id = $1', [row.id]);
    const r = result.rows[0];
    res.status(201).json({ data: { id: r.id, entityType: r.entity_type, entityId: r.entity_id, entityTitle: r.entity_title, note: r.note, addedAt: r.added_at.toISOString() } });
  });

  router.delete('/:id/items/:itemId', async (req: AuthedRequest, res: Response) => {
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });
    await getAppDb().query('DELETE FROM dataset_items WHERE id = $1 AND dataset_id = $2', [req.params.itemId, row.id]);
    await getAppDb().query('UPDATE datasets SET updated_at = now() WHERE id = $1', [row.id]);
    res.json({ ok: true });
  });

  // ---- saved queries ----
  router.post('/:id/queries', async (req: AuthedRequest, res: Response) => {
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });
    const { entityType, params, label } = req.body ?? {};
    if (!ALL_DATA_TYPES.includes(entityType)) {
      return res.status(400).json({ error: `entityType must be one of ${ALL_DATA_TYPES.join(', ')}` });
    }
    const cleanParams: QueryParams = {};
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim() && key.length <= 40) cleanParams[key] = value.trim().slice(0, 200);
      }
    }
    if (Object.keys(cleanParams).length === 0) return res.status(400).json({ error: 'At least one filter parameter is required (e.g. substance, phase, status, search)' });

    const spec = planFor(req.user!.plan);
    if (spec.maxDatasetQueries !== null) {
      const count = await getAppDb().query('SELECT count(*)::int AS n FROM dataset_queries WHERE dataset_id = $1', [row.id]);
      if (count.rows[0].n >= spec.maxDatasetQueries) {
        return res.status(403).json({ error: `The ${spec.name} plan allows ${spec.maxDatasetQueries} saved queries per dataset — upgrade to Pro for unlimited`, upgrade: '/pricing' });
      }
    }

    const result = await getAppDb().query(
      `INSERT INTO dataset_queries (id, dataset_id, entity_type, params, label) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, entity_type, params, label, created_at`,
      [`dsq_${randomUUID()}`, row.id, entityType, JSON.stringify(cleanParams), typeof label === 'string' ? label.trim().slice(0, 120) || null : null]
    );
    await getAppDb().query('UPDATE datasets SET updated_at = now() WHERE id = $1', [row.id]);
    const r = result.rows[0];
    res.status(201).json({ data: { id: r.id, entityType: r.entity_type, params: r.params, label: r.label, createdAt: r.created_at.toISOString() } });
  });

  router.delete('/:id/queries/:queryId', async (req: AuthedRequest, res: Response) => {
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });
    await getAppDb().query('DELETE FROM dataset_queries WHERE id = $1 AND dataset_id = $2', [req.params.queryId, row.id]);
    await getAppDb().query('UPDATE datasets SET updated_at = now() WHERE id = $1', [row.id]);
    res.json({ ok: true });
  });

  // ---- export (Pro+) ----
  router.get('/:id/export', async (req: AuthedRequest, res: Response) => {
    const spec = planFor(req.user!.plan);
    if (!spec.exports) return res.status(403).json({ error: 'Exports are a Pro feature', upgrade: '/pricing' });
    const row = await loadOwned(req.params.id, req.user!.id);
    if (!row) return res.status(404).json({ error: 'Dataset not found' });

    const members = await loadMembers(row.id);
    const resolved = await resolveDataset(storage, members);
    const safeName = row.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 60) || 'dataset';
    const format = req.query.format === 'csv' ? 'csv' : 'json';

    if (format === 'csv') {
      // One CSV per table, concatenated with a header line naming the table
      const parts: string[] = [];
      for (const [table, rows] of Object.entries(resolved.rows)) {
        if (rows.length === 0) continue;
        parts.push(`# ${table} (${rows.length} rows)`, toCsv(rows), '');
      }
      res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="neuly_${safeName}.csv"`).send(parts.join('\n'));
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="neuly_${safeName}.json"`);
    res.json({
      dataset: { ...toDataset(row), exportedAt: new Date().toISOString(), source: 'Neuly — https://neuly.io' },
      queries: members.queries,
      total: resolved.total,
      data: resolved.rows
    });
  });

  return router;
}

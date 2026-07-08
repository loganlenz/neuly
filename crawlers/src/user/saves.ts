import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { AuthedRequest, requireUser } from '../auth/auth.js';
import { logger } from '../utils/logger.js';

const KINDS = ['save', 'follow'] as const;
type SaveKind = (typeof KINDS)[number];

interface SavedItemRow {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_title: string;
  kind: SaveKind;
  meta: Record<string, unknown> | null;
  created_at: Date;
}

function toApi(row: SavedItemRow) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityTitle: row.entity_title,
    kind: row.kind,
    meta: row.meta ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

/**
 * Per-user saved/followed entities: GET / lists, POST / upserts,
 * DELETE /:id removes. Backs every Save/Follow button in the frontend
 * and the dashboard "Saved Items" panel.
 */
export function savesRouter(): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!appDbAvailable()) {
      res.status(503).json({ error: 'Account features require the Postgres backend (set DATABASE_URL)' });
      return;
    }
    next();
  });

  router.get('/', requireUser, async (req: AuthedRequest, res: Response) => {
    try {
      const result = await getAppDb().query(
        `SELECT id, entity_type, entity_id, entity_title, kind, meta, created_at
         FROM saved_items WHERE user_id = $1 ORDER BY created_at DESC`,
        [req.user!.id]
      );
      res.json({ data: result.rows.map(toApi) });
    } catch (error) {
      logger.error(`[saves] list failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Failed to load saved items' });
    }
  });

  router.post('/', requireUser, async (req: AuthedRequest, res: Response) => {
    const { entityType, entityId, entityTitle, kind, meta } = req.body ?? {};
    if (typeof entityType !== 'string' || !entityType.trim() ||
        typeof entityId !== 'string' || !entityId.trim() ||
        typeof entityTitle !== 'string' || !entityTitle.trim()) {
      return res.status(400).json({ error: 'entityType, entityId and entityTitle are required' });
    }
    const saveKind: SaveKind = KINDS.includes(kind) ? kind : 'save';

    try {
      const result = await getAppDb().query(
        `INSERT INTO saved_items (id, user_id, entity_type, entity_id, entity_title, kind, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, entity_type, entity_id, kind)
         DO UPDATE SET entity_title = EXCLUDED.entity_title, meta = EXCLUDED.meta
         RETURNING id, entity_type, entity_id, entity_title, kind, meta, created_at`,
        [
          `sv_${randomUUID()}`, req.user!.id,
          entityType.trim().slice(0, 60), entityId.trim().slice(0, 300),
          entityTitle.trim().slice(0, 500), saveKind,
          meta && typeof meta === 'object' ? JSON.stringify(meta) : null
        ]
      );
      res.status(201).json({ data: toApi(result.rows[0]) });
    } catch (error) {
      logger.error(`[saves] create failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Failed to save item' });
    }
  });

  router.delete('/:id', requireUser, async (req: AuthedRequest, res: Response) => {
    try {
      await getAppDb().query(
        'DELETE FROM saved_items WHERE id = $1 AND user_id = $2',
        [req.params.id, req.user!.id]
      );
      res.json({ ok: true });
    } catch (error) {
      logger.error(`[saves] delete failed: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({ error: 'Failed to remove saved item' });
    }
  });

  return router;
}

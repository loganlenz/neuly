import { Router, Request, Response, NextFunction } from 'express';
import { AuthedRequest, recordApiUsage, dailyUsageForUser } from '../auth/auth.js';
import { appDbAvailable } from '../db/appDb.js';
import { StorageBackend } from '../utils/storageBackend.js';
import { ALL_DATA_TYPES, DataType } from '../utils/storage.js';
import { CrawledData } from '../models/types.js';
import { planFor, PLANS } from '../web/plans.js';
import { RateLimiter, setRateLimitHeaders, clientIp } from '../web/rateLimit.js';
import { QUERY_PARAMS_BY_TYPE, filterDataset, sortDataset } from '../web/dataQuery.js';
import { toCsv } from '../web/gating.js';
import { logger } from '../utils/logger.js';

/**
 * The public API product.
 *
 * - `/api/v1/...` is an alias of `/api/...` (same handlers), so integrators
 *   get a stable, versioned prefix while the SPA keeps calling `/api`.
 * - API-key traffic is metered per UTC day against the plan quota and
 *   burst-limited per minute; anonymous traffic is limited per IP.
 * - `/api/openapi.json` describes every endpoint; `/docs` renders it.
 * - `/api/v1/bulk/:type` streams a whole table as NDJSON or CSV (Enterprise).
 */

export const API_VERSION = '1.0.0';
const DATASET_ROUTES: Record<DataType, string> = {
  clinical_trials: 'clinical-trials',
  research_papers: 'research',
  companies: 'companies',
  people: 'people',
  jobs: 'jobs',
  events: 'events',
  educational_resources: 'education',
  legislation: 'legislation',
  funding_events: 'funding',
  grants: 'grants',
  care_providers: 'care',
  news: 'news',
  market_quotes: 'markets'
};

/** Rewrite /api/v1/x -> /api/x so one set of handlers serves both prefixes */
export function versionAlias() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.url.startsWith('/api/v1/') || req.url === '/api/v1') {
      req.url = '/api' + req.url.slice('/api/v1'.length);
      if (req.url === '/api') req.url = '/api/';
    }
    next();
  };
}

/**
 * Traffic policy for everything under /api:
 *  - API key: plan quota per day (metered in Postgres) + per-minute burst
 *  - session user: generous per-minute limit
 *  - anonymous: per-IP per-minute limit
 * The live stream and health check are exempt.
 */
export function apiTrafficPolicy() {
  const minute = new RateLimiter(60_000);
  const anonPerMinute = Number(process.env.ANON_RATE_LIMIT_PER_MINUTE ?? 120);
  const sessionPerMinute = Number(process.env.SESSION_RATE_LIMIT_PER_MINUTE ?? 600);
  const quotaCache = new Map<string, { count: number; at: number }>();

  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api') || req.path === '/api/live' || req.path === '/api/health' || req.path === '/api/billing/webhook') {
      return next();
    }

    try {
      if (req.apiKey && req.user) {
        const spec = planFor(req.user.plan);
        if (spec.apiDailyQuota <= 0) {
          res.status(403).json({ error: 'API access requires the Pro or Enterprise plan', upgrade: '/pricing' });
          return;
        }
        const burst = minute.hit(`key:${req.apiKey.id}`, spec.apiPerMinute);
        if (!burst.allowed) {
          setRateLimitHeaders(res, burst);
          res.setHeader('Retry-After', String(Math.max(1, burst.resetAt - Math.floor(Date.now() / 1000))));
          res.status(429).json({ error: `Burst limit of ${spec.apiPerMinute} requests/minute reached` });
          return;
        }
        // Daily quota across all of the user's keys. The per-user count is
        // cached for 10s so a burst of requests costs one read, not many.
        if (appDbAvailable()) {
          const cached = quotaCache.get(req.user.id);
          const used = cached && Date.now() - cached.at < 10_000
            ? cached.count
            : await dailyUsageForUser(req.user.id);
          if (used >= spec.apiDailyQuota) {
            res.setHeader('X-RateLimit-Limit', String(spec.apiDailyQuota));
            res.setHeader('X-RateLimit-Remaining', '0');
            res.status(429).json({ error: `Daily quota of ${spec.apiDailyQuota.toLocaleString()} requests reached — resets at 00:00 UTC`, upgrade: req.user.plan === 'pro' ? '/pricing' : undefined });
            return;
          }
          quotaCache.set(req.user.id, { count: used + 1, at: cached && Date.now() - cached.at < 10_000 ? cached.at : Date.now() });
          res.setHeader('X-RateLimit-Limit', String(spec.apiDailyQuota));
          res.setHeader('X-RateLimit-Remaining', String(Math.max(0, spec.apiDailyQuota - used - 1)));
          res.setHeader('X-RateLimit-Burst-Remaining', String(burst.remaining));
          recordApiUsage(req.apiKey.id).catch(error => logger.warn(`[api] usage write failed: ${error instanceof Error ? error.message : error}`));
        }
        return next();
      }

      if (req.user) {
        const result = minute.hit(`user:${req.user.id}`, sessionPerMinute);
        setRateLimitHeaders(res, result);
        if (!result.allowed) { res.status(429).json({ error: 'Too many requests — slow down' }); return; }
        return next();
      }

      const result = minute.hit(`ip:${clientIp(req)}`, anonPerMinute);
      setRateLimitHeaders(res, result);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, result.resetAt - Math.floor(Date.now() / 1000))));
        res.status(429).json({ error: 'Too many requests — sign in or use an API key for higher limits', docs: '/docs' });
        return;
      }
      next();
    } catch (error) {
      logger.warn(`[api] traffic policy error: ${error instanceof Error ? error.message : error}`);
      next();
    }
  };
}

function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

/** OpenAPI 3.0 description of the public surface. Exported for tests. */
export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const listResponse = {
    description: 'Paginated list',
    content: { 'application/json': { schema: { type: 'object', properties: {
      data: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' }
    } } } }
  };
  const pagination = [
    { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 5000 } }
  ];

  for (const type of ALL_DATA_TYPES) {
    const route = DATASET_ROUTES[type];
    const params = QUERY_PARAMS_BY_TYPE[type].map(p => ({ name: p.name, in: 'query', description: p.description, schema: { type: 'string' } }));
    paths[`/v1/${route}`] = {
      get: {
        tags: ['Data'],
        summary: `List ${type.replace(/_/g, ' ')}`,
        operationId: `list_${type}`,
        parameters: [...params, ...pagination],
        responses: { 200: listResponse, 429: { description: 'Rate limit or quota exceeded' } }
      }
    };
    if (type !== 'market_quotes' && type !== 'news' && type !== 'educational_resources') {
      paths[`/v1/${route}/{id}`] = {
        get: {
          tags: ['Data'],
          summary: `Get one ${type.replace(/_/g, ' ').replace(/s$/, '')} by id${type === 'clinical_trials' ? ' or NCT id' : type === 'research_papers' ? ' or PMID' : type === 'companies' ? ' or ticker' : ''}`,
          operationId: `get_${type}`,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'The record' }, 404: { description: 'Not found' } }
        }
      };
    }
    paths[`/v1/bulk/${type}`] = {
      get: {
        tags: ['Bulk (Enterprise)'],
        summary: `Download the whole ${type.replace(/_/g, ' ')} table`,
        operationId: `bulk_${type}`,
        parameters: [
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['ndjson', 'json', 'csv'], default: 'ndjson' } },
          { name: 'since', in: 'query', description: 'Only rows crawled on/after this ISO timestamp', schema: { type: 'string' } }
        ],
        responses: { 200: { description: 'Full table stream' }, 403: { description: 'Enterprise plan required' } },
        security: [{ apiKey: [] }]
      }
    };
  }

  paths['/v1/search'] = {
    get: { tags: ['Data'], summary: 'Search across every table', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 } }], responses: { 200: { description: 'Top matches per table' } } }
  };
  paths['/v1/changes'] = {
    get: {
      tags: ['Sync'], summary: 'Change feed: added / updated / removed events from every crawl',
      description: 'Poll with `since` set to the newest `detectedAt` you have seen to keep a warehouse in sync. Free plan sees 7 days of history.',
      parameters: [
        { name: 'type', in: 'query', description: 'Entity type, e.g. clinical_trials', schema: { type: 'string' } },
        { name: 'since', in: 'query', description: 'ISO timestamp cursor', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 } }
      ],
      responses: { 200: { description: 'Events, newest first' } }
    }
  };
  paths['/v1/readouts'] = {
    get: { tags: ['Derived'], summary: 'Trial readout calendar (expected results windows)', parameters: [
      { name: 'phase', in: 'query', schema: { type: 'string' } }, { name: 'substance', in: 'query', schema: { type: 'string' } },
      { name: 'horizonDays', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }
    ], responses: { 200: { description: 'Readouts, soonest first' } } }
  };
  paths['/v1/dashboard'] = { get: { tags: ['Derived'], summary: 'Counts and highlights across every dataset', responses: { 200: { description: 'Dashboard summary' } } } };
  paths['/v1/freshness'] = { get: { tags: ['Sync'], summary: 'Per-dataset crawl freshness (last success, last error, cadence)', responses: { 200: { description: 'Freshness report' } } } };
  paths['/v1/stats'] = { get: { tags: ['Sync'], summary: 'Row counts and crawl history', responses: { 200: { description: 'Statistics' } } } };
  paths['/v1/live'] = { get: { tags: ['Sync'], summary: 'Server-Sent Events stream of change events as crawls land', responses: { 200: { description: 'text/event-stream' } } } };
  paths['/v1/export/{type}'] = {
    get: { tags: ['Export (Pro)'], summary: 'CSV export of a table', parameters: [{ name: 'type', in: 'path', required: true, schema: { type: 'string', enum: [...ALL_DATA_TYPES] } }], responses: { 200: { description: 'text/csv' } }, security: [{ apiKey: [] }] }
  };
  paths['/v1/datasets'] = {
    get: { tags: ['Datasets'], summary: 'Your datasets', responses: { 200: { description: 'List' } }, security: [{ apiKey: [] }] },
    post: { tags: ['Datasets'], summary: 'Create a dataset', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } }, security: [{ apiKey: [] }] }
  };
  paths['/v1/datasets/{id}'] = {
    get: { tags: ['Datasets'], summary: 'A dataset with its members resolved to live rows', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Dataset' } }, security: [{ apiKey: [] }] }
  };
  paths['/v1/datasets/{id}/items'] = {
    post: { tags: ['Datasets'], summary: 'Add an entity to a dataset', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['entityType', 'entityId', 'entityTitle'], properties: { entityType: { type: 'string' }, entityId: { type: 'string' }, entityTitle: { type: 'string' }, note: { type: 'string' } } } } } }, responses: { 201: { description: 'Added' } }, security: [{ apiKey: [] }] }
  };
  paths['/v1/datasets/{id}/queries'] = {
    post: { tags: ['Datasets'], summary: 'Add a saved query (live filter) to a dataset', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['entityType', 'params'], properties: { entityType: { type: 'string', enum: [...ALL_DATA_TYPES] }, params: { type: 'object', additionalProperties: { type: 'string' } }, label: { type: 'string' } } } } } }, responses: { 201: { description: 'Added' } }, security: [{ apiKey: [] }] }
  };
  paths['/v1/datasets/{id}/export'] = {
    get: { tags: ['Datasets'], summary: 'Export a dataset (Pro)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } }], responses: { 200: { description: 'File' } }, security: [{ apiKey: [] }] }
  };
  paths['/v1/keys/usage'] = { get: { tags: ['Account'], summary: 'Your API usage and remaining quota', responses: { 200: { description: 'Usage' } }, security: [{ apiKey: [] }] } };
  paths['/v1/auth/me'] = { get: { tags: ['Account'], summary: 'The account behind the key or session', responses: { 200: { description: 'User' } }, security: [{ apiKey: [] }] } };

  return {
    openapi: '3.0.3',
    info: {
      title: 'Neuly Data API',
      version: API_VERSION,
      description: [
        'The complete, continuously refreshed data layer for psychedelic and natural medicine: clinical trials (interventional and observational), research papers and preprints, companies, executives and investigators, jobs, events, legislation, funding, grants, care providers, news, SEC filings and market quotes.',
        '',
        'Authenticate with `Authorization: Bearer nk_…` (create keys in your account). Quotas: ' +
        `Pro ${PLANS.pro.apiDailyQuota.toLocaleString()} requests/day, Enterprise ${PLANS.enterprise.apiDailyQuota.toLocaleString()} requests/day. ` +
        'Anonymous reads are allowed at a low per-IP rate for evaluation.',
        '',
        'Every list endpoint accepts the same filters the website uses, plus `page` and `limit`. Responses carry `X-RateLimit-*` headers.'
      ].join('\n')
    },
    servers: [{ url: `${siteUrl()}/api` }],
    tags: [
      { name: 'Data', description: 'Filterable tables' },
      { name: 'Derived', description: 'Computed views' },
      { name: 'Sync', description: 'Change feed and freshness for keeping a copy in sync' },
      { name: 'Bulk (Enterprise)', description: 'Whole-table downloads' },
      { name: 'Export (Pro)', description: 'CSV exports' },
      { name: 'Datasets', description: 'Your saved collections and live queries' },
      { name: 'Account' }
    ],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API key (nk_…) from your Neuly account' } }
    },
    paths
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Server-rendered API documentation (no third-party assets) */
export function renderDocsPage(): string {
  const site = siteUrl();
  const sections = ALL_DATA_TYPES.map(type => {
    const route = DATASET_ROUTES[type];
    const params = QUERY_PARAMS_BY_TYPE[type]
      .map(p => `<tr><td><code>${p.name}</code></td><td>${escapeHtml(p.description)}</td></tr>`).join('');
    const example = QUERY_PARAMS_BY_TYPE[type][0];
    const exampleValue = example?.name === 'substance' ? 'Psilocybin' : example?.name === 'role' ? 'Executive' : example?.name === 'type' ? (type === 'events' ? 'Conference' : type === 'jobs' ? 'Research' : 'Clinic') : example?.name === 'jurisdiction' ? 'CO' : example?.name === 'category' ? 'News' : example?.name === 'ticker' ? 'CMPS' : example?.name === 'level' ? 'Beginner' : 'psilocybin';
    return `
<section id="${route}">
  <h3><code>GET /api/v1/${route}</code></h3>
  <p class="muted">Table: <code>${type}</code>${type !== 'market_quotes' && type !== 'news' && type !== 'educational_resources' ? ` · single record: <code>GET /api/v1/${route}/{id}</code>` : ''} · bulk (Enterprise): <code>GET /api/v1/bulk/${type}</code></p>
  <table><thead><tr><th>Query parameter</th><th>Meaning</th></tr></thead><tbody>${params}
  <tr><td><code>page</code>, <code>limit</code></td><td>Pagination (limit ≤ 5000)</td></tr></tbody></table>
  <pre>curl "${site}/api/v1/${route}?${example?.name ?? 'search'}=${exampleValue}&amp;limit=5" \\
  -H "Authorization: Bearer $NEULY_API_KEY"</pre>
</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Neuly Data API — Documentation</title>
<meta name="description" content="REST API for the Neuly psychedelic medicine data layer: clinical trials, research, companies, people, policy, funding, jobs, news and market data with a change feed and bulk downloads.">
<link rel="canonical" href="${site}/docs">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a0f0d; color: #e8ebe9; font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 14px 24px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; gap: 20px; align-items: center; }
  header a { color: #a0a8a4; text-decoration: none; } header a.brand { color: #fff; font-weight: 700; font-size: 18px; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 34px; margin: 0 0 8px; } h2 { font-size: 22px; margin: 44px 0 10px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; }
  h3 { font-size: 17px; margin: 32px 0 6px; } .muted { color: #a0a8a4; font-size: 14px; }
  code { background: rgba(125,211,192,0.12); color: #7dd3c0; padding: 1px 6px; border-radius: 6px; font-size: 13.5px; }
  pre { background: #10161399; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px 16px; overflow-x: auto; font-size: 13px; color: #d7dcd9; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; font-size: 14px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: top; }
  th { color: #a0a8a4; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 18px 0; }
  .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 16px; }
  .card b { color: #fff; } .pill { display: inline-block; background: rgba(125,211,192,0.15); color: #7dd3c0; border-radius: 20px; padding: 2px 10px; font-size: 12px; margin-right: 6px; }
  nav.toc a { display: inline-block; margin: 0 10px 6px 0; color: #7dd3c0; text-decoration: none; font-size: 13.5px; }
  a { color: #7dd3c0; }
</style></head>
<body>
<header><a class="brand" href="/">Neuly</a><a href="/docs">API Docs</a><a href="/api/openapi.json">OpenAPI spec</a><a href="/pricing">Pricing</a><a href="/account">Your API keys</a></header>
<main>
<h1>Neuly Data API</h1>
<p class="muted">Version ${API_VERSION} · Base URL <code>${site}/api/v1</code> · <a href="/api/openapi.json">OpenAPI 3 spec</a></p>
<p>Programmatic access to the whole Neuly data layer: every clinical trial (interventional, observational and expanded access), research paper and preprint, company, executive and investigator, job, event, bill, funding round, grant, care provider, headline, SEC filing and stock quote we track — refreshed continuously by our crawlers and exposed with the same filters the website uses.</p>

<div class="grid">
  <div class="card"><b>Free</b><br><span class="muted">Anonymous evaluation at ${process.env.ANON_RATE_LIMIT_PER_MINUTE ?? 120} req/min per IP. No key.</span></div>
  <div class="card"><b>Pro — $${PLANS.pro.priceMonthly}/mo</b><br><span class="muted">${PLANS.pro.apiDailyQuota.toLocaleString()} requests/day, ${PLANS.pro.apiPerMinute}/min burst, CSV exports, full history.</span></div>
  <div class="card"><b>Enterprise — $${PLANS.enterprise.priceMonthly}/mo</b><br><span class="muted">${PLANS.enterprise.apiDailyQuota.toLocaleString()} requests/day, bulk table downloads, change-feed sync, multiple keys.</span></div>
</div>

<h2 id="auth">Authentication</h2>
<p>Create a key under <a href="/account">Account → API keys</a> (Pro and Enterprise). Send it as a bearer token; <code>?api_key=</code> also works for quick tests. Keys are shown once and stored hashed.</p>
<pre>curl "${site}/api/v1/clinical-trials?substance=Psilocybin&amp;phase=Phase%203" \\
  -H "Authorization: Bearer nk_your_key_here"</pre>
<p>Every response carries <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and <code>X-RateLimit-Reset</code>. A <code>429</code> means you hit the burst limit (wait for <code>Retry-After</code>) or the daily quota (resets 00:00 UTC). Usage is visible at <code>GET /api/v1/keys/usage</code>.</p>

<h2 id="shape">Response shape</h2>
<pre>{
  "data": [ { "id": "ct_nct05624268", "nctId": "NCT05624268", "title": "...", "status": "Recruiting", "phase": "Phase 3",
              "studyType": "INTERVENTIONAL", "substances": ["Psilocybin"], "sponsor": "COMPASS Pathways", "hasResults": false, ... } ],
  "total": 326, "page": 1, "limit": 50, "totalPages": 7
}</pre>

<h2 id="sync">Keeping a copy in sync</h2>
<p><code>GET /api/v1/changes?since=&lt;ISO timestamp&gt;</code> returns every <code>added</code> / <code>updated</code> / <code>removed</code> event the diff engine recorded after your cursor, newest first, with the fields that changed. Store the newest <code>detectedAt</code> and poll — or hold open <code>GET /api/v1/live</code> (Server-Sent Events) to receive change batches the moment a crawl lands. <code>GET /api/v1/freshness</code> tells you when each table last refreshed.</p>
<pre>curl "${site}/api/v1/changes?type=clinical_trials&amp;since=2026-10-01T00:00:00Z&amp;limit=500" \\
  -H "Authorization: Bearer $NEULY_API_KEY"</pre>

<h2 id="bulk">Bulk downloads (Enterprise)</h2>
<p>Each table streams in full as newline-delimited JSON (default), a JSON array, or CSV. Add <code>since</code> to receive only rows crawled after a timestamp.</p>
<pre>curl "${site}/api/v1/bulk/research_papers?format=ndjson" -H "Authorization: Bearer $NEULY_API_KEY" -o papers.ndjson
curl "${site}/api/v1/bulk/companies?format=csv"           -H "Authorization: Bearer $NEULY_API_KEY" -o companies.csv</pre>

<h2 id="datasets">Datasets</h2>
<p>Build your own datasets from the API or the website: hand-pick records with <code>POST /api/v1/datasets/{id}/items</code> or attach saved queries with <code>POST /api/v1/datasets/{id}/queries</code> (the same filter parameters as the list endpoints) and the dataset stays current as new rows match. <code>GET /api/v1/datasets/{id}</code> resolves everything to live rows; <code>/export?format=csv</code> downloads it.</p>
<pre>curl -X POST "${site}/api/v1/datasets" -H "Authorization: Bearer $NEULY_API_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Phase 3 psilocybin programs"}'
curl -X POST "${site}/api/v1/datasets/ds_…/queries" -H "Authorization: Bearer $NEULY_API_KEY" -H "Content-Type: application/json" \\
  -d '{"entityType":"clinical_trials","params":{"substance":"Psilocybin","phase":"Phase 3"}}'</pre>

<h2 id="tables">Tables</h2>
<nav class="toc">${ALL_DATA_TYPES.map(t => `<a href="#${DATASET_ROUTES[t]}">${t.replace(/_/g, ' ')}</a>`).join('')}</nav>
${sections}

<h2 id="derived">Derived endpoints</h2>
<table><tbody>
<tr><td><code>GET /api/v1/readouts</code></td><td>Trial readout calendar: expected results windows derived from completion dates (<code>phase</code>, <code>substance</code>, <code>horizonDays</code>).</td></tr>
<tr><td><code>GET /api/v1/search?q=</code></td><td>Top matches across every table.</td></tr>
<tr><td><code>GET /api/v1/dashboard</code></td><td>Counts, substance breakdowns and highlights.</td></tr>
<tr><td><code>GET /api/v1/stats</code>, <code>/freshness</code></td><td>Row counts, crawl history, per-table freshness and cadence.</td></tr>
</tbody></table>

<h2 id="sources">Sources</h2>
<p class="muted">ClinicalTrials.gov API v2 · PubMed / Europe PMC · bioRxiv, medRxiv and other preprint servers · OpenAlex · SEC EDGAR (submissions, full-text search, Forms D, 3/4/5, 8-K and periodic filings) · NIH RePORTER · LegiScan · Federal Register · Oregon Psilocybin Services · Greenhouse, Lever, Ashby and Workable job boards · Google News · exchange quotes. Every record carries <code>source</code> and <code>crawledAt</code>; derived people and companies carry <code>evidence</code>.</p>
<p class="muted">Terms: data is provided for research and commercial analysis under your plan; redistribution of bulk data requires an Enterprise agreement. Contact <a href="mailto:api@neuly.io">api@neuly.io</a>.</p>
</main></body></html>`;
}

export function publicApiRouter(storage: StorageBackend): Router {
  const router = Router();

  router.get('/api/openapi.json', (_req: Request, res: Response) => {
    res.json(buildOpenApiSpec());
  });

  router.get(['/docs', '/api/docs', '/api'], (_req: Request, res: Response) => {
    res.type('html').send(renderDocsPage());
  });

  /**
   * Bulk download: the whole table as NDJSON (default), JSON or CSV.
   * Enterprise only — this is the data-licensing product.
   */
  router.get('/api/bulk/:type', async (req: AuthedRequest, res: Response) => {
    const type = req.params.type as DataType;
    if (!ALL_DATA_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown table. Available: ${ALL_DATA_TYPES.join(', ')}` });
    }
    if (!req.user) return res.status(401).json({ error: 'An API key is required for bulk downloads', docs: '/docs#bulk' });
    const spec = planFor(req.user.plan);
    if (!spec.bulkDownloads) {
      return res.status(403).json({ error: 'Bulk downloads are included in the Enterprise plan', upgrade: '/pricing', plan: req.user.plan });
    }

    try {
      let rows = await storage.load(type);
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      if (since) rows = rows.filter(r => (r.crawledAt ?? '') >= since);
      rows = sortDataset(type, rows);

      const format = req.query.format === 'csv' ? 'csv' : req.query.format === 'json' ? 'json' : 'ndjson';
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('X-Neuly-Rows', String(rows.length));
      res.setHeader('Content-Disposition', `attachment; filename="neuly_${type}_${stamp}.${format === 'ndjson' ? 'ndjson' : format}"`);

      if (format === 'csv') {
        res.type('text/csv').send(toCsv(rows));
        return;
      }
      if (format === 'json') {
        res.json({ table: type, exportedAt: new Date().toISOString(), total: rows.length, data: rows });
        return;
      }
      res.type('application/x-ndjson');
      // Write in chunks so a 50k-row table never builds one giant string
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        res.write(rows.slice(i, i + CHUNK).map(r => JSON.stringify(r)).join('\n') + '\n');
      }
      res.end();
    } catch (error) {
      logger.error(`[api] bulk ${type} failed: ${error instanceof Error ? error.message : error}`);
      if (!res.headersSent) res.status(500).json({ error: 'Bulk download failed' });
    }
  });

  return router;
}

/**
 * Generic list handler shared by every table route: filter, sort, paginate.
 * Returns the standard envelope.
 */
export function listResponse(type: DataType, rows: CrawledData[], query: Record<string, unknown>, options: { maxLimit?: number; map?: (row: CrawledData) => CrawledData } = {}) {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (typeof v === 'string') params[k] = v;
  const filtered = sortDataset(type, filterDataset(type, rows, params));
  const page = Math.max(1, parseInt(params.page) || 1);
  const limit = Math.min(parseInt(params.limit) || 50, options.maxLimit ?? 5000);
  const start = (page - 1) * limit;
  const pageRows = filtered.slice(start, start + limit);
  return {
    data: options.map ? pageRows.map(options.map) : pageRows,
    total: filtered.length,
    page,
    limit,
    totalPages: Math.ceil(filtered.length / limit)
  };
}

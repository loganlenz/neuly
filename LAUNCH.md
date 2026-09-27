# Neuly Launch Runbook

The app is now fully live-data: the frontend renders only what the API serves,
the API serves what the crawlers collect, and the seed exists purely so the
site is never empty on first boot. There is no static-data mode anymore.

## Architecture at launch

```
Browser ── index.html (served by Express, React vendored locally)
              │  same-origin /api/*
Express (crawlers/src/server.ts) ── Postgres (or JSON files if no DATABASE_URL)
              ▲
Scheduler (crawlers/src/scheduler.ts) ── 14 crawlers on two lanes
                                         live: news every 15 min, quotes every 5 min
                                         bulk: registries/filings/literature hourly→daily
Browser ◀── /api/live (Server-Sent Events) ── web server polls the change log
            every 10s while anyone is connected and pushes new changes;
            open pages refetch only the datasets that changed
```

Cadences live in `crawlers/src/schedule.ts` (override any with
`SCHEDULE_<CRAWLER>`); `/api/freshness` and the **Industry Live → Data
Status** tab show the last successful crawl per dataset.

## Option A — Render (fastest, recommended)

1. Push this repo to GitHub (done if you're reading this on GitHub).
2. Go to https://dashboard.render.com/blueprints → **New Blueprint Instance**
   → connect `loganlenz/neuly`. Render reads `render.yaml` and creates:
   - `neuly-db` (Postgres)
   - `neuly-web` (API + frontend, health-checked at `/api/health`)
   - `neuly-scheduler` (worker; `RUN_ON_START=true` triggers a full crawl immediately)
3. First deploy: the web service migrates the schema, removes any legacy
   placeholder seed rows, seeds starter data (curated companies/people,
   recurring events, curated care providers, training programs), and serves
   the site. Within the first hour the scheduler's initial crawl — run in
   dependency order (trials → papers → grants → companies → funding → jobs
   → people → ...) — fills every dataset from ClinicalTrials.gov, PubMed,
   Europe PMC, SEC EDGAR, Federal Register, NIH RePORTER and the ATS boards.
4. Custom domain: neuly-web → Settings → Custom Domains → add your domain,
   then set the `SITE_URL` env var to it (drives sitemap/canonical/Stripe URLs).

## Option B — Anywhere with Docker

```bash
docker build -t neuly .
docker run -e DATABASE_URL=postgres://... -p 3001:3001 neuly                 # web
docker run -e DATABASE_URL=postgres://... -e RUN_ON_START=true neuly npm run schedule  # crawler worker
```

## Environment variables

| Variable | Service | Purpose |
|---|---|---|
| `DATABASE_URL` | both | Postgres; omit to fall back to JSON files (dev only) |
| `SESSION_SECRET` | web | cookie signing — required in production |
| `SITE_URL` | web | public URL for SEO pages, sitemap, Stripe redirects |
| `RESEND_API_KEY`, `MAIL_FROM` | web/scheduler | alert + newsletter email delivery |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ENTERPRISE`, `STRIPE_WEBHOOK_SECRET` | web | Pro/Enterprise billing |
| `LEGISCAN_API_KEY` | scheduler | state bill tracking (free key: legiscan.com/legiscan) |
| `NCBI_API_KEY` | scheduler | PubMed rate limit 3/s → 10/s |
| `OPENALEX_MAILTO` | scheduler | OpenAlex polite pool |
| `RUN_ON_START=true` | scheduler | crawl everything immediately on boot |
| `OREGON_PSILOCYBIN_API` | scheduler | override for the Oregon licensee directory endpoint (care crawler) |

## Launch-day checklist

- [ ] Blueprint deployed, `/api/health` returns `{"status":"ok"}`
- [ ] Site shows the **Live · synced …** badge (bottom-right, desktop) and
      Industry Live reads **STREAMING LIVE** (if a proxy buffers SSE it falls
      back to **LIVE · POLLING**, still refreshing every minute)
- [ ] First crawl finished — `/api/stats` shows thousands of trials and papers, 100+ companies, and no crawl errors in `crawlHistory`
- [ ] `SESSION_SECRET` set (Render generates it automatically)
- [ ] Custom domain + `SITE_URL` set; `https://<domain>/sitemap.xml` renders
- [ ] Google Search Console: submit sitemap (programmatic SEO pages are the funnel)
- [ ] LegiScan + NCBI keys added to the scheduler
- [ ] Resend key added; send yourself a test alert (`POST /api/alerts`)
- [ ] Stripe keys + webhook endpoint `https://<domain>/api/billing/webhook`
- [ ] Sign up through the site UI (Join Free), save a company, sign out and
      log back in — confirms accounts, sessions, and `/api/saves` end-to-end
- [ ] Sign up, save an alert, upgrade to Pro end-to-end once in production

## What shipped in the launch-readiness pass

- **Real accounts in the UI** — Join Free / Log In / Get Started open a
  signup/login modal wired to `/api/auth/*` with session cookies (works
  cross-origin too: `SameSite=None` cookies + CORS credentials in production).
- **Save/Follow persist** — every Save/Follow button writes to `/api/saves`
  (new `saved_items` table); the dashboard, Companies, and People "saved" /
  "following" tabs read it back.
- **No more demo content** — dashboard shows real change events from
  `/api/changes` and the user's real saved items; homepage substance counts
  come from `/api/dashboard`; person profiles list real papers matched by
  author name; the Care directory no longer displays invented ratings.
- **Research Agent is honest** — keyword search over the live papers/trials
  tables with linked sources; agents and query history persist locally.
- **All buttons work** — studies link to ClinicalTrials.gov, jobs to their
  ATS posting, events/courses/providers to their sites.

## Real-time industry layer

- **Industry Live page** (`● Live` in the nav): streamed change feed, news,
  SEC filings, stock quotes, policy, funding, grants, readouts, and a
  per-dataset data-status panel. The homepage and every company profile
  carry a live band (quote + latest headlines/filings).
- **News crawler** — Google News (substance, regulatory and per-company
  searches, quote-page spam filtered) plus every recent material SEC filing
  (8-K/6-K with item labels, 10-Q/10-K/20-F, S-1/S-3/424B, Form 4 insider
  trades, 13D/13G) by tracked companies.
- **Market crawler** — delayed quotes + 1-month history for every listed
  company. Tickers follow the SEC's current CIK→ticker map (renames such
  as MindMed→DFTX are automatic) and a quote is only attributed when the
  listing name matches the company, so recycled symbols (NUMI is now a
  Nuveen ETF) and stale listings are dropped. Big moves (±5/10/20%) land in
  the change log and alerts.
- **Alerts** now dispatch hourly instead of daily.

## Known post-launch work (in priority order)

1. **Research Agent LLM synthesis** — answers are currently transparent
   keyword search + real sources; a server-side LLM endpoint could add
   narrative synthesis on top.
2. Remaining datasets from `RELAUNCH_BUILD_PLAN.md` Part 1 (legislation,
   funding, grants, readouts already have API endpoints — build their pages).
3. Per-user activity tracking (page views, queries) if wanted on the
   dashboard alongside saved items.

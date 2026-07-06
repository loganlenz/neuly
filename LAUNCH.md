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
Scheduler (crawlers/src/scheduler.ts) ── 11 crawlers on cron cadences
```

## Option A — Render (fastest, recommended)

1. Push this repo to GitHub (done if you're reading this on GitHub).
2. Go to https://dashboard.render.com/blueprints → **New Blueprint Instance**
   → connect `loganlenz/neuly`. Render reads `render.yaml` and creates:
   - `neuly-db` (Postgres)
   - `neuly-web` (API + frontend, health-checked at `/api/health`)
   - `neuly-scheduler` (worker; `RUN_ON_START=true` triggers a full crawl immediately)
3. First deploy: the web service migrates the schema, seeds starter data,
   and serves the site. Within the first hour the scheduler's initial crawl
   replaces seed data with live data from ClinicalTrials.gov, PubMed, SEC
   EDGAR, Federal Register, NIH RePORTER, bioRxiv/medRxiv, and the ATS boards.
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

## Launch-day checklist

- [ ] Blueprint deployed, `/api/health` returns `{"status":"ok"}`
- [ ] Site shows the **Live Data** badge (bottom-right, desktop)
- [ ] First crawl finished — dashboard counts exceed seed values (8/8/15/15/12/12)
- [ ] `SESSION_SECRET` set (Render generates it automatically)
- [ ] Custom domain + `SITE_URL` set; `https://<domain>/sitemap.xml` renders
- [ ] Google Search Console: submit sitemap (programmatic SEO pages are the funnel)
- [ ] LegiScan + NCBI keys added to the scheduler
- [ ] Resend key added; send yourself a test alert (`POST /api/alerts`)
- [ ] Stripe keys + webhook endpoint `https://<domain>/api/billing/webhook`
- [ ] Sign up, save an alert, upgrade to Pro end-to-end once in production

## Known post-launch work (in priority order)

1. **Research Agent answers are canned** — wire `ResearchAgentPage` to a real
   LLM endpoint (server-side, keyed) that searches the papers/trials tables.
2. **Dashboard "Recent Activity" and "Saved Items" are demo content** — needs
   per-user activity tracking (the auth system already exists).
3. **Save/Follow buttons are visual only** — persist per-user in Postgres.
4. Remaining datasets from `RELAUNCH_BUILD_PLAN.md` Part 1 (legislation,
   funding, grants, readouts already have API endpoints — build their pages).

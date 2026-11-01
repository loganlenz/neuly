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
Status** tab show the last successful crawl per dataset. ClinicalTrials.gov
is pulled two ways: an hourly incremental crawl of every study whose record
changed in the last 3 days (`trials-recent`) and a full sweep every 6 hours
(`clinicaltrials`) — all statuses, interventional and observational studies,
expanded-access programs, posted results and stop reasons included. Admins
can also trigger any crawler on demand from `/admin`.

```
Users ── /api/auth (signup, login, reset, profile) ── roles: user | admin
      ── /api/datasets  user-built datasets (picked items + live saved queries,
                        export, public share links)
      ── /api/keys      API keys (Pro / Enterprise) + usage metering
      ── /api/v1/*      public REST API (same handlers, versioned prefix),
                        /api/openapi.json, /docs, /api/v1/bulk/:table (Enterprise)
      ── /api/billing   Stripe plans / checkout / portal / webhook
      ── /api/admin     operator console: users, plan overrides, crawler control, audit
```

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
   then set the `SITE_URL` env var to it (drives sitemap/canonical/Stripe URLs
   and password-reset links).
5. Set `ADMIN_EMAILS` to your email on neuly-web, sign up through the site,
   and open `/admin` — you can comp plans, add admins and trigger crawls there.

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
| `ADMIN_EMAILS` | web | comma-separated operator emails promoted to the admin role |
| `CORS_ORIGINS` | web | allowed browser origins when the frontend is hosted elsewhere (unset = any) |
| `PLAN_PRICE_PRO`, `PLAN_PRICE_ENTERPRISE` | web | display prices on `/pricing` (defaults 79 / 499) |
| `API_QUOTA_PRO`, `API_QUOTA_ENTERPRISE` | web | API requests per day per plan (defaults 2,000 / 100,000) |
| `ANON_RATE_LIMIT_PER_MINUTE`, `SESSION_RATE_LIMIT_PER_MINUTE` | web | web traffic limits (defaults 120 / 600) |
| `CT_RECENT_DAYS` | scheduler | window for the hourly incremental ClinicalTrials.gov crawl (default 3) |
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
- [ ] `ADMIN_EMAILS` set; `/admin` loads for your account and a "Run a crawler now" request finishes
- [ ] Stripe webhook events enabled: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`
- [ ] Create an API key on a Pro account, call `https://<domain>/api/v1/clinical-trials?limit=1` with it, and see `X-RateLimit-*` headers
- [ ] `/docs` and `/api/openapi.json` render; share one dataset publicly and open its link signed out
- [ ] Forgot-password email arrives (Resend) and the link on `/reset-password` works

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

## What shipped in the launch-completion pass

- **ClinicalTrials.gov, completely** — every status (terminated/withdrawn/
  suspended trials are now tracked, with the sponsor's stop reason), study
  type (interventional, observational, expanded access) with observational
  model and time perspective, allocation/masking/purpose, results-posted flag
  and date. Hourly incremental refresh + 6-hourly full sweep; 13 new queries
  target observational studies, registries and real-world evidence.
- **People at companies, from the SEC** — officers and directors of every
  tracked public company are pulled from Forms 3/4/5 (structured ownership
  XML: name, officer title, director flag, as-of date) and the related persons
  on private companies' Form D filings. People carry `companyIds` and
  `affiliations` with provenance; company profiles show the leadership team
  (`/api/companies/:id` returns `leadership`, `people`, `trials`, `jobs`,
  `fundingEvents`); `/api/people?company=` filters by company.
- **Accounts & permissions** — roles (`user` / `admin`, bootstrapped from
  `ADMIN_EMAILS`), forgot/reset password by email (single-use, 1h tokens),
  profile + newsletter preference, change password, delete account, audit
  log, brute-force rate limits on credential endpoints, CORS allowlist,
  security headers, trust-proxy, JSON body limits.
- **User datasets** — `/datasets`: named collections of hand-picked records
  (the "+ Dataset" button on every company/person/study card) and live saved
  queries that resolve against the latest crawl; CSV/JSON export (Pro),
  public share links (Pro) at `/datasets/shared/:slug`, plan limits (Free:
  1 dataset / 50 items / 2 queries).
- **The API product** — `/api/v1/*` versioned alias of every endpoint,
  API keys for Pro (2,000/day, 120/min) and Enterprise (100,000/day,
  600/min) with per-day metering, `X-RateLimit-*` headers, anonymous per-IP
  limits, `/api/keys/usage`, `/api/openapi.json`, a server-rendered `/docs`
  page, and `/api/v1/bulk/:table` NDJSON/JSON/CSV downloads (Enterprise).
  Every list endpoint shares one filter implementation
  (`src/web/dataQuery.ts`) with the UI and saved queries.
- **Billing** — `/api/billing/plans` (plan catalog from `src/web/plans.ts`),
  checkout reuses the Stripe customer, webhook handles subscription
  created/updated/deleted, invoice paid/failed (`plan_status` = past_due),
  `/pricing` page, Account → Plan & Billing with portal access.
- **Operator console** — `/admin`: users with plan/role overrides, business
  overview (signups, plans, estimated MRR, API traffic), run-any-crawler-now
  (queued in `crawl_requests`, picked up by the scheduler within 30s), data
  freshness, audit log.
- **Frontend** — real URLs for every app page (`/pricing`, `/account`,
  `/datasets`, `/admin`, `/reset-password`, `/datasets/shared/:slug`),
  Account page (profile, billing, API keys + usage, alerts, security),
  Datasets pages, pricing page, forgot-password flow, study-type filter and
  results/observational chips on Studies, SEC-sourced leadership on company
  profiles, toasts.

## Known post-launch work (in priority order)

1. **Research Agent LLM synthesis** — answers are currently transparent
   keyword search + real sources; a server-side LLM endpoint could add
   narrative synthesis on top.
2. Remaining datasets from `RELAUNCH_BUILD_PLAN.md` Part 1 (legislation,
   funding, grants, readouts already have API endpoints — build their pages).
3. Per-user activity tracking (page views, queries) if wanted on the
   dashboard alongside saved items.

# Neuly Relaunch Build Plan

**Goal: relaunch Neuly as the complete data layer for the psychedelics industry.**

This is the gap analysis between what's in the repo today and "all of the data available for the psychedelics industry," plus the infrastructure needed to serve it as a product (see `MONETIZATION.md` for why each dataset matters commercially).

## Where the platform stands today

| Component | Status | Gap |
|---|---|---|
| ClinicalTrials.gov crawler | Working | US registry only |
| PubMed crawler | Working | No preprints, no citation graph |
| Company crawler (SEC EDGAR) | Working | Public companies only; no private cos, no funding data |
| Jobs crawler | Working | **Only 5 hardcoded companies** (COMPASS, MindMed, Cybin, atai, Numinus) |
| Events crawler | Mostly hardcoded list | No live scraping of event sources |
| People crawler | Hardcoded key figures + PubMed authors | No affiliations graph, no exec/board coverage |
| Storage | Flat JSON files (`DataStorage`) | No database, no history, no relations |
| Server | Express serving JSON + static `index.html` | No auth, no API keys, no rate limits |
| Frontend | Single 2,774-line `index.html` | No SEO pages, no accounts, no gating |
| Change detection / alerts | None | Blocks newsletter + paid alerts |
| Entity resolution | None | Same company/person appears disconnected across sources |

---

## Part 1 — Data sources to add (the "ALL the data" list)

### A. Regulatory & policy (highest value, most requested in this space)

1. **State legislation tracker** — LegiScan API (free tier available) filtered to psilocybin/MDMA/psychedelic/ketamine bills; track status changes per bill. This is the sector's single most-cited resource.
2. **State program data** — Oregon Psilocybin Services and Colorado Natural Medicine Division publish **public license lists** (service centers, facilitators, manufacturers). Structured, free, and nobody has productized them well.
3. **FDA actions** — Drugs@FDA API + FDA press releases: breakthrough therapy designations, IND/NDA milestones, advisory committee calendar, CRLs.
4. **DEA** — scheduling actions and Federal Register notices (Federal Register has a clean free API).
5. **International** — Health Canada Special Access Program news, Australia TGA (MDMA/psilocybin already rescheduled there), EMA/CTIS.

### B. Research & clinical (deepen what exists)

6. **Trial registries beyond ClinicalTrials.gov** — EU CTIS, ISRCTN, ANZCTR; or WHO ICTRP for one-stop international coverage. "All trials" requires this.
7. **Trial readout calendar** — derived dataset: expected readout windows from primary-completion dates already being crawled. The sector's "earnings calendar."
8. **Preprints** — bioRxiv/medRxiv/PsyArXiv APIs (research appears here 6–18 months before PubMed).
9. **NIH grants** — NIH RePORTER API for psychedelic research funding (who's funded, how much, at which institution). Leading indicator of future trials and papers.
10. **Citation enrichment** — OpenAlex or Semantic Scholar APIs (both free) for citation counts, author disambiguation, and institution links. Also largely solves author entity resolution for the People dataset.

### C. Companies & capital markets

11. **Private company & funding tracker** — SEC Form D filings (already have EDGAR plumbing), press-release monitoring (GlobeNewswire/PR Newswire RSS + company IR pages), manual curation queue. Crunchbase-style coverage for a few hundred psychedelic companies is achievable and defensible.
12. **Market data for public companies** — daily prices for the ~30 public tickers (Polygon/Alpha Vantage or exchange feeds), plus insider transactions (Form 4) and institutional holdings (13F) via existing EDGAR access.
13. **Patents** — USPTO PatentsView API + Google Patents BigQuery, by substance/assignee. Pharma competitive-intelligence teams pay directly for this.

### D. Care delivery (the consumer/clinic side)

14. **Clinic & practitioner directory** — the Care Directory needs real data: Google Places seeded searches ("ketamine clinic" per metro), SPRAVATO treatment-center locator, state facilitator license lists (Oregon/Colorado from #2), practitioner training-program graduate registries (MAPS/Fluence/Integrative Psychiatry Institute). Target: 2,500+ US locations, verified.
15. **Retreat centers** — legal-jurisdiction retreats (Jamaica, Netherlands, Costa Rica, Mexico); curated dataset with verification status.
16. **Pricing data** — self-reported + scraped treatment pricing per clinic; unique dataset nobody has at scale.

### E. Jobs, events, people (finish what's started)

17. **Jobs at scale** — auto-discover ATS boards (Greenhouse/Lever/Ashby/Workable all have public JSON endpoints) for every company in the companies table, instead of the 5 hardcoded slugs.
18. **Events via scraping** — replace the hardcoded list with scrapers for conference sites, university event calendars, and Eventbrite/Lu.ma keyword searches.
19. **People graph** — expand beyond researchers: executives and boards from SEC filings (DEF 14A), LinkedIn-free approach via press releases and company sites; link people ↔ papers ↔ trials ↔ companies.

### F. The synthesis layer (where the moat actually is)

20. **Molecule/pipeline database** — the canonical table: molecule × company × indication × phase × next catalyst. Partly derived from trials + filings, partly curated. This is the page investors screenshot.
21. **Entity resolution** — one canonical ID per company/person/molecule across all 19 sources above. Without this you have feeds; with it you have a graph no competitor can rebuild quickly.
22. **Change detection** — diff every crawl against the previous state; emit typed events ("trial NCT05xxxx moved to Phase 3", "new Form D: $12M raise"). Powers alerts, the newsletter, and the API webhook product.

---

## Part 2 — Infrastructure to build

### 1. Database (replaces `DataStorage` JSON files) — *first, everything depends on it*
- Postgres (Supabase or RDS). Tables per entity + `entity_links` + `events` (change log) + `sources` (provenance on every row).
- Keep Zod schemas in `src/models/types.ts` as the validation layer; add a thin repository layer so crawlers write to Postgres instead of JSON.
- Full-text search via Postgres `tsvector` initially; Typesense/Meilisearch later if needed.

### 2. Crawl orchestration
- Scheduled runs (node-cron or hosted cron) with per-source cadence: trials daily, filings hourly on weekdays, bills daily, prices EOD, PubMed weekly.
- Incremental crawling (since-last-run cursors) instead of full refetch; retry queues; per-source freshness dashboards.

### 3. The diff/alert engine
- After each crawl: compare normalized rows to prior state → write typed change events → fan out to (a) user alert subscriptions, (b) weekly newsletter draft generator, (c) API webhooks. This one component powers three revenue features.

### 4. Application platform (replace the monolithic `index.html`)
- Next.js app: keeps the existing dashboard experience, adds **programmatic SEO pages** — one page per substance × indication, per company, per trial, per state, per clinic. Thousands of indexable pages generated from the database = the organic-traffic funnel.
- Auth (Supabase Auth or Clerk), Stripe billing, plan-based feature gating (free / Pro / Enterprise per `MONETIZATION.md`).
- Public REST API with keys, rate limits, and usage metering (the Enterprise product).

### 5. Data-quality & curation tooling
- Admin UI (Retool or a simple internal Next.js route) for: merge/split entity duplicates, verify clinics, approve curated records (events, retreats, key people).
- Provenance + `last_verified` on every record; freshness badges in the UI (trust is the product).

### 6. Newsletter pipeline
- Weekly job: change events → templated draft ("3 new Phase 2 trials, 2 filings, 14 jobs, 1 new state bill") → human review → send via Resend/Beehiiv. Near-zero marginal cost; it's the funnel.

---

## Part 3 — Build order

**Phase 1 (weeks 1–4): Foundation**
Postgres migration + repository layer; crawl scheduler; diff engine skeleton; jobs crawler ATS auto-discovery (quick win: 5 companies → every company tracked).

**Phase 2 (weeks 4–10): The datasets that sell subscriptions**
Legislation tracker (LegiScan + Federal Register); Oregon/Colorado license data; readout calendar; Form D funding tracker; preprints; NIH grants; OpenAlex enrichment (also fixes people dedup).

**Phase 3 (weeks 8–14, overlaps): Product surface**
Next.js app with programmatic SEO pages; auth + Stripe + gating; alerts UI; newsletter pipeline live.

**Phase 4 (weeks 12–20): Depth & enterprise**
International registries (WHO ICTRP); patents; market data + Form 4/13F; clinic directory at scale + pricing; molecule/pipeline database; public API with keys; admin curation UI.

**Ongoing:** entity resolution improves continuously; curation queue staffed ~5 hrs/week initially.

## Part 4 — What NOT to build

- **Scraping LinkedIn or paywalled databases** — legal risk, fragile, and the public-source graph above is defensible without it.
- **A general web crawler** — every source listed has an API or stable public structure; stay targeted.
- **Real-time streaming infra** — daily/hourly batch is fully sufficient for this market; don't pay the complexity tax.
- **Mobile apps** — the audience is desktop-professional; responsive web wins.

## Success criteria for "relaunch-ready"

1. Every dataset in Part 1 sections A–C live with automated refresh (D–F can trail).
2. Any entity page (company, molecule, trial, state) answers "what changed recently?" — the diff engine working end to end.
3. 1,000+ programmatic SEO pages indexed.
4. A user can sign up, save an alert, receive it by email, and upgrade to Pro without human involvement.
5. Coverage strictly exceeds Psychedelic Alpha's free trackers on bills, trials, and licenses — the paywall justification.

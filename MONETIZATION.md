# Neuly Monetization Strategy

**The Blockworks playbook, applied to natural medicine.**

Blockworks started as crypto journalism, built audience trust with free media and events, then went all-in on a data/research subscription — Blockworks Research — sold at ~$2,500/seat to institutions. Their key structural advantage: **negative customer acquisition cost**, because their own editorial audience (monetized with ads while it converts) is the top of the sales funnel. Roughly half their revenue comes from events, the rest from media and the fast-growing research subscription (ARR grew >500% in a year).

Neuly already has the hard part Blockworks had to build second: **the data layer**. The crawler system ingests clinical trials (ClinicalTrials.gov), peer-reviewed research (PubMed), company/SEC filings (EDGAR), jobs (Greenhouse/Lever), events, and people profiles across 10 tracked substances and 16 indications. What's missing is the audience funnel and the packaging into products people pay for.

---

## 1. Positioning: niche down before expanding

Blockworks' lesson is not "cover crypto" — it's "own a niche so completely that professionals can't work without you." Neuly's current data pipeline is psychedelic/natural-medicine specific. **Own "the data platform for psychedelic & natural medicine" first.** The broader alternative-health space (supplements, functional medicine, longevity) is a later expansion once the playbook is proven — each vertical reuses the same crawler architecture with new sources.

Why this niche is timable right now:

- Psychedelic medicine market: ~$5.5B in 2026, projected ~$26B by 2035 (~19% CAGR).
- Ketamine clinics alone: ~$1.6B market, 2,500+ US locations, growing ~11%/yr.
- FDA-track catalysts (MDMA, psilocybin programs) create Bloomberg-terminal-style demand: investors, biotech BD teams, and clinic operators all need to track trials, readouts, filings, and state-by-state legalization in real time.
- Competition is thin and under-built: Psychedelic Alpha is editorial-first at $200/yr with free trackers; HealingMaps sells one-off clinic reports. Nobody owns the structured, continuously-updated, queryable data layer. That's the Blockworks Research gap.

## 2. Revenue streams, ranked

### Tier 1 — Core engine (build now)

**A. Neuly Pro — B2B data & research subscription.** The flagship. Package the crawler data into professional workflows:

| Persona | Killer use case | What they pay for |
|---|---|---|
| Investors / funds | Track trial readouts, SEC filings, pipeline phases across COMPASS, MindMed, Cybin, atai, etc. | Readout calendar, filing alerts, company comps, pipeline database |
| Biotech BD / competitive intelligence | Who's running what trial, with which molecule, at which site | Trial + patent + people graph, sponsor pipelines |
| Clinic operators & investors | Where to open, what competitors charge, regulatory status by state | Clinic directory data, state legalization tracker, demand signals |
| Researchers / pharma | Literature + trial landscape by substance × indication | Structured search, citation graphs, saved research agents |

Pricing (anchored between Psychedelic Alpha's $200/yr prosumer tier and Blockworks' $2,500/seat enterprise):
- **Free**: dashboard with delayed/limited data, weekly newsletter — the funnel.
- **Pro — $49–99/mo**: full data access, alerts, saved searches, research agent, exports.
- **Enterprise — $5k–15k/yr per team**: API access, custom reports, analyst calls, CRM-ready datasets (contacts from the People crawler are genuinely valuable here).

**B. Free editorial + newsletter as the funnel.** A weekly data-driven brief ("what changed this week in psychedelic medicine: 3 new Phase 2 trials, 2 SEC filings, 14 new jobs") is nearly free to produce because the crawlers already surface the deltas. This is the negative-CAC channel: sponsors pay for placement while the audience converts to Pro. Auto-drafting the brief from crawler diffs is a 1–2 week build.

### Tier 2 — High-margin adjacencies (months 3–9)

**C. Care Directory lead-gen.** The "Find Legal Plant Medicine Therapy" page is a local-intent SEO asset. 2,500+ ketamine clinics compete for patients; charge clinics $99–299/mo for enhanced listings, booking links, and lead routing. HealingMaps proves demand (85k+ patient searches) but monetizes crudely with one-off reports. Directory revenue also funds the data-quality work that makes the B2B product better.

**D. Jobs board.** Already crawling Greenhouse/Lever. Free aggregated listings for traffic; $199–499 per featured post, or bundle into Enterprise. Niche job boards in hot verticals convert well because employers have nowhere else concentrated to post.

**E. Sponsored placements.** Newsletter sponsorships, category sponsorships on the dashboard ("Clinical Trials data presented by ___"). Standard media revenue while subscription ARR builds — this was most of Blockworks' early revenue.

### Tier 3 — Compounding plays (year 1+)

**F. Events.** Half of Blockworks' revenue. Start with quarterly virtual summits (readout previews, state-regulation panels) sold to sponsors, using the Events crawler data and People database for programming and invitations. Graduate to an annual in-person conference once the newsletter has 10k+ engaged subscribers.

**G. Data licensing / API.** Sell the structured datasets (trials × substances × indications, clinic directory, funding/filings) to hedge funds, pharma CI teams, and academic groups. Low marginal cost once the Pro API exists.

**H. Education marketplace.** The Courses page monetizes via revenue-share with training providers (practitioner certification is a real and growing spend), not by producing courses in-house.

### Explicitly deprioritize

- Consumer subscriptions for the dashboard (willingness to pay is low; free consumer traffic is worth more as funnel + directory demand).
- E-commerce/supplements (off-thesis, regulatory risk, crowded).
- Producing original long-form journalism (expensive; let the data generate the content instead).

## 3. Data moats to deepen (crawler roadmap)

The subscription is only defensible if the data is better than what a competitor can rebuild in a quarter. Highest-leverage additions to `crawlers/`:

1. **State/country legalization & regulation tracker** — the single most-cited resource in this space (Psychedelic Alpha's bill tracker is their top asset, and it's free — do it better and gate the alerts).
2. **Trial readout calendar** — derive expected readout dates from ClinicalTrials.gov completion dates; this is the "earnings calendar" for the sector and the #1 investor feature.
3. **Funding rounds & private company tracker** — Crunchbase-style coverage of private psychedelic companies (press releases, Form D filings).
4. **Patent crawler** — USPTO filings by substance/company; pharma CI teams pay directly for this.
5. **Entity resolution across sources** — link the same company/person/molecule across trials, papers, filings, and jobs. This graph is the real moat; raw feeds are commodities.
6. **Change-detection & alerting** — the diff engine that powers both the newsletter and paid alerts.

## 4. Sequencing (first 12 months)

| Phase | Focus | Revenue target |
|---|---|---|
| **0–3 mo** | Ship free dashboard publicly, launch weekly auto-generated newsletter, add legalization tracker + readout calendar. Instrument everything. | $0 — build the funnel |
| **3–6 mo** | Launch Pro ($49–99/mo) gating alerts, exports, research agent, full history. Start directory listings + job posts. First newsletter sponsors. | First $5–20k MRR |
| **6–12 mo** | Enterprise tier + API for funds/pharma CI. First virtual summit. Entity-resolution graph. | $30–80k MRR blended |
| **12 mo+** | Annual event; expand to adjacent vertical (e.g., medical cannabis clinical data or longevity clinics) reusing the crawler stack. | Diversified, Blockworks-shaped |

## 5. Success metrics

- Newsletter subscribers and weekly open rate (the funnel).
- Free → Pro conversion (target 2–5% of active users).
- Net revenue retention on Enterprise (the business lives or dies here).
- Data coverage vs. Psychedelic Alpha's free trackers (must be strictly better to justify the paywall).

## 6. Risks

- **Regulatory whiplash** (e.g., FDA setbacks) can freeze investor interest — the clinic/practitioner side (directory, jobs, education) hedges the investor side.
- **Free incumbents**: Psychedelic Alpha gives trackers away. Compete on structure, freshness, and workflow (alerts, API, exports), not on having the data at all.
- **Small TAM today**: the professional audience is thousands, not millions — which is fine for a $5–15k enterprise price point, but means the consumer funnel and events matter for scale.

---

*Sources: Blockworks model — CNBC, A Media Operator, The Rebooting, Semafor (2023–2026 coverage). Market sizing — Mordor Intelligence, Coherent Market Insights, Business Research Insights (2026 reports). Competitors — psychedelicalpha.com, healingmaps.com.*

import { Router, Request, Response } from 'express';
import { StorageBackend } from '../utils/storageBackend.js';
import { ClinicalTrial, ResearchPaper, Company, JobPosting, LegislationBill, SUBSTANCES } from '../models/types.js';
import { deriveReadoutCalendar } from '../core/readouts.js';
import { logger } from '../utils/logger.js';

/**
 * Programmatic SEO pages — server-rendered, crawlable pages generated
 * from the database: one per substance, company, trial, and jurisdiction,
 * plus the readout calendar. This is the organic-traffic funnel.
 */

function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface PageMeta {
  title: string;
  description: string;
  path: string;
  jsonLd?: object;
}

function layout(meta: PageMeta, body: string): string {
  const canonical = `${siteUrl()}${meta.path}`;
  const jsonLd = meta.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escapeHtml(meta.title)}">
<meta property="og:description" content="${escapeHtml(meta.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Neuly">
${jsonLd}
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; color: #1a1f1d; line-height: 1.6; }
  header { background: #1a1f1d; padding: 14px 24px; }
  header a { color: #fff; text-decoration: none; margin-right: 20px; font-size: 15px; }
  header a.brand { font-weight: 700; font-size: 18px; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 32px; line-height: 1.2; margin: 0 0 8px; }
  h2 { font-size: 20px; margin-top: 36px; border-bottom: 1px solid #e4e7e5; padding-bottom: 6px; }
  .lede { color: #4a524e; font-size: 17px; margin-bottom: 24px; }
  ul.items { padding-left: 0; list-style: none; }
  ul.items li { padding: 10px 0; border-bottom: 1px solid #f0f2f1; }
  ul.items small { color: #6a736e; display: block; }
  .tag { display: inline-block; background: #eef4f0; color: #2c5a3f; border-radius: 12px; padding: 1px 10px; font-size: 13px; margin: 2px 6px 2px 0; text-decoration: none; }
  footer { text-align: center; color: #6a736e; font-size: 13px; padding: 24px; border-top: 1px solid #e4e7e5; }
  a { color: #2c5a3f; }
</style>
</head>
<body>
<header>
  <a class="brand" href="/">Neuly</a>
  <a href="/substances/psilocybin">Substances</a>
  <a href="/readouts-calendar">Readout Calendar</a>
  <a href="/policy/us-federal">Policy</a>
</header>
<main>
${body}
</main>
<footer>Data: ClinicalTrials.gov, PubMed, bioRxiv/medRxiv, SEC EDGAR, Federal Register, LegiScan, NIH RePORTER · Updated continuously by the Neuly platform</footer>
</body>
</html>`;
}

function itemList(items: string[]): string {
  return `<ul class="items">${items.join('\n')}</ul>`;
}

function notFound(res: Response, what: string): void {
  res.status(404).send(layout(
    { title: `Not found — Neuly`, description: `${what} not found`, path: '/404' },
    `<h1>Not found</h1><p>We don't have a page for this ${what.toLowerCase()} yet. <a href="/">Back to Neuly</a></p>`
  ));
}

export function seoRouter(storage: StorageBackend): Router {
  const router = Router();

  // ---------- substance pages ----------
  router.get('/substances/:slug', async (req: Request, res: Response) => {
    try {
      const substance = SUBSTANCES.find(s => slugify(s) === req.params.slug);
      if (!substance) return notFound(res, 'Substance');

      const [trials, papers, companies] = await Promise.all([
        storage.load<ClinicalTrial>('clinical_trials'),
        storage.load<ResearchPaper>('research_papers'),
        storage.load<Company>('companies')
      ]);

      const subTrials = trials.filter(t => t.substances.includes(substance));
      const subPapers = papers.filter(p => p.substances.includes(substance));
      const subCompanies = companies.filter(c => (c.substances as string[] | undefined)?.includes(substance));
      const readouts = deriveReadoutCalendar(subTrials, { horizonDays: 365 });

      const activeCount = subTrials.filter(t => ['Recruiting', 'Active, Not Recruiting', 'Enrolling by Invitation'].includes(t.status)).length;
      const description = `${substance} in psychedelic medicine: ${subTrials.length} clinical trials (${activeCount} active), ${subPapers.length} research papers, and ${subCompanies.length} companies tracked by Neuly.`;

      const body = [
        `<h1>${substance} — Clinical Trials, Research &amp; Companies</h1>`,
        `<p class="lede">${description}</p>`,

        readouts.length > 0 ? `<h2>Upcoming Readouts</h2>${itemList(readouts.slice(0, 10).map(r =>
          `<li><a href="/trials/${escapeHtml(r.nctId)}">${escapeHtml(r.title)}</a><small>${r.phase ?? ''} · expected ${r.expectedReadoutStart} – ${r.expectedReadoutEnd} · ${escapeHtml(r.sponsor ?? '')}</small></li>`
        ))}` : '',

        `<h2>Clinical Trials (${subTrials.length})</h2>`,
        itemList(subTrials.slice(0, 25).map(t =>
          `<li><a href="/trials/${escapeHtml(t.nctId)}">${escapeHtml(t.title)}</a><small>${escapeHtml([t.phase, t.status, t.sponsor].filter(Boolean).join(' · '))}</small></li>`
        )),

        `<h2>Recent Research (${subPapers.length})</h2>`,
        itemList(subPapers
          .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
          .slice(0, 25)
          .map(p => `<li>${p.url ? `<a href="${escapeHtml(p.url)}" rel="noopener">${escapeHtml(p.title)}</a>` : escapeHtml(p.title)}<small>${escapeHtml([p.journal, p.year?.toString()].filter(Boolean).join(' · '))}</small></li>`
        )),

        subCompanies.length > 0 ? `<h2>Companies (${subCompanies.length})</h2>${itemList(subCompanies.map(c =>
          `<li><a href="/company-profiles/${slugify(c.name)}">${escapeHtml(c.name)}</a><small>${escapeHtml([c.type, c.stage].filter(Boolean).join(' · '))}</small></li>`
        ))}` : '',

        `<h2>All Substances</h2><p>${SUBSTANCES.filter(s => s !== 'Other').map(s => `<a class="tag" href="/substances/${slugify(s)}">${s}</a>`).join(' ')}</p>`
      ].join('\n');

      res.send(layout({
        title: `${substance} Clinical Trials, Research & Companies — Neuly`,
        description,
        path: `/substances/${req.params.slug}`,
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: `${substance} in psychedelic medicine`,
          description
        }
      }, body));
    } catch (error) {
      logger.error(`[seo] substance page failed: ${error}`);
      res.status(500).send('Internal error');
    }
  });

  // ---------- trial pages ----------
  router.get('/trials/:nctId', async (req: Request, res: Response) => {
    try {
      const trials = await storage.load<ClinicalTrial>('clinical_trials');
      const trial = trials.find(t => t.nctId.toLowerCase() === req.params.nctId.toLowerCase());
      if (!trial) return notFound(res, 'Trial');

      const readout = deriveReadoutCalendar([trial], { horizonDays: 3650, lookbackDays: 3650 })[0];
      const description = `${trial.title} — ${[trial.phase, trial.status, trial.sponsor].filter(Boolean).join(', ')}. Conditions: ${trial.conditions.join(', ')}.`.slice(0, 300);

      const facts: string[] = [
        `<li><strong>Status</strong><small>${escapeHtml(trial.status)}</small></li>`,
        trial.phase ? `<li><strong>Phase</strong><small>${escapeHtml(trial.phase)}</small></li>` : '',
        trial.sponsor ? `<li><strong>Sponsor</strong><small>${escapeHtml(trial.sponsor)}</small></li>` : '',
        trial.enrollment ? `<li><strong>Enrollment</strong><small>${trial.enrollment} participants</small></li>` : '',
        trial.primaryCompletionDate ? `<li><strong>Primary completion</strong><small>${escapeHtml(trial.primaryCompletionDate)}</small></li>` : '',
        readout ? `<li><strong>Expected readout window</strong><small>${readout.expectedReadoutStart} – ${readout.expectedReadoutEnd}</small></li>` : ''
      ].filter(Boolean);

      const body = [
        `<h1>${escapeHtml(trial.title)}</h1>`,
        `<p class="lede">${trial.substances.map(s => `<a class="tag" href="/substances/${slugify(s)}">${s}</a>`).join(' ')}</p>`,
        `<h2>Key Facts</h2>`,
        itemList(facts),
        trial.briefSummary ? `<h2>Summary</h2><p>${escapeHtml(trial.briefSummary)}</p>` : '',
        `<p><a href="${escapeHtml(trial.url)}" rel="noopener">View on ClinicalTrials.gov (${escapeHtml(trial.nctId)})</a></p>`
      ].join('\n');

      res.send(layout({
        title: `${trial.title.slice(0, 90)} — ${trial.nctId} — Neuly`,
        description,
        path: `/trials/${trial.nctId}`,
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'MedicalTrial',
          name: trial.title,
          status: trial.status,
          phase: trial.phase,
          sponsor: trial.sponsor ? { '@type': 'Organization', name: trial.sponsor } : undefined,
          url: trial.url
        }
      }, body));
    } catch (error) {
      logger.error(`[seo] trial page failed: ${error}`);
      res.status(500).send('Internal error');
    }
  });

  // ---------- company pages ----------
  router.get('/company-profiles/:slug', async (req: Request, res: Response) => {
    try {
      const [companies, trials, jobs] = await Promise.all([
        storage.load<Company>('companies'),
        storage.load<ClinicalTrial>('clinical_trials'),
        storage.load<JobPosting>('jobs')
      ]);

      const company = companies.find(c => slugify(c.name) === req.params.slug);
      if (!company) return notFound(res, 'Company');

      const companyTrials = trials.filter(t => t.sponsor && slugify(t.sponsor).includes(req.params.slug));
      const companyJobs = jobs.filter(j => slugify(j.company) === req.params.slug);
      const description = (company.description
        ?? `${company.name}: ${company.type} company in psychedelic medicine.`).slice(0, 300);

      const body = [
        `<h1>${escapeHtml(company.name)}</h1>`,
        `<p class="lede">${escapeHtml([company.type, company.stage, company.ticker ? `$${company.ticker}` : undefined].filter(Boolean).join(' · '))}</p>`,
        company.description ? `<p>${escapeHtml(company.description)}</p>` : '',
        (company.substances as string[] | undefined)?.length
          ? `<p>${(company.substances as string[]).map(s => `<a class="tag" href="/substances/${slugify(s)}">${s}</a>`).join(' ')}</p>` : '',

        companyTrials.length > 0 ? `<h2>Sponsored Trials (${companyTrials.length})</h2>${itemList(companyTrials.slice(0, 20).map(t =>
          `<li><a href="/trials/${escapeHtml(t.nctId)}">${escapeHtml(t.title)}</a><small>${escapeHtml([t.phase, t.status].filter(Boolean).join(' · '))}</small></li>`
        ))}` : '',

        companyJobs.length > 0 ? `<h2>Open Roles (${companyJobs.length})</h2>${itemList(companyJobs.slice(0, 20).map(j =>
          `<li>${j.applicationUrl ? `<a href="${escapeHtml(j.applicationUrl)}" rel="noopener">${escapeHtml(j.title)}</a>` : escapeHtml(j.title)}<small>${escapeHtml([j.type, j.location?.city, j.location?.remote ? 'Remote' : undefined].filter(Boolean).join(' · '))}</small></li>`
        ))}` : ''
      ].join('\n');

      res.send(layout({
        title: `${company.name} — Pipeline, Trials & Jobs — Neuly`,
        description,
        path: `/company-profiles/${req.params.slug}`,
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: company.name,
          description,
          tickerSymbol: company.ticker
        }
      }, body));
    } catch (error) {
      logger.error(`[seo] company page failed: ${error}`);
      res.status(500).send('Internal error');
    }
  });

  // ---------- policy pages ----------
  router.get('/policy/:jurisdiction', async (req: Request, res: Response) => {
    try {
      const bills = await storage.load<LegislationBill>('legislation');
      const slug = req.params.jurisdiction.toLowerCase();
      const jurisdictionBills = bills.filter(b => b.jurisdiction.toLowerCase() === slug);
      if (jurisdictionBills.length === 0) return notFound(res, 'Jurisdiction');

      const label = slug === 'us-federal' ? 'Federal (US)' : slug.toUpperCase();
      const description = `Psychedelic policy tracker for ${label}: ${jurisdictionBills.length} bills and regulatory actions tracked, updated daily from LegiScan and the Federal Register.`;

      const sorted = [...jurisdictionBills].sort((a, b) => (b.lastActionDate ?? '').localeCompare(a.lastActionDate ?? ''));
      const jurisdictions = Array.from(new Set(bills.map(b => b.jurisdiction))).sort();

      const body = [
        `<h1>Psychedelic Policy — ${escapeHtml(label)}</h1>`,
        `<p class="lede">${escapeHtml(description)}</p>`,
        itemList(sorted.slice(0, 50).map(b =>
          `<li><a href="${escapeHtml(b.url)}" rel="noopener">${escapeHtml(b.billNumber)}: ${escapeHtml(b.title)}</a><small>${escapeHtml([b.status, b.lastAction, b.lastActionDate].filter(Boolean).join(' · '))}</small></li>`
        )),
        `<h2>Other Jurisdictions</h2><p>${jurisdictions.map(j => `<a class="tag" href="/policy/${slugify(j)}">${escapeHtml(j)}</a>`).join(' ')}</p>`
      ].join('\n');

      res.send(layout({
        title: `Psychedelic Policy Tracker: ${label} — Neuly`,
        description,
        path: `/policy/${slug}`
      }, body));
    } catch (error) {
      logger.error(`[seo] policy page failed: ${error}`);
      res.status(500).send('Internal error');
    }
  });

  // ---------- readout calendar ----------
  router.get('/readouts-calendar', async (_req: Request, res: Response) => {
    try {
      const trials = await storage.load<ClinicalTrial>('clinical_trials');
      const readouts = deriveReadoutCalendar(trials);
      const description = `Upcoming psychedelic clinical trial readouts: ${readouts.length} expected results windows derived from trial completion dates. The sector's earnings calendar.`;

      const body = [
        `<h1>Psychedelic Trial Readout Calendar</h1>`,
        `<p class="lede">${escapeHtml(description)}</p>`,
        itemList(readouts.slice(0, 50).map(r =>
          `<li><a href="/trials/${escapeHtml(r.nctId)}">${escapeHtml(r.title)}</a><small>expected ${r.expectedReadoutStart} – ${r.expectedReadoutEnd} · ${escapeHtml([r.phase, r.sponsor].filter(Boolean).join(' · '))} · ${r.substances.map(escapeHtml).join(', ')}</small></li>`
        ))
      ].join('\n');

      res.send(layout({
        title: 'Psychedelic Clinical Trial Readout Calendar — Neuly',
        description,
        path: '/readouts-calendar'
      }, body));
    } catch (error) {
      logger.error(`[seo] readout calendar failed: ${error}`);
      res.status(500).send('Internal error');
    }
  });

  // ---------- robots + sitemap ----------
  router.get('/robots.txt', (_req: Request, res: Response) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${siteUrl()}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', async (_req: Request, res: Response) => {
    try {
      const [trials, companies, bills] = await Promise.all([
        storage.load<ClinicalTrial>('clinical_trials'),
        storage.load<Company>('companies'),
        storage.load<LegislationBill>('legislation')
      ]);

      const urls = new Set<string>(['/', '/readouts-calendar']);
      for (const s of SUBSTANCES) {
        if (s !== 'Other') urls.add(`/substances/${slugify(s)}`);
      }
      for (const t of trials) urls.add(`/trials/${t.nctId}`);
      for (const c of companies) urls.add(`/company-profiles/${slugify(c.name)}`);
      for (const j of new Set(bills.map(b => b.jurisdiction))) urls.add(`/policy/${slugify(j)}`);

      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...Array.from(urls).map(u => `  <url><loc>${siteUrl()}${escapeHtml(u)}</loc></url>`),
        '</urlset>'
      ].join('\n');

      res.type('application/xml').send(xml);
    } catch (error) {
      logger.error(`[seo] sitemap failed: ${error}`);
      res.status(500).send('Internal error');
    }
  });

  return router;
}

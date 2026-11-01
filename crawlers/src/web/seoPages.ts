import { Router, Request, Response } from 'express';
import { StorageBackend } from '../utils/storageBackend.js';
import {
  ClinicalTrial, ResearchPaper, Company, Person, JobPosting, Event, LegislationBill, FundingEvent, Grant,
  CareProvider, NewsItem, SUBSTANCES
} from '../models/types.js';
import { deriveReadoutCalendar } from '../core/readouts.js';
import type { AuthedRequest } from '../auth/auth.js';
import { logger } from '../utils/logger.js';

/**
 * Server-rendered pages — every entity on Neuly has its own URL.
 *
 * Substances, trials, companies, policy and the readout calendar have had
 * pages since launch; this adds a page for every item that can appear in
 * the live feed (news, filings, bills, funding rounds, grants, papers, jobs,
 * events, care providers, people), each summarising the record on Neuly
 * before linking out to the original source.
 *
 * Gating: anonymous visitors see the summary (the SEO funnel) with lists
 * truncated and outbound links routed to sign-up; signed-in users get the
 * full page and an interstitial before leaving Neuly.
 */

function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(text: string | undefined | null): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Where an entity lives on Neuly. Exported: the SPA mirrors this mapping. */
export function entityPath(type: string, item: { id: string; nctId?: string; name?: string }): string {
  switch (type) {
    case 'clinical_trials': return `/trials/${encodeURIComponent(item.nctId ?? item.id)}`;
    case 'companies': return `/company-profiles/${slugify(item.name ?? item.id)}`;
    case 'research_papers': return `/papers/${encodeURIComponent(item.id)}`;
    case 'people': return `/people/${encodeURIComponent(item.id)}`;
    case 'jobs': return `/jobs/${encodeURIComponent(item.id)}`;
    case 'events': return `/events/${encodeURIComponent(item.id)}`;
    case 'legislation': return `/bills/${encodeURIComponent(item.id)}`;
    case 'funding_events': return `/funding/${encodeURIComponent(item.id)}`;
    case 'grants': return `/grants/${encodeURIComponent(item.id)}`;
    case 'care_providers': return `/care/${encodeURIComponent(item.id)}`;
    case 'news': return `/news/${encodeURIComponent(item.id)}`;
    case 'market_quotes': return `/company-profiles/${slugify(item.name ?? item.id)}`;
    default: return '/';
  }
}

interface PageMeta {
  title: string;
  description: string;
  path: string;
  jsonLd?: object;
  /** Primary outbound source link, rendered through the interstitial */
  source?: { url: string; label: string };
  /** Entity for the view log + lead forms on the SPA side */
  entity?: { type: string; id: string; title: string };
}

interface PageContext {
  signedIn: boolean;
}

const ANON_LIST_ROWS = 3;

/** Truncate a list for anonymous visitors and append the sign-up nudge */
function gatedList(ctx: PageContext, items: string[], total: number, label: string): string {
  const shown = ctx.signedIn ? items : items.slice(0, ANON_LIST_ROWS);
  const list = `<ul class="items">${shown.join('\n')}</ul>`;
  if (ctx.signedIn || total <= shown.length) return list;
  return `${list}<p class="gate"><a class="btn" href="/?auth=signup">Create a free account</a> to see all ${total.toLocaleString()} ${escapeHtml(label)}.</p>`;
}

function sourceLink(ctx: PageContext, source: PageMeta['source']): string {
  if (!source) return '';
  return ctx.signedIn
    ? `<p><a class="btn" data-external href="${escapeHtml(source.url)}" rel="noopener">${escapeHtml(source.label)} ↗</a></p>`
    : `<p class="gate">The original is available to Neuly members. <a class="btn" href="/?auth=signup&next=${encodeURIComponent(source.url)}">Create a free account</a> or <a href="/?auth=login">log in</a> to continue to ${escapeHtml(source.label)}.</p>`;
}

function layout(meta: PageMeta, body: string, ctx: PageContext): string {
  const canonical = `${siteUrl()}${meta.path}`;
  const jsonLd = meta.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`
    : '';
  const entityScript = meta.entity
    ? `<script>window.__neulyEntity=${JSON.stringify(meta.entity)};</script>`
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
${entityScript}
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0a0f0d; color: #e8ebe9; line-height: 1.6; }
  header { background: rgba(10,15,13,0.95); border-bottom: 1px solid rgba(255,255,255,0.08); padding: 14px 24px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  header a { color: #a0a8a4; text-decoration: none; font-size: 15px; }
  header a.brand { color: #fff; font-weight: 700; font-size: 18px; }
  header a.cta { margin-left: auto; background: #7dd3c0; color: #0a0f0d; font-weight: 600; padding: 8px 16px; border-radius: 10px; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; color: #fff; }
  h2 { font-size: 19px; margin-top: 36px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; color: #fff; }
  .lede { color: #a0a8a4; font-size: 17px; margin-bottom: 20px; }
  .kicker { color: #7dd3c0; font-size: 12px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 10px; }
  ul.items { padding-left: 0; list-style: none; }
  ul.items li { padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
  ul.items small { color: #6b7370; display: block; }
  ul.items strong { color: #fff; }
  .tag { display: inline-block; background: rgba(125,211,192,0.12); color: #7dd3c0; border-radius: 12px; padding: 1px 10px; font-size: 13px; margin: 2px 6px 2px 0; text-decoration: none; }
  .btn { display: inline-block; background: #7dd3c0; color: #0a0f0d; font-weight: 600; padding: 10px 18px; border-radius: 10px; text-decoration: none; }
  .gate { background: rgba(125,211,192,0.08); border: 1px solid rgba(125,211,192,0.3); border-radius: 12px; padding: 14px 16px; color: #a0a8a4; }
  .summary { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 18px 20px; }
  .avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; float: right; margin: 0 0 12px 16px; border: 2px solid rgba(255,255,255,0.1); }
  footer { text-align: center; color: #6b7370; font-size: 13px; padding: 24px; border-top: 1px solid rgba(255,255,255,0.08); }
  a { color: #7dd3c0; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
  .modal { background: #141918; border: 1px solid rgba(255,255,255,0.12); border-radius: 18px; padding: 26px; max-width: 440px; width: 100%; }
  .modal h3 { margin: 0 0 8px; color: #fff; } .modal p { color: #a0a8a4; font-size: 14px; word-break: break-all; }
  .modal .row { display: flex; gap: 10px; margin-top: 18px; } .modal .ghost { background: transparent; color: #7dd3c0; border: 1px solid rgba(125,211,192,0.4); }
</style>
</head>
<body>
<header>
  <a class="brand" href="/">Neuly</a>
  <a href="/live">Live</a>
  <a href="/studies">Studies</a>
  <a href="/companies">Companies</a>
  <a href="/people">People</a>
  <a href="/care">Care</a>
  <a href="/readouts-calendar">Readouts</a>
  ${ctx.signedIn ? '<a class="cta" href="/dashboard">Dashboard</a>' : '<a class="cta" href="/?auth=signup">Join free</a>'}
</header>
<main>
${body}
</main>
<footer>Data: ClinicalTrials.gov, PubMed, Europe PMC, preprint servers, OpenAlex, SEC EDGAR, Federal Register, LegiScan, NIH RePORTER, state regulators, company websites · Updated continuously by the Neuly platform · <a href="/docs">API</a></footer>
<div class="modal-bg" id="leave"><div class="modal"><h3>You're leaving Neuly</h3><p>This link goes to an external site Neuly does not control:</p><p id="leave-url"></p><div class="row"><a class="btn" id="leave-go" href="#" rel="noopener" target="_blank">Continue</a><button class="btn ghost" id="leave-stay">Stay on Neuly</button></div></div></div>
<script>
(function(){
  var bg=document.getElementById('leave'),go=document.getElementById('leave-go'),url=document.getElementById('leave-url');
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a[href]'); if(!a) return;
    var href=a.getAttribute('href')||''; if(!/^https?:/i.test(href)) return;
    try{ if(new URL(href).host===location.host) return; }catch(_){ return; }
    e.preventDefault(); url.textContent=href; go.setAttribute('href',href); bg.style.display='flex';
  });
  document.getElementById('leave-stay').onclick=function(){ bg.style.display='none'; };
  bg.addEventListener('click',function(e){ if(e.target===bg) bg.style.display='none'; });
  go.addEventListener('click',function(){ bg.style.display='none'; });
})();
</script>
</body>
</html>`;
}

function notFound(res: Response, what: string, ctx: PageContext): void {
  res.status(404).send(layout(
    { title: `Not found — Neuly`, description: `${what} not found`, path: '/404' },
    `<h1>Not found</h1><p>We don't have a page for this ${what.toLowerCase()} yet. <a href="/">Back to Neuly</a></p>`,
    ctx
  ));
}

const fact = (label: string, value: string | number | undefined | null) =>
  value === undefined || value === null || value === '' ? '' : `<li><strong>${escapeHtml(label)}</strong><small>${escapeHtml(String(value))}</small></li>`;

const chips = (substances: readonly string[] | undefined) =>
  (substances ?? []).filter(s => s !== 'Other').map(s => `<a class="tag" href="/substances/${slugify(s)}">${escapeHtml(s)}</a>`).join(' ');

const ctxOf = (req: Request): PageContext => ({ signedIn: Boolean((req as AuthedRequest).user) });

export function seoRouter(storage: StorageBackend): Router {
  const router = Router();

  const handle = (what: string, fn: (req: Request, res: Response, ctx: PageContext) => Promise<void>) =>
    async (req: Request, res: Response) => {
      const ctx = ctxOf(req);
      try {
        await fn(req, res, ctx);
      } catch (error) {
        logger.error(`[seo] ${what} page failed: ${error instanceof Error ? error.message : error}`);
        res.status(500).send('Internal error');
      }
    };

  // ---------- substance pages ----------
  router.get('/substances/:slug', handle('substance', async (req, res, ctx) => {
    const substance = SUBSTANCES.find(s => slugify(s) === req.params.slug);
    if (!substance) return notFound(res, 'Substance', ctx);

    const [trials, papers, companies] = await Promise.all([
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<ResearchPaper>('research_papers'),
      storage.load<Company>('companies')
    ]);

    const subTrials = trials.filter(t => t.substances.includes(substance));
    const subPapers = papers.filter(p => p.substances.includes(substance)).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    const subCompanies = companies.filter(c => (c.substances as string[] | undefined)?.includes(substance));
    const readouts = deriveReadoutCalendar(subTrials, { horizonDays: 365 });

    const activeCount = subTrials.filter(t => ['Recruiting', 'Active, Not Recruiting', 'Enrolling by Invitation'].includes(t.status)).length;
    const description = `${substance} in psychedelic medicine: ${subTrials.length} clinical trials (${activeCount} active), ${subPapers.length} research papers, and ${subCompanies.length} companies tracked by Neuly.`;

    const body = [
      `<h1>${substance} — Clinical Trials, Research &amp; Companies</h1>`,
      `<p class="lede">${description}</p>`,
      readouts.length > 0 ? `<h2>Upcoming Readouts</h2>${gatedList(ctx, readouts.slice(0, 10).map(r =>
        `<li><a href="/trials/${escapeHtml(r.nctId)}">${escapeHtml(r.title)}</a><small>${r.phase ?? ''} · expected ${r.expectedReadoutStart} – ${r.expectedReadoutEnd} · ${escapeHtml(r.sponsor ?? '')}</small></li>`
      ), readouts.length, 'readouts')}` : '',
      `<h2>Clinical Trials (${subTrials.length})</h2>`,
      gatedList(ctx, subTrials.slice(0, 25).map(t =>
        `<li><a href="/trials/${escapeHtml(t.nctId)}">${escapeHtml(t.title)}</a><small>${escapeHtml([t.phase, t.status, t.studyType === 'OBSERVATIONAL' ? 'Observational' : undefined, t.sponsor].filter(Boolean).join(' · '))}</small></li>`
      ), subTrials.length, 'trials'),
      `<h2>Recent Research (${subPapers.length})</h2>`,
      gatedList(ctx, subPapers.slice(0, 25).map(p =>
        `<li><a href="/papers/${encodeURIComponent(p.id)}">${escapeHtml(p.title)}</a><small>${escapeHtml([p.journal, p.year?.toString()].filter(Boolean).join(' · '))}</small></li>`
      ), subPapers.length, 'papers'),
      subCompanies.length > 0 ? `<h2>Companies (${subCompanies.length})</h2>${gatedList(ctx, subCompanies.map(c =>
        `<li><a href="/company-profiles/${slugify(c.name)}">${escapeHtml(c.name)}</a><small>${escapeHtml([c.type, c.stage].filter(Boolean).join(' · '))}</small></li>`
      ), subCompanies.length, 'companies')}` : '',
      `<h2>All Substances</h2><p>${SUBSTANCES.filter(s => s !== 'Other').map(s => `<a class="tag" href="/substances/${slugify(s)}">${s}</a>`).join(' ')}</p>`
    ].join('\n');

    res.send(layout({
      title: `${substance} Clinical Trials, Research & Companies — Neuly`,
      description,
      path: `/substances/${req.params.slug}`,
      jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${substance} in psychedelic medicine`, description }
    }, body, ctx));
  }));

  // ---------- trial pages ----------
  router.get('/trials/:nctId', handle('trial', async (req, res, ctx) => {
    const [trials, people] = await Promise.all([storage.load<ClinicalTrial>('clinical_trials'), storage.load<Person>('people')]);
    const trial = trials.find(t => t.nctId.toLowerCase() === req.params.nctId.toLowerCase() || t.id === req.params.nctId);
    if (!trial) return notFound(res, 'Trial', ctx);

    const readout = deriveReadoutCalendar([trial], { horizonDays: 3650, lookbackDays: 3650 })[0];
    const description = `${trial.title} — ${[trial.phase, trial.status, trial.studyType === 'OBSERVATIONAL' ? 'observational study' : undefined, trial.sponsor].filter(Boolean).join(', ')}. Conditions: ${trial.conditions.join(', ')}.`.slice(0, 300);
    const officials = (trial.officials ?? []).map(o => {
      const match = people.find(p => p.name.toLowerCase().includes(o.name.toLowerCase().split(',')[0]));
      return `<li>${match ? `<a href="/people/${encodeURIComponent(match.id)}">${escapeHtml(o.name)}</a>` : `<strong>${escapeHtml(o.name)}</strong>`}<small>${escapeHtml([o.role, o.affiliation].filter(Boolean).join(' · '))}</small></li>`;
    });
    const sites = (trial.locations ?? []).map(l => `<li><strong>${escapeHtml(l.facility ?? 'Site')}</strong><small>${escapeHtml([l.city, l.state, l.country].filter(Boolean).join(', '))}</small></li>`);

    const body = [
      `<div class="kicker">Clinical ${trial.studyType === 'OBSERVATIONAL' ? 'observational study' : trial.studyType === 'EXPANDED_ACCESS' ? 'expanded access program' : 'trial'} · ${escapeHtml(trial.nctId)}</div>`,
      `<h1>${escapeHtml(trial.title)}</h1>`,
      `<p class="lede">${chips(trial.substances)}</p>`,
      `<h2>Key Facts</h2><ul class="items">`,
      fact('Status', trial.status), fact('Phase', trial.phase), fact('Study type', trial.studyType), fact('Design', [trial.allocation, trial.masking, trial.primaryPurpose].filter(Boolean).join(' · ')),
      fact('Sponsor', trial.sponsor), fact('Collaborators', trial.collaborators?.join(', ')), fact('Enrollment', trial.enrollment ? `${trial.enrollment} participants` : undefined),
      fact('Conditions', trial.conditions.join(', ')), fact('Start', trial.startDate), fact('Primary completion', trial.primaryCompletionDate),
      readout ? fact('Expected readout window', `${readout.expectedReadoutStart} – ${readout.expectedReadoutEnd}`) : '',
      fact('Results posted', trial.hasResults ? `Yes${trial.resultsFirstPostDate ? ` (${trial.resultsFirstPostDate})` : ''}` : undefined), fact('Why stopped', trial.whyStopped),
      `</ul>`,
      trial.briefSummary ? `<h2>Summary</h2><div class="summary">${escapeHtml(trial.briefSummary)}</div>` : '',
      ctx.signedIn && trial.detailedDescription ? `<h2>Detailed description</h2><p>${escapeHtml(trial.detailedDescription)}</p>` : '',
      ctx.signedIn && trial.eligibilityCriteria ? `<h2>Eligibility</h2><p style="white-space:pre-line">${escapeHtml(trial.eligibilityCriteria)}</p>` : '',
      officials.length ? `<h2>Investigators</h2>${gatedList(ctx, officials, officials.length, 'investigators')}` : '',
      sites.length ? `<h2>Sites (${sites.length})</h2>${gatedList(ctx, sites, sites.length, 'sites')}` : '',
      ctx.signedIn && ['Recruiting', 'Not Yet Recruiting', 'Enrolling by Invitation'].includes(trial.status)
        ? `<p class="gate">Interested in participating? <a class="btn" href="/studies?interest=${encodeURIComponent(trial.id)}">Tell the study team</a></p>` : '',
      sourceLink(ctx, { url: trial.url, label: `View on ClinicalTrials.gov (${trial.nctId})` })
    ].join('\n');

    res.send(layout({
      title: `${trial.title.slice(0, 90)} — ${trial.nctId} — Neuly`,
      description,
      path: `/trials/${trial.nctId}`,
      entity: { type: 'clinical_trials', id: trial.id, title: trial.title },
      jsonLd: { '@context': 'https://schema.org', '@type': 'MedicalTrial', name: trial.title, status: trial.status, phase: trial.phase, sponsor: trial.sponsor ? { '@type': 'Organization', name: trial.sponsor } : undefined, url: trial.url }
    }, body, ctx));
  }));

  // ---------- company pages ----------
  router.get('/company-profiles/:slug', handle('company', async (req, res, ctx) => {
    const [companies, trials, jobs, people, news, funding] = await Promise.all([
      storage.load<Company>('companies'),
      storage.load<ClinicalTrial>('clinical_trials'),
      storage.load<JobPosting>('jobs'),
      storage.load<Person>('people'),
      storage.load<NewsItem>('news'),
      storage.load<FundingEvent>('funding_events')
    ]);

    const company = companies.find(c => slugify(c.name) === req.params.slug);
    if (!company) return notFound(res, 'Company', ctx);
    const nameLc = company.name.toLowerCase();

    const companyTrials = trials.filter(t => t.sponsor && slugify(t.sponsor).includes(req.params.slug));
    const companyJobs = jobs.filter(j => slugify(j.company) === req.params.slug);
    const team = people.filter(p => p.companyIds?.includes(company.id));
    const companyNews = news.filter(n => n.companies.some(c => c.toLowerCase() === nameLc)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const rounds = funding.filter(f => (company.cik && f.cik && f.cik.replace(/^0+/, '') === company.cik.replace(/^0+/, '')) || f.companyName.toLowerCase() === nameLc);
    const description = (company.description ?? `${company.name}: ${company.type} company in psychedelic medicine.`).slice(0, 300);

    const body = [
      `<div class="kicker">Company${company.ticker ? ` · $${escapeHtml(company.ticker)}` : ''}</div>`,
      `<h1>${escapeHtml(company.name)}</h1>`,
      `<p class="lede">${escapeHtml([company.type, company.stage, company.headquarters ? [company.headquarters.city, company.headquarters.country].filter(Boolean).join(', ') : undefined].filter(Boolean).join(' · '))}</p>`,
      company.description ? `<div class="summary">${escapeHtml(company.description)}</div>` : '',
      `<p>${chips(company.substances)}</p>`,
      team.length > 0 ? `<h2>Leadership (${team.length})</h2>${gatedList(ctx, team.map(p =>
        `<li><a href="/people/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a><small>${escapeHtml(p.affiliations?.find(a => a.companyId === company.id)?.role ?? p.title ?? '')}${p.affiliations?.find(a => a.companyId === company.id)?.source ? ` · via ${escapeHtml(p.affiliations.find(a => a.companyId === company.id)!.source!)}` : ''}</small></li>`
      ), team.length, 'leaders')}` : '',
      companyTrials.length > 0 ? `<h2>Sponsored Trials (${companyTrials.length})</h2>${gatedList(ctx, companyTrials.slice(0, 20).map(t =>
        `<li><a href="/trials/${escapeHtml(t.nctId)}">${escapeHtml(t.title)}</a><small>${escapeHtml([t.phase, t.status].filter(Boolean).join(' · '))}</small></li>`
      ), companyTrials.length, 'trials')}` : '',
      companyNews.length > 0 ? `<h2>News &amp; Filings (${companyNews.length})</h2>${gatedList(ctx, companyNews.slice(0, 15).map(n =>
        `<li><a href="/news/${encodeURIComponent(n.id)}">${escapeHtml(n.title)}</a><small>${escapeHtml([n.publisher, n.publishedAt.slice(0, 10)].filter(Boolean).join(' · '))}</small></li>`
      ), companyNews.length, 'items')}` : '',
      rounds.length > 0 ? `<h2>Funding filings (${rounds.length})</h2>${gatedList(ctx, rounds.map(f =>
        `<li><a href="/funding/${encodeURIComponent(f.id)}">Form ${escapeHtml(f.formType)} · ${escapeHtml(f.filedAt)}</a><small>${f.totalAmountSold ? `$${f.totalAmountSold.toLocaleString()} sold` : ''}</small></li>`
      ), rounds.length, 'filings')}` : '',
      companyJobs.length > 0 ? `<h2>Open Roles (${companyJobs.length})</h2>${gatedList(ctx, companyJobs.slice(0, 20).map(j =>
        `<li><a href="/jobs/${encodeURIComponent(j.id)}">${escapeHtml(j.title)}</a><small>${escapeHtml([j.type, j.location?.city, j.location?.remote ? 'Remote' : undefined].filter(Boolean).join(' · '))}</small></li>`
      ), companyJobs.length, 'roles')}` : '',
      company.website ? sourceLink(ctx, { url: company.website, label: `Visit ${company.name}` }) : ''
    ].join('\n');

    res.send(layout({
      title: `${company.name} — Pipeline, Leadership, Trials & Jobs — Neuly`,
      description,
      path: `/company-profiles/${req.params.slug}`,
      entity: { type: 'companies', id: company.id, title: company.name },
      jsonLd: { '@context': 'https://schema.org', '@type': 'Organization', name: company.name, description, tickerSymbol: company.ticker, url: company.website }
    }, body, ctx));
  }));

  // ---------- people ----------
  router.get('/people/:id', handle('person', async (req, res, ctx) => {
    const [people, companies, papers] = await Promise.all([
      storage.load<Person>('people'),
      storage.load<Company>('companies'),
      storage.load<ResearchPaper>('research_papers')
    ]);
    const person = people.find(p => p.id === req.params.id);
    if (!person) return notFound(res, 'Person', ctx);
    const linked = companies.filter(c => person.companyIds?.includes(c.id));
    const last = person.name.replace(/,.*$/, '').split(/\s+/).filter(w => w.length > 2 && !/^(dr|prof|phd|md)\.?$/i.test(w)).pop()?.toLowerCase();
    const pubs = last ? papers.filter(p => p.authors.some(a => a.name.toLowerCase().includes(last))).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)) : [];
    const description = [person.title, person.organization, person.bio].filter(Boolean).join(' · ').slice(0, 300) || `${person.name} on Neuly`;

    const body = [
      person.imageUrl ? `<img class="avatar" src="${escapeHtml(person.imageUrl)}" alt="${escapeHtml(person.name)}">` : '',
      `<div class="kicker">${escapeHtml(person.role)}</div>`,
      `<h1>${escapeHtml(person.name)}</h1>`,
      `<p class="lede">${escapeHtml([person.title, person.organization].filter(Boolean).join(' · '))}</p>`,
      person.bio ? `<div class="summary">${escapeHtml(person.bio)}</div>` : '',
      `<p>${chips(person.expertise)}</p>`,
      (person.affiliations ?? []).length > 0 ? `<h2>Affiliations</h2><ul class="items">${(person.affiliations ?? []).map(a =>
        `<li>${a.companyId && linked.find(c => c.id === a.companyId) ? `<a href="/company-profiles/${slugify(linked.find(c => c.id === a.companyId)!.name)}">${escapeHtml(a.organization)}</a>` : `<strong>${escapeHtml(a.organization)}</strong>`}<small>${escapeHtml([a.role, a.source ? `via ${a.source}` : undefined, a.asOf].filter(Boolean).join(' · '))}</small></li>`
      ).join('')}</ul>` : '',
      pubs.length > 0 ? `<h2>Publications in the Neuly corpus (${pubs.length})</h2>${gatedList(ctx, pubs.slice(0, 20).map(p =>
        `<li><a href="/papers/${encodeURIComponent(p.id)}">${escapeHtml(p.title)}</a><small>${escapeHtml([p.journal, p.year?.toString()].filter(Boolean).join(' · '))}</small></li>`
      ), pubs.length, 'papers')}` : '',
      (person.evidence ?? []).length > 0 && ctx.signedIn ? `<h2>Evidence</h2><ul class="items">${(person.evidence ?? []).slice(0, 10).map(e => `<li><small>${escapeHtml(e)}</small></li>`).join('')}</ul>` : '',
      person.imageUrl && person.imageAttribution ? `<p><small style="color:#6b7370">Photo: ${escapeHtml(person.imageSource ?? '')} — ${escapeHtml(person.imageAttribution)}</small></p>` : '',
      person.website ? sourceLink(ctx, { url: person.website, label: 'Website' }) : ''
    ].join('\n');

    res.send(layout({
      title: `${person.name} — ${[person.title, person.organization].filter(Boolean).join(', ') || 'Neuly'} — Neuly`,
      description,
      path: `/people/${encodeURIComponent(person.id)}`,
      entity: { type: 'people', id: person.id, title: person.name },
      jsonLd: { '@context': 'https://schema.org', '@type': 'Person', name: person.name, jobTitle: person.title, affiliation: person.organization, image: person.imageUrl }
    }, body, ctx));
  }));

  // ---------- generic record pages (news, bills, funding, grants, papers, jobs, events, care) ----------
  router.get('/news/:id', handle('news', async (req, res, ctx) => {
    const items = await storage.load<NewsItem>('news');
    const item = items.find(n => n.id === req.params.id);
    if (!item) return notFound(res, 'News item', ctx);
    const related = items.filter(n => n.id !== item.id && n.companies.some(c => item.companies.includes(c))).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8);
    const isFiling = item.category === 'SEC Filing';
    const description = (item.summary ?? `${isFiling ? 'SEC filing' : 'News'}: ${item.title}`).slice(0, 300);
    const body = [
      `<div class="kicker">${isFiling ? 'SEC filing' : 'Industry news'} · ${escapeHtml(item.publisher ?? item.source)} · ${escapeHtml(item.publishedAt.slice(0, 10))}</div>`,
      `<h1>${escapeHtml(item.title)}</h1>`,
      `<p>${chips(item.substances)}${item.companies.map(c => `<a class="tag" href="/company-profiles/${slugify(c)}">${escapeHtml(c)}</a>`).join(' ')}</p>`,
      `<div class="summary">${item.summary ? escapeHtml(item.summary) : `${isFiling ? `A ${escapeHtml(item.title.split(':')[0])} filed with the SEC` : `Coverage by ${escapeHtml(item.publisher ?? 'the press')}`}${item.companies.length ? ` concerning ${escapeHtml(item.companies.join(', '))}` : ''}${item.substances.filter(s => s !== 'Other').length ? `, tagged ${escapeHtml(item.substances.filter(s => s !== 'Other').join(', '))}` : ''}. Neuly's crawlers picked this up ${escapeHtml(item.query ? `while tracking "${item.query}"` : 'automatically')}; the full ${isFiling ? 'document' : 'report'} is at the source below.`}</div>`,
      sourceLink(ctx, { url: item.url, label: isFiling ? 'Read the filing on SEC EDGAR' : `Read the full report at ${item.publisher ?? 'the source'}` }),
      related.length ? `<h2>Related coverage</h2>${gatedList(ctx, related.map(n => `<li><a href="/news/${encodeURIComponent(n.id)}">${escapeHtml(n.title)}</a><small>${escapeHtml([n.publisher, n.publishedAt.slice(0, 10)].filter(Boolean).join(' · '))}</small></li>`), related.length, 'related items')}` : ''
    ].join('\n');
    res.send(layout({
      title: `${item.title.slice(0, 100)} — Neuly`, description, path: `/news/${encodeURIComponent(item.id)}`,
      entity: { type: 'news', id: item.id, title: item.title },
      jsonLd: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: item.title, datePublished: item.publishedAt, publisher: item.publisher ? { '@type': 'Organization', name: item.publisher } : undefined, url: `${siteUrl()}/news/${encodeURIComponent(item.id)}` }
    }, body, ctx));
  }));

  router.get('/bills/:id', handle('bill', async (req, res, ctx) => {
    const bills = await storage.load<LegislationBill>('legislation');
    const bill = bills.find(b => b.id === req.params.id);
    if (!bill) return notFound(res, 'Bill', ctx);
    const siblings = bills.filter(b => b.id !== bill.id && b.jurisdiction === bill.jurisdiction).sort((a, b) => (b.lastActionDate ?? '').localeCompare(a.lastActionDate ?? '')).slice(0, 8);
    const label = bill.jurisdiction === 'US-Federal' ? 'Federal' : bill.jurisdiction;
    const description = (bill.description ?? `${bill.billNumber} (${label}): ${bill.title}`).slice(0, 300);
    const body = [
      `<div class="kicker">${escapeHtml(label)} · ${escapeHtml(bill.billNumber)}${bill.status ? ` · ${escapeHtml(bill.status)}` : ''}</div>`,
      `<h1>${escapeHtml(bill.title)}</h1>`,
      `<p>${chips(bill.substances)}</p>`,
      `<ul class="items">${fact('Jurisdiction', label)}${fact('Status', bill.status)}${fact('Session', bill.session)}${fact('Last action', bill.lastAction)}${fact('Last action date', bill.lastActionDate)}${fact('Agencies', bill.agencies?.join(', '))}</ul>`,
      bill.description ? `<div class="summary">${escapeHtml(bill.description)}</div>` : '',
      sourceLink(ctx, { url: bill.url, label: bill.source.includes('Federal') ? 'Read on the Federal Register' : 'Read the bill text' }),
      siblings.length ? `<h2>More from ${escapeHtml(label)}</h2>${gatedList(ctx, siblings.map(b => `<li><a href="/bills/${encodeURIComponent(b.id)}">${escapeHtml(b.billNumber)}: ${escapeHtml(b.title)}</a><small>${escapeHtml([b.status, b.lastActionDate].filter(Boolean).join(' · '))}</small></li>`), siblings.length, 'bills')}<p><a href="/policy/${slugify(bill.jurisdiction)}">Full ${escapeHtml(label)} tracker →</a></p>` : ''
    ].join('\n');
    res.send(layout({ title: `${bill.billNumber}: ${bill.title.slice(0, 80)} — Neuly`, description, path: `/bills/${encodeURIComponent(bill.id)}`, entity: { type: 'legislation', id: bill.id, title: bill.title }, jsonLd: { '@context': 'https://schema.org', '@type': 'Legislation', name: bill.title, legislationIdentifier: bill.billNumber, url: bill.url } }, body, ctx));
  }));

  router.get('/funding/:id', handle('funding', async (req, res, ctx) => {
    const [events, companies] = await Promise.all([storage.load<FundingEvent>('funding_events'), storage.load<Company>('companies')]);
    const event = events.find(f => f.id === req.params.id || f.accessionNumber === req.params.id);
    if (!event) return notFound(res, 'Funding event', ctx);
    const company = companies.find(c => (event.cik && c.cik && c.cik.replace(/^0+/, '') === event.cik.replace(/^0+/, '')) || c.name.toLowerCase() === event.companyName.toLowerCase());
    const money = (n?: number) => (n === undefined ? undefined : `$${n.toLocaleString()}`);
    const description = `${event.companyName} filed SEC Form ${event.formType} on ${event.filedAt}${event.totalAmountSold ? `, reporting $${event.totalAmountSold.toLocaleString()} sold` : ''}${event.totalOfferingAmount ? ` of a $${event.totalOfferingAmount.toLocaleString()} offering` : ''}.`;
    const body = [
      `<div class="kicker">Funding · SEC Form ${escapeHtml(event.formType)} · ${escapeHtml(event.filedAt)}</div>`,
      `<h1>${company ? `<a href="/company-profiles/${slugify(company.name)}">${escapeHtml(event.companyName)}</a>` : escapeHtml(event.companyName)}</h1>`,
      `<p>${chips(event.substances)}</p>`,
      `<div class="summary">${escapeHtml(description)} ${event.formType === 'D/A' ? 'This is an amendment to an earlier notice.' : 'Form D is the notice a company files after selling securities in an exempt (private) offering — it captures rounds that never reach the press.'}</div>`,
      `<ul class="items">${fact('Total offering', money(event.totalOfferingAmount))}${fact('Amount sold', money(event.totalAmountSold))}${fact('Remaining', money(event.totalRemaining))}${fact('Investors so far', event.investorCount)}${fact('Industry group', event.industryGroup)}${fact('Securities', event.securityTypes?.join(', '))}${fact('Issuer location', [event.issuerCity, event.issuerState].filter(Boolean).join(', '))}</ul>`,
      (event.relatedPersons ?? []).length ? `<h2>Officers &amp; directors named</h2>${gatedList(ctx, (event.relatedPersons ?? []).map(p => `<li><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.roles.join(', '))}</small></li>`), event.relatedPersons!.length, 'people')}` : '',
      sourceLink(ctx, { url: event.url, label: 'View the filing on SEC EDGAR' })
    ].join('\n');
    res.send(layout({ title: `${event.companyName} — Form ${event.formType} (${event.filedAt}) — Neuly`, description, path: `/funding/${encodeURIComponent(event.id)}`, entity: { type: 'funding_events', id: event.id, title: event.companyName } }, body, ctx));
  }));

  router.get('/grants/:id', handle('grant', async (req, res, ctx) => {
    const [grants, people] = await Promise.all([storage.load<Grant>('grants'), storage.load<Person>('people')]);
    const grant = grants.find(g => g.id === req.params.id || g.projectNumber === req.params.id);
    if (!grant) return notFound(res, 'Grant', ctx);
    const description = `${grant.title} — ${[grant.agency, grant.organization, grant.fiscalYear ? `FY${grant.fiscalYear}` : undefined, grant.awardAmount ? `$${grant.awardAmount.toLocaleString()}` : undefined].filter(Boolean).join(', ')}.`.slice(0, 300);
    const body = [
      `<div class="kicker">Research grant · ${escapeHtml(grant.agency ?? 'NIH')} · ${escapeHtml(grant.projectNumber)}</div>`,
      `<h1>${escapeHtml(grant.title)}</h1>`,
      `<p>${chips(grant.substances)}</p>`,
      `<ul class="items">${fact('Awardee', grant.organization)}${fact('Fiscal year', grant.fiscalYear)}${fact('Award', grant.awardAmount ? `$${grant.awardAmount.toLocaleString()}` : undefined)}${fact('Period', [grant.startDate, grant.endDate].filter(Boolean).join(' → '))}</ul>`,
      grant.piNames.length ? `<h2>Principal investigators</h2><ul class="items">${grant.piNames.map(n => { const m = people.find(p => p.name.toLowerCase().includes(n.toLowerCase().split(',')[0].trim())); return `<li>${m ? `<a href="/people/${encodeURIComponent(m.id)}">${escapeHtml(n)}</a>` : `<strong>${escapeHtml(n)}</strong>`}</li>`; }).join('')}</ul>` : '',
      grant.abstract ? `<h2>Abstract</h2><div class="summary">${escapeHtml(ctx.signedIn ? grant.abstract : `${grant.abstract.slice(0, 400)}…`)}</div>${ctx.signedIn ? '' : '<p class="gate"><a class="btn" href="/?auth=signup">Create a free account</a> to read the full abstract.</p>'}` : '',
      grant.url ? sourceLink(ctx, { url: grant.url, label: 'View on NIH RePORTER' }) : ''
    ].join('\n');
    res.send(layout({ title: `${grant.title.slice(0, 90)} — NIH grant — Neuly`, description, path: `/grants/${encodeURIComponent(grant.id)}`, entity: { type: 'grants', id: grant.id, title: grant.title } }, body, ctx));
  }));

  router.get('/papers/:id', handle('paper', async (req, res, ctx) => {
    const papers = await storage.load<ResearchPaper>('research_papers');
    const paper = papers.find(p => p.id === req.params.id || p.pmid === req.params.id || p.doi === req.params.id);
    if (!paper) return notFound(res, 'Paper', ctx);
    const isPreprint = paper.publicationType?.includes('Preprint');
    const description = (paper.abstract ?? `${paper.title} — ${[paper.journal, paper.year].filter(Boolean).join(', ')}`).slice(0, 300);
    const url = paper.url ?? (paper.doi ? `https://doi.org/${paper.doi}` : paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : undefined);
    const body = [
      `<div class="kicker">${isPreprint ? 'Preprint' : 'Research paper'} · ${escapeHtml([paper.journal, paper.year?.toString()].filter(Boolean).join(' · '))}</div>`,
      `<h1>${escapeHtml(paper.title)}</h1>`,
      `<p class="lede">${escapeHtml(paper.authors.slice(0, 12).map(a => a.name).join(', '))}${paper.authors.length > 12 ? ` and ${paper.authors.length - 12} more` : ''}</p>`,
      `<p>${chips(paper.substances)}${(paper.publicationType ?? []).filter(t => t !== 'Journal Article').map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</p>`,
      `<ul class="items">${fact('Journal', paper.journal)}${fact('Published', paper.publicationDate ?? paper.year)}${fact('DOI', paper.doi)}${fact('PMID', paper.pmid)}${fact('Citations', paper.citationCount)}${fact('Open access', paper.isOpenAccess === undefined ? undefined : paper.isOpenAccess ? 'Yes' : 'No')}</ul>`,
      paper.abstract ? `<h2>Abstract</h2><div class="summary">${escapeHtml(ctx.signedIn ? paper.abstract : `${paper.abstract.slice(0, 400)}…`)}</div>${ctx.signedIn ? '' : '<p class="gate"><a class="btn" href="/?auth=signup">Create a free account</a> to read the full abstract and related work.</p>'}` : '',
      (paper.keywords ?? []).length && ctx.signedIn ? `<p>${(paper.keywords ?? []).slice(0, 12).map(k => `<span class="tag">${escapeHtml(k)}</span>`).join(' ')}</p>` : '',
      url ? sourceLink(ctx, { url, label: isPreprint ? 'Read the preprint' : paper.pmid ? 'Read on PubMed' : 'Read the paper' }) : ''
    ].join('\n');
    res.send(layout({ title: `${paper.title.slice(0, 100)} — Neuly`, description, path: `/papers/${encodeURIComponent(paper.id)}`, entity: { type: 'research_papers', id: paper.id, title: paper.title }, jsonLd: { '@context': 'https://schema.org', '@type': 'ScholarlyArticle', headline: paper.title, author: paper.authors.slice(0, 12).map(a => ({ '@type': 'Person', name: a.name })), datePublished: paper.publicationDate, url } }, body, ctx));
  }));

  router.get('/jobs/:id', handle('job', async (req, res, ctx) => {
    const [jobs, companies] = await Promise.all([storage.load<JobPosting>('jobs'), storage.load<Company>('companies')]);
    const job = jobs.find(j => j.id === req.params.id);
    if (!job) return notFound(res, 'Job', ctx);
    const company = companies.find(c => c.id === job.companyId || c.name.toLowerCase() === job.company.toLowerCase());
    const description = `${job.title} at ${job.company}${job.location ? ` (${[job.location.city, job.location.state, job.location.country, job.location.remote ? 'Remote' : undefined].filter(Boolean).join(', ')})` : ''}. ${(job.description ?? '').slice(0, 200)}`.slice(0, 300);
    const body = [
      `<div class="kicker">Job · ${escapeHtml(job.type)}${job.employmentType ? ` · ${escapeHtml(job.employmentType)}` : ''}</div>`,
      `<h1>${escapeHtml(job.title)}</h1>`,
      `<p class="lede">${company ? `<a href="/company-profiles/${slugify(company.name)}">${escapeHtml(job.company)}</a>` : escapeHtml(job.company)}${job.location ? ` · ${escapeHtml([job.location.city, job.location.state, job.location.country, job.location.remote ? 'Remote' : undefined].filter(Boolean).join(', '))}` : ''}</p>`,
      `<ul class="items">${fact('Posted', job.postedDate)}${fact('Source', job.source)}${fact('Salary', job.salaryRange && (job.salaryRange.min || job.salaryRange.max) ? `${job.salaryRange.currency ?? 'USD'} ${[job.salaryRange.min, job.salaryRange.max].filter(Boolean).map(n => n!.toLocaleString()).join(' – ')}` : undefined)}</ul>`,
      job.description ? `<h2>About the role</h2><div class="summary">${escapeHtml(ctx.signedIn ? job.description.slice(0, 4000) : `${job.description.slice(0, 400)}…`)}</div>${ctx.signedIn ? '' : '<p class="gate"><a class="btn" href="/?auth=signup">Create a free account</a> to read the full posting and apply.</p>'}` : '',
      sourceLink(ctx, { url: job.applicationUrl ?? job.sourceUrl, label: `Apply at ${job.company}` })
    ].join('\n');
    res.send(layout({ title: `${job.title} at ${job.company} — Neuly Jobs`, description, path: `/jobs/${encodeURIComponent(job.id)}`, entity: { type: 'jobs', id: job.id, title: job.title }, jsonLd: { '@context': 'https://schema.org', '@type': 'JobPosting', title: job.title, hiringOrganization: { '@type': 'Organization', name: job.company }, datePosted: job.postedDate, description: (job.description ?? '').slice(0, 500), url: job.sourceUrl } }, body, ctx));
  }));

  router.get('/events/:id', handle('event', async (req, res, ctx) => {
    const events = await storage.load<Event>('events');
    const event = events.find(e => e.id === req.params.id);
    if (!event) return notFound(res, 'Event', ctx);
    const where = event.format === 'Virtual' ? 'Online' : [event.location?.venue, event.location?.city, event.location?.country].filter(Boolean).join(', ');
    const description = `${event.title} — ${[event.type, event.startDate, where].filter(Boolean).join(' · ')}. ${(event.description ?? '').slice(0, 200)}`.slice(0, 300);
    const body = [
      `<div class="kicker">${escapeHtml(event.type)} · ${escapeHtml(event.format)}</div>`,
      `<h1>${escapeHtml(event.title)}</h1>`,
      `<p class="lede">${escapeHtml([event.startDate, event.endDate && event.endDate !== event.startDate ? `to ${event.endDate}` : undefined, where, event.organizer].filter(Boolean).join(' · '))}</p>`,
      event.description ? `<div class="summary">${escapeHtml(event.description)}</div>` : '',
      (event.topics ?? []).length ? `<p>${(event.topics ?? []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</p>` : '',
      (event.speakers ?? []).length ? `<h2>Speakers</h2>${gatedList(ctx, (event.speakers ?? []).map(s => `<li><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml([s.title, s.organization].filter(Boolean).join(' · '))}</small></li>`), event.speakers!.length, 'speakers')}` : '',
      (event.registrationUrl || event.website) ? sourceLink(ctx, { url: (event.registrationUrl ?? event.website)!, label: 'Register / event website' }) : ''
    ].join('\n');
    res.send(layout({ title: `${event.title} — ${event.startDate} — Neuly Events`, description, path: `/events/${encodeURIComponent(event.id)}`, entity: { type: 'events', id: event.id, title: event.title }, jsonLd: { '@context': 'https://schema.org', '@type': 'Event', name: event.title, startDate: event.startDate, endDate: event.endDate, eventAttendanceMode: event.format === 'Virtual' ? 'https://schema.org/OnlineEventAttendanceMode' : 'https://schema.org/OfflineEventAttendanceMode', organizer: event.organizer ? { '@type': 'Organization', name: event.organizer } : undefined, url: event.website } }, body, ctx));
  }));

  router.get('/care/:id', handle('care provider', async (req, res, ctx) => {
    const providers = await storage.load<CareProvider>('care_providers');
    const provider = providers.find(p => p.id === req.params.id);
    if (!provider) return notFound(res, 'Care provider', ctx);
    const where = [provider.location?.city, provider.location?.state, provider.location?.country].filter(Boolean).join(', ');
    const nearby = providers.filter(p => p.id !== provider.id && p.location?.state && p.location.state === provider.location?.state).slice(0, 6);
    const description = `${provider.name} — ${[provider.type, where, provider.verified ? 'licence verified' : undefined].filter(Boolean).join(' · ')}. ${(provider.description ?? '').slice(0, 200)}`.slice(0, 300);
    const body = [
      `<div class="kicker">Care · ${escapeHtml(provider.type)}${provider.verified ? ' · Verified' : ''}</div>`,
      `<h1>${escapeHtml(provider.name)}</h1>`,
      `<p class="lede">${escapeHtml(where)}</p>`,
      provider.description ? `<div class="summary">${escapeHtml(provider.description)}</div>` : '',
      `<p>${chips(provider.substances)}${(provider.services ?? []).map(s => `<span class="tag">${escapeHtml(s)}</span>`).join(' ')}</p>`,
      `<ul class="items">${fact('Licence', [provider.licenseType, provider.licenseNumber, provider.licenseStatus].filter(Boolean).join(' · '))}${fact('Accepts insurance', provider.acceptsInsurance === undefined ? undefined : provider.acceptsInsurance ? 'Yes' : 'No')}${fact('Source', provider.source)}</ul>`,
      ctx.signedIn
        ? `<p class="gate">Want to be connected with ${escapeHtml(provider.name)}? <a class="btn" href="/care?inquire=${encodeURIComponent(provider.id)}">Request information</a></p>`
        : `<p class="gate"><a class="btn" href="/?auth=signup&next=${encodeURIComponent(`/care?inquire=${provider.id}`)}">Create a free account</a> to request information, see contact details and compare providers.</p>`,
      ctx.signedIn && (provider.phone || provider.email) ? `<ul class="items">${fact('Phone', provider.phone)}${fact('Email', provider.email)}</ul>` : '',
      provider.website ? sourceLink(ctx, { url: provider.website, label: `Visit ${provider.name}` }) : '',
      nearby.length ? `<h2>Nearby providers</h2>${gatedList(ctx, nearby.map(p => `<li><a href="/care/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a><small>${escapeHtml([p.type, p.location?.city].filter(Boolean).join(' · '))}</small></li>`), nearby.length, 'providers')}` : ''
    ].join('\n');
    res.send(layout({ title: `${provider.name} — ${provider.type} in ${where || 'psychedelic care'} — Neuly Care`, description, path: `/care/${encodeURIComponent(provider.id)}`, entity: { type: 'care_providers', id: provider.id, title: provider.name }, jsonLd: { '@context': 'https://schema.org', '@type': 'MedicalClinic', name: provider.name, address: where, url: provider.website } }, body, ctx));
  }));

  // ---------- policy pages ----------
  router.get('/policy/:jurisdiction', handle('policy', async (req, res, ctx) => {
    const bills = await storage.load<LegislationBill>('legislation');
    const slug = req.params.jurisdiction.toLowerCase();
    const jurisdictionBills = bills.filter(b => b.jurisdiction.toLowerCase() === slug);
    if (jurisdictionBills.length === 0) return notFound(res, 'Jurisdiction', ctx);

    const label = slug === 'us-federal' ? 'Federal (US)' : slug.toUpperCase();
    const description = `Psychedelic policy tracker for ${label}: ${jurisdictionBills.length} bills and regulatory actions tracked, updated hourly from LegiScan and the Federal Register.`;
    const sorted = [...jurisdictionBills].sort((a, b) => (b.lastActionDate ?? '').localeCompare(a.lastActionDate ?? ''));
    const jurisdictions = Array.from(new Set(bills.map(b => b.jurisdiction))).sort();

    const body = [
      `<h1>Psychedelic Policy — ${escapeHtml(label)}</h1>`,
      `<p class="lede">${escapeHtml(description)}</p>`,
      gatedList(ctx, sorted.slice(0, 50).map(b =>
        `<li><a href="/bills/${encodeURIComponent(b.id)}">${escapeHtml(b.billNumber)}: ${escapeHtml(b.title)}</a><small>${escapeHtml([b.status, b.lastAction, b.lastActionDate].filter(Boolean).join(' · '))}</small></li>`
      ), sorted.length, 'bills and rules'),
      `<h2>Other Jurisdictions</h2><p>${jurisdictions.map(j => `<a class="tag" href="/policy/${slugify(j)}">${escapeHtml(j)}</a>`).join(' ')}</p>`
    ].join('\n');

    res.send(layout({ title: `Psychedelic Policy Tracker: ${label} — Neuly`, description, path: `/policy/${slug}` }, body, ctx));
  }));

  // ---------- readout calendar ----------
  router.get('/readouts-calendar', handle('readout calendar', async (_req, res, ctx) => {
    const trials = await storage.load<ClinicalTrial>('clinical_trials');
    const readouts = deriveReadoutCalendar(trials);
    const description = `Upcoming psychedelic clinical trial readouts: ${readouts.length} expected results windows derived from trial completion dates. The sector's earnings calendar.`;

    const body = [
      `<h1>Psychedelic Trial Readout Calendar</h1>`,
      `<p class="lede">${escapeHtml(description)}</p>`,
      gatedList(ctx, readouts.slice(0, 50).map(r =>
        `<li><a href="/trials/${escapeHtml(r.nctId)}">${escapeHtml(r.title)}</a><small>expected ${r.expectedReadoutStart} – ${r.expectedReadoutEnd} · ${escapeHtml([r.phase, r.sponsor].filter(Boolean).join(' · '))} · ${r.substances.map(escapeHtml).join(', ')}</small></li>`
      ), readouts.length, 'readouts')
    ].join('\n');

    res.send(layout({ title: 'Psychedelic Clinical Trial Readout Calendar — Neuly', description, path: '/readouts-calendar' }, body, ctx));
  }));

  // ---------- robots + sitemap ----------
  router.get('/robots.txt', (_req: Request, res: Response) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /account\nDisallow: /admin\nDisallow: /partners\nSitemap: ${siteUrl()}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', async (_req: Request, res: Response) => {
    try {
      const [trials, companies, bills, people, papers, news, care, jobs, events, grants, funding] = await Promise.all([
        storage.load<ClinicalTrial>('clinical_trials'),
        storage.load<Company>('companies'),
        storage.load<LegislationBill>('legislation'),
        storage.load<Person>('people'),
        storage.load<ResearchPaper>('research_papers'),
        storage.load<NewsItem>('news'),
        storage.load<CareProvider>('care_providers'),
        storage.load<JobPosting>('jobs'),
        storage.load<Event>('events'),
        storage.load<Grant>('grants'),
        storage.load<FundingEvent>('funding_events')
      ]);

      const urls = new Set<string>(['/', '/pricing', '/readouts-calendar', '/docs']);
      for (const s of SUBSTANCES) if (s !== 'Other') urls.add(`/substances/${slugify(s)}`);
      for (const t of trials) urls.add(`/trials/${t.nctId}`);
      for (const c of companies) urls.add(`/company-profiles/${slugify(c.name)}`);
      for (const j of new Set(bills.map(b => b.jurisdiction))) urls.add(`/policy/${slugify(j)}`);
      for (const b of bills) urls.add(`/bills/${encodeURIComponent(b.id)}`);
      for (const p of people) urls.add(`/people/${encodeURIComponent(p.id)}`);
      for (const p of [...papers].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, 5000)) urls.add(`/papers/${encodeURIComponent(p.id)}`);
      for (const n of [...news].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 3000)) urls.add(`/news/${encodeURIComponent(n.id)}`);
      for (const c of care) urls.add(`/care/${encodeURIComponent(c.id)}`);
      for (const j of jobs) urls.add(`/jobs/${encodeURIComponent(j.id)}`);
      for (const e of events) urls.add(`/events/${encodeURIComponent(e.id)}`);
      for (const g of grants) urls.add(`/grants/${encodeURIComponent(g.id)}`);
      for (const f of funding) urls.add(`/funding/${encodeURIComponent(f.id)}`);

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

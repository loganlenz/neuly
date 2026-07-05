import { randomUUID } from 'crypto';
import { StorageBackend } from '../utils/storageBackend.js';
import { ChangeEvent, ClinicalTrial } from '../models/types.js';
import { deriveReadoutCalendar, ReadoutEntry } from '../core/readouts.js';
import { getAppDb, appDbAvailable } from '../db/appDb.js';
import { Mailer } from '../notify/mailer.js';
import { logger } from '../utils/logger.js';

export interface DigestContent {
  subject: string;
  markdown: string;
  html: string;
  eventCount: number;
}

const SECTION_ORDER: Array<{ type: string; heading: string }> = [
  { type: 'legislation', heading: 'Policy & Regulation' },
  { type: 'clinical_trials', heading: 'Clinical Trials' },
  { type: 'funding_events', heading: 'Funding' },
  { type: 'companies', heading: 'Companies' },
  { type: 'grants', heading: 'Research Grants' },
  { type: 'research_papers', heading: 'New Research' },
  { type: 'jobs', heading: 'Jobs' },
  { type: 'events', heading: 'Events' },
  { type: 'people', heading: 'People' }
];

/**
 * Build the weekly digest from the change log and the readout calendar.
 * Pure over its inputs — exported for tests; the auto-generated draft
 * that makes the newsletter nearly free to produce.
 */
export function buildDigest(
  events: ChangeEvent[],
  readouts: ReadoutEntry[],
  now = new Date()
): DigestContent {
  const week = now.toISOString().slice(0, 10);
  const subject = `Neuly Weekly — ${events.length} changes in psychedelic medicine (${week})`;

  const md: string[] = [
    `# Neuly Weekly — ${week}`,
    '',
    `${events.length} tracked changes this week across trials, policy, funding, research, and jobs.`,
    ''
  ];

  for (const section of SECTION_ORDER) {
    const sectionEvents = events.filter(e => e.entityType === section.type);
    if (sectionEvents.length === 0) continue;

    md.push(`## ${section.heading} (${sectionEvents.length})`, '');
    for (const event of sectionEvents.slice(0, 15)) {
      md.push(`- ${event.summary}`);
    }
    if (sectionEvents.length > 15) {
      md.push(`- …and ${sectionEvents.length - 15} more`);
    }
    md.push('');
  }

  const upcoming = readouts.slice(0, 8);
  if (upcoming.length > 0) {
    md.push('## Upcoming Readouts', '');
    for (const readout of upcoming) {
      const phase = readout.phase ? ` (${readout.phase})` : '';
      md.push(`- **${readout.expectedReadoutStart} – ${readout.expectedReadoutEnd}**: ${readout.title}${phase} — ${readout.sponsor ?? 'sponsor n/a'}`);
    }
    md.push('');
  }

  md.push('---', '', '_Generated automatically from the Neuly data platform._');

  const markdown = md.join('\n');
  return { subject, markdown, html: markdownToHtml(markdown), eventCount: events.length };
}

/** Minimal markdown -> HTML for the digest's own constructs */
function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const html: string[] = [];
  let inList = false;

  const inline = (text: string) => escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');

  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) { html.push('</ul>'); inList = false; }

    if (line.startsWith('# ')) html.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith('## ')) html.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line === '---') html.push('<hr>');
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (inList) html.push('</ul>');

  return `<div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">${html.join('\n')}</div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Weekly newsletter job: build the digest from the last 7 days, store
 * the issue, send to opted-in users.
 */
export async function runNewsletter(storage: StorageBackend, mailer = new Mailer()): Promise<{ recipients: number; eventCount: number }> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const events = await storage.loadChangeEvents({ since, limit: 1000 });
  const trials = await storage.load<ClinicalTrial>('clinical_trials');
  const readouts = deriveReadoutCalendar(trials, { horizonDays: 90 });

  const digest = buildDigest(events, readouts);

  if (events.length === 0) {
    logger.info('[newsletter] No changes this week — skipping issue');
    return { recipients: 0, eventCount: 0 };
  }

  let recipients = 0;
  if (appDbAvailable()) {
    const db = getAppDb();
    const users = await db.query('SELECT email FROM users WHERE newsletter_opt_in = true');

    for (const row of users.rows) {
      try {
        await mailer.send({ to: row.email, subject: digest.subject, html: digest.html, text: digest.markdown });
        recipients++;
      } catch (error) {
        logger.error(`[newsletter] Failed to send to ${row.email}: ${error instanceof Error ? error.message : error}`);
      }
    }

    await db.query(
      'INSERT INTO newsletter_issues (id, subject, html, markdown, event_count, recipients) VALUES ($1, $2, $3, $4, $5, $6)',
      [`nl_${randomUUID()}`, digest.subject, digest.html, digest.markdown, digest.eventCount, recipients]
    );
  } else {
    // Still produce the draft so the pipeline works on the JSON backend
    await mailer.send({ to: 'draft@localhost', subject: digest.subject, html: digest.html, text: digest.markdown });
    logger.warn('[newsletter] No Postgres backend — wrote draft only');
  }

  logger.info(`[newsletter] Issue generated: ${digest.eventCount} events, ${recipients} recipients`);
  return { recipients, eventCount: digest.eventCount };
}

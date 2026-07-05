import { ClinicalTrial } from '../models/types.js';

export interface ReadoutEntry {
  trialId: string;
  nctId: string;
  title: string;
  sponsor?: string;
  phase?: string;
  status: string;
  substances: string[];
  conditions: string[];
  enrollment?: number;
  /** The completion date the estimate is anchored on */
  anchorDate: string;
  anchorField: 'primaryCompletionDate' | 'completionDate';
  /** Estimated window in which results typically read out */
  expectedReadoutStart: string;
  expectedReadoutEnd: string;
  url: string;
}

export interface ReadoutOptions {
  /** Include readout windows up to this many days ahead (default 540) */
  horizonDays?: number;
  /** Include windows that started up to this many days ago (default 90) */
  lookbackDays?: number;
  /** Reference "now" — injectable for tests */
  now?: Date;
}

/** Statuses that mean the trial can still produce a readout */
const ACTIVE_STATUSES = new Set([
  'Recruiting',
  'Enrolling by Invitation',
  'Active, Not Recruiting',
  'Not Yet Recruiting',
  'Completed'
]);

/** Results typically publish 3-9 months after primary completion */
const READOUT_LAG_MIN_DAYS = 90;
const READOUT_LAG_MAX_DAYS = 270;

/**
 * Derive the trial readout calendar — the sector's "earnings calendar" —
 * from stored clinical trials. Pure function over already-crawled data:
 * expected readout window = completion date + typical publication lag.
 * Phase 2/3 trials are what move companies, but all phases are included
 * and callers can filter.
 */
export function deriveReadoutCalendar(
  trials: ClinicalTrial[],
  options: ReadoutOptions = {}
): ReadoutEntry[] {
  const now = options.now ?? new Date();
  const horizonMs = (options.horizonDays ?? 540) * 24 * 60 * 60 * 1000;
  const lookbackMs = (options.lookbackDays ?? 90) * 24 * 60 * 60 * 1000;

  const entries: ReadoutEntry[] = [];

  for (const trial of trials) {
    if (!ACTIVE_STATUSES.has(trial.status)) continue;

    const anchorField = trial.primaryCompletionDate ? 'primaryCompletionDate' as const
      : trial.completionDate ? 'completionDate' as const
      : undefined;
    if (!anchorField) continue;

    const anchorDate = new Date(trial[anchorField]!);
    if (isNaN(anchorDate.getTime())) continue;

    const windowStart = new Date(anchorDate.getTime() + READOUT_LAG_MIN_DAYS * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(anchorDate.getTime() + READOUT_LAG_MAX_DAYS * 24 * 60 * 60 * 1000);

    // Skip stale (window long past) and far-future readouts
    if (windowEnd.getTime() < now.getTime() - lookbackMs) continue;
    if (windowStart.getTime() > now.getTime() + horizonMs) continue;

    entries.push({
      trialId: trial.id,
      nctId: trial.nctId,
      title: trial.title,
      sponsor: trial.sponsor,
      phase: trial.phase,
      status: trial.status,
      substances: trial.substances,
      conditions: trial.conditions,
      enrollment: trial.enrollment,
      anchorDate: isoDay(anchorDate),
      anchorField,
      expectedReadoutStart: isoDay(windowStart),
      expectedReadoutEnd: isoDay(windowEnd),
      url: trial.url
    });
  }

  // Soonest expected readout first
  entries.sort((a, b) => a.expectedReadoutStart.localeCompare(b.expectedReadoutStart));
  return entries;
}

function isoDay(date: Date): string {
  return date.toISOString().split('T')[0];
}

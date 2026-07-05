import { describe, it, expect } from 'vitest';
import { DiffEngine } from './DiffEngine.js';
import { ClinicalTrial, JobPosting } from '../models/types.js';

const engine = new DiffEngine();

function trial(overrides: Partial<ClinicalTrial> = {}): ClinicalTrial {
  return {
    id: 'ct_nct01234567',
    nctId: 'NCT01234567',
    title: 'Psilocybin for Treatment-Resistant Depression',
    status: 'Recruiting',
    phase: 'Phase 2',
    conditions: ['Treatment-Resistant Depression'],
    interventions: [{ type: 'Drug', name: 'Psilocybin' }],
    substances: ['Psilocybin'],
    url: 'https://clinicaltrials.gov/study/NCT01234567',
    lastUpdated: '2026-07-01',
    crawledAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  } as ClinicalTrial;
}

function job(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: 'job_gh-100',
    title: 'Clinical Research Associate',
    company: 'COMPASS Pathways',
    type: 'Research',
    location: { remote: false },
    source: 'Greenhouse - COMPASS Pathways',
    crawledAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  } as JobPosting;
}

describe('DiffEngine', () => {
  it('emits an added event for new entities', () => {
    const events = engine.diff('clinical_trials', [], [trial()]);

    expect(events).toHaveLength(1);
    expect(events[0].changeType).toBe('added');
    expect(events[0].entityId).toBe('ct_nct01234567');
    expect(events[0].summary).toContain('New clinical trial');
  });

  it('emits an updated event when a significant field changes', () => {
    const before = trial();
    const after = trial({ status: 'Completed', phase: 'Phase 3', crawledAt: '2026-07-05T00:00:00.000Z' });

    const events = engine.diff('clinical_trials', [before], [after]);

    expect(events).toHaveLength(1);
    expect(events[0].changeType).toBe('updated');
    expect(events[0].fields).toEqual([
      { field: 'status', from: 'Recruiting', to: 'Completed' },
      { field: 'phase', from: 'Phase 2', to: 'Phase 3' }
    ]);
    expect(events[0].summary).toContain('Recruiting → Completed');
  });

  it('stays silent when only insignificant fields change', () => {
    const before = trial();
    const after = trial({ crawledAt: '2026-07-05T00:00:00.000Z', briefSummary: 'Updated summary text' });

    expect(engine.diff('clinical_trials', [before], [after])).toHaveLength(0);
  });

  it('only detects removals when enabled', () => {
    const previous = [job(), job({ id: 'job_gh-200', title: 'Data Engineer' })];
    const current = [job()];

    expect(engine.diff('jobs', previous, current)).toHaveLength(0);

    const events = engine.diff('jobs', previous, current, { detectRemovals: true });
    expect(events).toHaveLength(1);
    expect(events[0].changeType).toBe('removed');
    expect(events[0].entityId).toBe('job_gh-200');
  });

  it('does not treat a partial crawl as removals by default', () => {
    // Query-based crawls return subsets; absence must not produce events
    const previous = [trial(), trial({ id: 'ct_nct09999999', nctId: 'NCT09999999' })];
    const current = [trial()];

    const events = engine.diff('clinical_trials', previous, current);
    expect(events).toHaveLength(0);
  });

  it('produces unique, stable event ids per entity and change type', () => {
    const events = engine.diff('jobs', [], [job(), job({ id: 'job_gh-200' })]);
    const ids = events.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

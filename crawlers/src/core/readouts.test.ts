import { describe, it, expect } from 'vitest';
import { deriveReadoutCalendar } from './readouts.js';
import { ClinicalTrial } from '../models/types.js';

const NOW = new Date('2026-07-05T00:00:00Z');

function trial(overrides: Partial<ClinicalTrial>): ClinicalTrial {
  return {
    id: 'ct_test',
    nctId: 'NCT00000000',
    title: 'Test Trial',
    status: 'Active, Not Recruiting',
    phase: 'Phase 2',
    conditions: ['Depression'],
    interventions: [],
    substances: ['Psilocybin'],
    url: 'https://clinicaltrials.gov/study/NCT00000000',
    lastUpdated: '2026-06-01',
    crawledAt: '2026-06-01T00:00:00.000Z',
    ...overrides
  } as ClinicalTrial;
}

describe('deriveReadoutCalendar', () => {
  it('derives a readout window 3-9 months after primary completion', () => {
    const entries = deriveReadoutCalendar(
      [trial({ primaryCompletionDate: '2026-08-01' })],
      { now: NOW }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].anchorField).toBe('primaryCompletionDate');
    expect(entries[0].expectedReadoutStart).toBe('2026-10-30'); // +90 days
    expect(entries[0].expectedReadoutEnd).toBe('2027-04-28');   // +270 days
  });

  it('falls back to completionDate when primary is missing', () => {
    const entries = deriveReadoutCalendar(
      [trial({ completionDate: '2026-09-01' })],
      { now: NOW }
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].anchorField).toBe('completionDate');
  });

  it('excludes terminated and withdrawn trials', () => {
    const entries = deriveReadoutCalendar(
      [
        trial({ status: 'Terminated', primaryCompletionDate: '2026-08-01' }),
        trial({ id: 'ct_2', status: 'Withdrawn', primaryCompletionDate: '2026-08-01' })
      ],
      { now: NOW }
    );
    expect(entries).toHaveLength(0);
  });

  it('excludes long-past readout windows and far-future ones', () => {
    const entries = deriveReadoutCalendar(
      [
        trial({ id: 'ct_old', primaryCompletionDate: '2020-01-01' }),
        trial({ id: 'ct_far', primaryCompletionDate: '2030-01-01' })
      ],
      { now: NOW }
    );
    expect(entries).toHaveLength(0);
  });

  it('excludes trials with no completion dates', () => {
    expect(deriveReadoutCalendar([trial({})], { now: NOW })).toHaveLength(0);
  });

  it('sorts soonest readout first', () => {
    const entries = deriveReadoutCalendar(
      [
        trial({ id: 'ct_later', primaryCompletionDate: '2026-12-01' }),
        trial({ id: 'ct_sooner', primaryCompletionDate: '2026-07-15' })
      ],
      { now: NOW }
    );
    expect(entries.map(e => e.trialId)).toEqual(['ct_sooner', 'ct_later']);
  });
});

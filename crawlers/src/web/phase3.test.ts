import { describe, it, expect } from 'vitest';
import { signSession, verifySession } from '../auth/tokens.js';
import { hashPassword, verifyPassword, hashApiKey } from '../auth/auth.js';
import { clampChangesSince, clampReadoutHorizon, toCsv, FREE_CHANGES_WINDOW_DAYS } from './gating.js';
import { matchEvents, renderAlertEmail } from '../alerts/alerts.js';
import { buildDigest } from '../newsletter/digest.js';
import { verifyStripeSignature } from '../billing/stripe.js';
import { slugify } from './seoPages.js';
import { ChangeEvent, JobPosting } from '../models/types.js';
import { createHmac } from 'crypto';

const NOW = new Date('2026-07-05T00:00:00Z');

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    id: `chg_${Math.random()}`,
    entityType: 'legislation',
    entityId: 'leg_x',
    entityTitle: 'Psilocybin services bill',
    changeType: 'updated',
    summary: 'Bill updated: Psilocybin services bill (lastAction Introduced → Governor Signed)',
    detectedAt: '2026-07-04T12:00:00.000Z',
    ...overrides
  };
}

describe('session tokens', () => {
  it('round-trips a valid session', () => {
    const token = signSession({ userId: 'usr_1', email: 'a@b.co', plan: 'pro' });
    const payload = verifySession(token);
    expect(payload?.userId).toBe('usr_1');
    expect(payload?.plan).toBe('pro');
  });

  it('rejects tampered tokens', () => {
    const token = signSession({ userId: 'usr_1', email: 'a@b.co', plan: 'free' });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(body, 'base64url').toString()),
      plan: 'enterprise'
    })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`)).toBeNull();
    expect(verifySession('garbage')).toBeNull();
    expect(verifySession(undefined)).toBeNull();
  });

  it('rejects expired tokens', () => {
    const token = signSession({ userId: 'usr_1', email: 'a@b.co', plan: 'free' }, -10);
    expect(verifySession(token)).toBeNull();
  });
});

describe('passwords and api keys', () => {
  it('verifies correct passwords and rejects wrong ones', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'malformed')).toBe(false);
  });

  it('hashes api keys deterministically', () => {
    expect(hashApiKey('nk_abc')).toBe(hashApiKey('nk_abc'));
    expect(hashApiKey('nk_abc')).not.toBe(hashApiKey('nk_abd'));
  });
});

describe('plan gating', () => {
  it('clamps the change window for free users', () => {
    const floor = clampChangesSince('free', undefined, NOW)!;
    const expected = new Date(NOW.getTime() - FREE_CHANGES_WINDOW_DAYS * 86400000).toISOString();
    expect(floor).toBe(expected);
    // requesting older history than allowed clamps to the floor
    expect(clampChangesSince(undefined, '2020-01-01T00:00:00Z', NOW)).toBe(expected);
    // requesting inside the window is honored
    expect(clampChangesSince('free', '2026-07-03T00:00:00.000Z', NOW)).toBe('2026-07-03T00:00:00.000Z');
  });

  it('does not clamp paid plans', () => {
    expect(clampChangesSince('pro', '2020-01-01T00:00:00Z', NOW)).toBe('2020-01-01T00:00:00Z');
    expect(clampChangesSince('enterprise', undefined, NOW)).toBeUndefined();
    expect(clampReadoutHorizon('pro', 540)).toBe(540);
  });

  it('clamps the readout horizon for free users', () => {
    expect(clampReadoutHorizon('free', 540)).toBe(90);
    expect(clampReadoutHorizon(undefined, undefined)).toBe(90);
    expect(clampReadoutHorizon('free', 30)).toBe(30);
  });
});

describe('toCsv', () => {
  it('renders scalar, array, and object fields with escaping', () => {
    const rows = [
      { id: 'job_1', title: 'CRA, Senior "Lead"', company: 'X', substances: ['Psilocybin', 'MDMA'], location: { city: 'NY' }, crawledAt: 'now', source: 's', type: 'Research' }
    ] as unknown as JobPosting[];

    const csv = toCsv(rows);
    const [header, line] = csv.split('\n');
    expect(header).toContain('id,title,company');
    expect(line).toContain('"CRA, Senior ""Lead"""');
    expect(line).toContain('Psilocybin; MDMA');
    expect(line).toContain('"{""city"":""NY""}"');
  });

  it('returns empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});

describe('alert matching', () => {
  const events = [
    event(),
    event({ entityType: 'clinical_trials', entityTitle: 'MDMA PTSD trial', summary: 'New clinical trial: MDMA PTSD trial' }),
    event({ entityType: 'funding_events', entityTitle: 'Psilera Inc.', summary: 'New funding event: Psilera Inc.' })
  ];

  it('filters by entity type', () => {
    expect(matchEvents({ entityType: 'clinical_trials', keyword: null }, events)).toHaveLength(1);
    expect(matchEvents({ entityType: null, keyword: null }, events)).toHaveLength(3);
  });

  it('filters by keyword across title and summary, case-insensitive', () => {
    expect(matchEvents({ entityType: null, keyword: 'psilera' }, events)).toHaveLength(1);
    expect(matchEvents({ entityType: null, keyword: 'psilocybin' }, events)).toHaveLength(1);
    expect(matchEvents({ entityType: null, keyword: 'nothing' }, events)).toHaveLength(0);
  });

  it('renders an email with all matches and escaped HTML', () => {
    const email = renderAlertEmail(
      [event({ summary: 'Status <script> → Completed' })],
      { entityType: 'clinical_trials', keyword: 'x' }
    );
    expect(email.subject).toContain('1 update');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('<script>');
  });
});

describe('newsletter digest', () => {
  it('groups events by section and includes readouts', () => {
    const digest = buildDigest(
      [
        event(),
        event({ entityType: 'clinical_trials', summary: 'New clinical trial: Trial A' }),
        event({ entityType: 'clinical_trials', summary: 'New clinical trial: Trial B' })
      ],
      [{
        trialId: 'ct_1', nctId: 'NCT1', title: 'Psilocybin Phase 3', sponsor: 'COMPASS',
        phase: 'Phase 3', status: 'Completed', substances: ['Psilocybin'], conditions: [],
        anchorDate: '2026-08-01', anchorField: 'primaryCompletionDate',
        expectedReadoutStart: '2026-10-30', expectedReadoutEnd: '2027-04-28',
        url: 'https://example.com'
      }],
      NOW
    );

    expect(digest.subject).toContain('3 changes');
    expect(digest.markdown).toContain('## Policy & Regulation (1)');
    expect(digest.markdown).toContain('## Clinical Trials (2)');
    expect(digest.markdown).toContain('## Upcoming Readouts');
    expect(digest.markdown).toContain('Psilocybin Phase 3');
    expect(digest.html).toContain('<h2>Clinical Trials (2)</h2>');
    expect(digest.eventCount).toBe(3);
  });

  it('caps sections at 15 items with an overflow note', () => {
    const many = Array.from({ length: 20 }, (_, i) => event({ id: `e${i}`, summary: `Bill ${i} updated` }));
    const digest = buildDigest(many, [], NOW);
    expect(digest.markdown).toContain('…and 5 more');
  });
});

describe('stripe webhook signature', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{"type":"checkout.session.completed"}');

  function sign(ts: number): string {
    const sig = createHmac('sha256', secret).update(`${ts}.${body.toString()}`).digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  it('accepts a valid signature', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, sign(ts), secret)).toBe(true);
  });

  it('rejects bad signatures, missing headers, and stale timestamps', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, `t=${ts},v1=deadbeef`, secret)).toBe(false);
    expect(verifyStripeSignature(body, undefined, secret)).toBe(false);
    expect(verifyStripeSignature(body, sign(ts - 3600), secret)).toBe(false);
  });
});

describe('slugify', () => {
  it('produces stable url slugs', () => {
    expect(slugify('COMPASS Pathways')).toBe('compass-pathways');
    expect(slugify('5-MeO-DMT')).toBe('5-meo-dmt');
    expect(slugify('Atai Life Sciences, Inc.')).toBe('atai-life-sciences-inc');
  });
});

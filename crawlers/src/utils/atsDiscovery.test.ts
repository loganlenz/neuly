import { describe, it, expect } from 'vitest';
import { slugCandidates } from './atsDiscovery.js';

describe('slugCandidates', () => {
  it('generates concatenated and hyphenated variants', () => {
    const candidates = slugCandidates('COMPASS Pathways');
    expect(candidates).toContain('compasspathways');
    expect(candidates).toContain('compass-pathways');
    expect(candidates).toContain('compass');
  });

  it('strips corporate suffixes', () => {
    expect(slugCandidates('Atai Life Sciences')).toContain('atai');
    expect(slugCandidates('Numinus Wellness')).toContain('numinus');
    expect(slugCandidates('Cybin Inc')).toContain('cybin');
  });

  it('strips stacked suffixes', () => {
    // "Awakn Life Sciences Corp" -> strip "corp" then "life sciences"
    expect(slugCandidates('Awakn Life Sciences Corp')).toContain('awakn');
  });

  it('ignores punctuation and casing', () => {
    const candidates = slugCandidates('Beckley Psytech, Ltd.');
    expect(candidates).toContain('beckleypsytech');
    expect(candidates).toContain('beckley');
  });

  it('drops candidates that are too short to be slugs', () => {
    for (const slug of slugCandidates('GH Research')) {
      expect(slug.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('returns nothing for empty input', () => {
    expect(slugCandidates('')).toEqual([]);
    expect(slugCandidates('!!!')).toEqual([]);
  });

  it('deduplicates single-word names', () => {
    const candidates = slugCandidates('Cybin');
    expect(candidates).toEqual(['cybin']);
  });
});

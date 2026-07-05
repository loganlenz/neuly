import { describe, it, expect } from 'vitest';
import { detectSubstances } from './substances.js';

describe('detectSubstances', () => {
  it('detects common substances in text', () => {
    expect(detectSubstances('Psilocybin therapy for depression')).toContain('Psilocybin');
    expect(detectSubstances('MDMA-assisted therapy for PTSD')).toContain('MDMA');
    expect(detectSubstances('esketamine nasal spray')).toContain('Ketamine');
    expect(detectSubstances('lysergic acid diethylamide microdosing')).toContain('LSD');
  });

  it('prefers 5-MeO-DMT over generic DMT when only 5-MeO is mentioned', () => {
    const result = detectSubstances('A trial of 5-MeO-DMT in depression');
    expect(result).toContain('5-MeO-DMT');
    expect(result).not.toContain('DMT');
  });

  it('keeps both tags when both forms are mentioned', () => {
    const result = detectSubstances('Comparing DMT and 5-MeO-DMT pharmacology');
    expect(result).toContain('5-MeO-DMT');
    expect(result).toContain('DMT');
  });

  it('does not match substrings inside other words', () => {
    // "lsd" must not match inside e.g. "fields"; word boundary applies
    expect(detectSubstances('the fields of study')).toEqual([]);
    expect(detectSubstances('pharmacology handbook')).toEqual([]);
  });

  it('returns empty for irrelevant or empty text', () => {
    expect(detectSubstances('A study of aspirin')).toEqual([]);
    expect(detectSubstances(undefined)).toEqual([]);
    expect(detectSubstances(null)).toEqual([]);
  });
});

import { Substance } from '../models/types.js';

/** Words that mark a text as being about psychedelic / plant medicine */
const PSYCHEDELIC_CONTEXT = /psychedelic|hallucinogen|entheogen|psilocybin|psilocin|ayahuasca|mescaline|5-ht2a|serotonergic|microdos|tryptamine|psychoplastogen|mystical experience|altered states?/i;

/** Keyword patterns for tagging free text with tracked substances */
const SUBSTANCE_PATTERNS: Array<[Substance, RegExp]> = [
  ['Psilocybin', /psilocybin|psilocin|magic mushroom/i],
  ['MDMA', /\bmdma\b|midomafetamine|ecstasy-assisted|3,4-methylenedioxymethamphetamine/i],
  ['Ketamine', /ketamine|esketamine|spravato/i],
  ['LSD', /\blsd\b|lysergic acid diethylamide|lysergide|lysergic/i],
  ['5-MeO-DMT', /5-meo-dmt|5-methoxy-n,n-dimethyltryptamine|mebufotenin/i],
  ['DMT', /\bdmt\b|n,n-dimethyltryptamine/i],
  ['Ibogaine', /ibogaine|iboga\b|noribogaine/i],
  ['Ayahuasca', /ayahuasca|banisteriopsis/i],
  ['Cannabis', /cannabis|cannabinoid|marijuana|\bthc\b|\bcbd\b/i],
  ['Mescaline', /mescaline|peyote|san pedro|huachuma|wachuma|echinopsis pachanoi|trichocereus/i],
  // Plant and fungal medicines beyond the classic psychedelics
  ['Kratom', /kratom|mitragyn|7-hydroxymitragynine|speciosa/i],
  ['Kava', /\bkava\b|kavalactone|piper methysticum/i],
  ['Salvia', /salvinorin|salvia divinorum/i],
  ['Kanna', /\bkanna\b|sceletium|mesembrine/i],
  // muscimol/ibotenic acid alone are generic GABA-A lab reagents — require the mushroom
  ['Amanita Muscaria', /amanita muscaria|fly agaric|amanita pantherina/i]
];

/**
 * Detect tracked substances mentioned in free text.
 * 5-MeO-DMT is matched before DMT so the more specific tag wins,
 * but a plain "DMT" mention still tags DMT.
 */
export function detectSubstances(text: string | undefined | null): Substance[] {
  if (!text) return [];

  const found: Substance[] = [];
  for (const [substance, pattern] of SUBSTANCE_PATTERNS) {
    if (pattern.test(text)) {
      found.push(substance);
    }
  }

  // Bare acronyms collide with unrelated fields: "LSD" is also lumpy skin
  // disease and lysosomal storage disease, "DMT" is disease-modifying therapy
  // in multiple sclerosis. Keep the tag only when the full name appears or
  // the text is otherwise about psychedelics.
  if (found.includes('LSD') && !/lysergic/i.test(text) && !PSYCHEDELIC_CONTEXT.test(text)) {
    found.splice(found.indexOf('LSD'), 1);
  }
  if (found.includes('DMT') && !/dimethyltryptamine|5-meo-dmt/i.test(text) && !PSYCHEDELIC_CONTEXT.test(text)) {
    found.splice(found.indexOf('DMT'), 1);
  }

  // A 5-MeO-DMT match also trips the generic DMT pattern; drop the
  // generic tag unless plain DMT is mentioned outside the 5-MeO context.
  if (found.includes('5-MeO-DMT') && found.includes('DMT')) {
    const without5meo = text.replace(/5-meo-dmt|5-methoxy-n,n-dimethyltryptamine/gi, '');
    if (!/\bdmt\b|n,n-dimethyltryptamine/i.test(without5meo)) {
      found.splice(found.indexOf('DMT'), 1);
    }
  }

  return found;
}

/** Search terms used by crawlers that query APIs per-substance */
export const SUBSTANCE_QUERY_TERMS = [
  'psilocybin',
  'MDMA',
  'ketamine',
  'LSD',
  'DMT',
  'ibogaine',
  'ayahuasca',
  'mescaline',
  'kratom',
  'kava',
  'salvinorin',
  'sceletium',
  '"amanita muscaria"',
  'psychedelic'
] as const;

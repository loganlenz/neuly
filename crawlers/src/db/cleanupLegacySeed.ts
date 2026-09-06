#!/usr/bin/env node
/**
 * Remove rows written by earlier versions of the seed script.
 *
 * Earlier seeds shipped placeholder trials, papers, jobs and events with
 * invented identifiers, and company/person rows whose ids differed from the
 * ones the crawlers write (so both copies accumulated). This deletes exactly
 * those legacy ids — nothing a crawler has written is touched — and is safe
 * to run on every deploy.
 *
 * Usage: npx tsx src/db/cleanupLegacySeed.ts
 */
import 'dotenv/config';
import { createStorage } from '../utils/storageBackend.js';
import { DataType } from '../utils/storage.js';
import { logger } from '../utils/logger.js';

export const LEGACY_SEED_IDS: Partial<Record<DataType, string[]>> = {
  clinical_trials: [
    'ct_nct05624268', 'ct_nct04030169', 'ct_nct05547516', 'ct_nct05312151', 'ct_nct04620759',
    'ct_ketamine_trd', 'ct_ibogaine_oud', 'ct_psilocybin_smoking'
  ],
  research_papers: [
    'pm_38092756', 'pm_37586423', 'pm_37234567', 'pm_36543210', 'pm_35678901', 'pm_36789012',
    'pm_37890123', 'pm_38901234'
  ],
  jobs: ['job_1', 'job_2', 'job_3', 'job_4', 'job_5', 'job_6', 'job_7', 'job_8', 'job_9', 'job_10', 'job_11', 'job_12'],
  events: [
    'evt_psci-2025', 'evt_icpr-2025', 'evt_breaking-convention', 'evt_horizons', 'evt_ketamine-conf',
    'evt_investor-summit', 'evt_fluence-training', 'evt_compass-webinar', 'evt_spirit-pharm',
    'evt_women-psych', 'evt_microdosing-webinar', 'evt_pma-2025'
  ],
  // Seed ids that never matched the crawler's ids for the same company
  companies: ['co_cybin', 'co_numinus', 'co_usona', 'co_delix', 'co_awakn', 'co_mindbloom', 'co_gilgamesh', 'co_clerkenwell-health'],
  // Seed ids that never matched the crawler's ids ("Dr." prefix) for the same person
  people: [
    'per_robin-carhart-harris', 'per_matthew-johnson', 'per_david-nutt', 'per_roland-griffiths',
    'per_florian-brand', 'per_gul-dolen', 'per_david-olson', 'per_jennifer-mitchell',
    'per_franz-vollenweider', 'per_katrin-preller', 'per_charles-raison', 'per_michael-bogenschutz',
    'per_ben-sessa'
  ]
};

async function main(): Promise<void> {
  const storage = await createStorage();
  let removed = 0;
  for (const [type, ids] of Object.entries(LEGACY_SEED_IDS) as Array<[DataType, string[]]>) {
    const existing = await storage.load(type);
    const present = new Set(existing.map(row => row.id));
    const toDelete = ids.filter(id => present.has(id));
    if (toDelete.length === 0) continue;
    await storage.delete(type, toDelete);
    removed += toDelete.length;
    logger.info(`[cleanup] ${type}: removed ${toDelete.length} legacy seed rows`);
  }
  logger.info(`[cleanup] done — ${removed} legacy rows removed (storage: ${storage.label})`);
  await storage.close();
}

main().catch(error => {
  logger.error(`[cleanup] failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

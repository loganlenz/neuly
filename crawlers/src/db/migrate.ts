#!/usr/bin/env node
import 'dotenv/config';
import { PostgresStorage } from '../utils/postgresStorage.js';
import { logger } from '../utils/logger.js';

/**
 * Apply db/schema.sql to the database in DATABASE_URL.
 * The schema is idempotent, so this is safe to run repeatedly.
 */
async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('DATABASE_URL is not set. Example: postgresql://neuly:neuly@127.0.0.1:5432/neuly');
    process.exit(1);
  }

  const storage = new PostgresStorage(databaseUrl);
  try {
    await storage.init();
    logger.info(`Migration applied to ${storage.label}`);
  } finally {
    await storage.close();
  }
}

migrate().catch(error => {
  logger.error(`Migration failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

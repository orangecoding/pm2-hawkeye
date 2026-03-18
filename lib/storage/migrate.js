/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Migration runner.
 *
 * Discovers all `.js` files in `lib/storage/migrations/`, sorts them
 * lexicographically, and applies any that have not yet been recorded in the
 * `schema_migrations` table.  Applied migrations are tracked by filename and
 * SHA-256 checksum; a checksum mismatch on an already-applied migration is
 * logged as a warning (the migration is skipped, not re-run).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import logger from '../service/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Run all pending migrations against `db`.
 *
 * Exits the process with code 1 if a migration fails.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<void>}
 */
export async function runMigrations(db) {
  // Ensure tracking table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT    PRIMARY KEY,
      checksum   TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  const getApplied = db.prepare('SELECT filename, checksum FROM schema_migrations WHERE filename = ?');
  const insertApplied = db.prepare('INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)');

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const source = fs.readFileSync(filePath, 'utf8');
    const checksum = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

    const row = getApplied.get(file);

    if (row) {
      if (row.checksum !== checksum) {
        logger.warn(`[MIGRATE] Checksum mismatch for already-applied migration: ${file}. Skipping.`);
      }
      // Already applied - skip.
      continue;
    }

    // New migration - run it inside a transaction.
    logger.info(`[MIGRATE] Applying migration: ${file}`);
    try {
      const { up } = await import(pathToFileURL(filePath).href);
      db.transaction(() => {
        up(db);
        insertApplied.run(file, checksum, Date.now());
      })();
      logger.info(`[MIGRATE] Applied: ${file}`);
    } catch (err) {
      logger.error(`[MIGRATE] Failed to apply migration ${file}: ${err.message}`);
      process.exit(1);
    }
  }
}

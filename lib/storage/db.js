/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * SQLite database singleton.
 *
 * Call `initDb(path)` once at startup to open the database and run migrations.
 * All other modules obtain the shared handle via `getDb()`.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import logger from '../service/logger.js';

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * Initialise the SQLite database.
 *
 * Creates the parent directory if needed, opens the database in WAL mode
 * with foreign keys and an 8 MB page cache, then runs pending migrations.
 *
 * @param {string} dbPath - Absolute or relative path to the SQLite file.
 *   Pass `':memory:'` for an in-memory database (useful in tests).
 * @returns {Promise<import('better-sqlite3').Database>}
 */
export async function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -8192'); // 8 MB

  logger.info(`[DB] Opened database at ${dbPath}`);

  await runMigrations(db);

  _db = db;
  return db;
}

/**
 * Return the shared database handle.
 *
 * @returns {import('better-sqlite3').Database}
 * @throws {Error} If `initDb()` has not been called yet.
 */
export function getDb() {
  if (!_db) {
    throw new Error('Database not initialised. Call initDb() first.');
  }
  return _db;
}

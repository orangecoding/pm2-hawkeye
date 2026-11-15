/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * SQLite database singleton.
 *
 * Call `initDb(path)` once at startup to open the database and run migrations.
 * All other modules obtain the shared handle via `getDb()`.
 *
 * Retention purges only run DELETE, and SQLite keeps the space of deleted
 * rows inside the file. The database therefore runs with incremental
 * auto-vacuum and a size limit on the WAL file, and `compactDb()` hands the
 * freed space back to the file system after every purge.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import logger from '../service/logger.js';

/** `PRAGMA auto_vacuum` value of incremental mode. */
const AUTO_VACUUM_INCREMENTAL = 2;

/**
 * Size the WAL file is cut back to once a checkpoint has copied it into the
 * database. Without a limit it keeps the size of the largest write it ever
 * held.
 */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * Initialise the SQLite database.
 *
 * Creates the parent directory if needed, opens the database in WAL mode
 * with foreign keys, an 8 MB page cache and incremental auto-vacuum, runs
 * pending migrations, and converts a database created without auto-vacuum.
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
  // Takes effect right away only on a database without tables, so it comes
  // first. An existing database needs the VACUUM in enableIncrementalVacuum.
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -8192'); // 8 MB

  logger.info(`[DB] Opened database at ${dbPath}`);

  await runMigrations(db);
  enableIncrementalVacuum(db);

  _db = db;
  return db;
}

/**
 * Switch a database created without auto-vacuum to incremental mode.
 *
 * SQLite only changes the mode of a database that already has tables during
 * a VACUUM, which rewrites the whole file. That happens once per database and
 * can take minutes on a large one. It needs free disk space of about the
 * database size; if it fails, Hawkeye runs on and tries again at the next
 * start.
 *
 * @param {import('better-sqlite3').Database} db
 */
function enableIncrementalVacuum(db) {
  if (db.pragma('auto_vacuum', { simple: true }) === AUTO_VACUUM_INCREMENTAL) return;

  logger.info('[DB] Rebuilding the database once to release unused space. This can take a few minutes.');
  try {
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    logger.info('[DB] Database rebuilt');
  } catch (err) {
    logger.warn(`[DB] Rebuilding the database failed, retrying at the next start: ${err.message}`);
  }
}

/**
 * Return the space of deleted rows to the file system and empty the WAL file.
 *
 * Meant to run right after the retention purges. Without it the database
 * file keeps the size of the largest amount of data it ever held.
 */
export function compactDb() {
  const db = getDb();
  db.exec('PRAGMA incremental_vacuum');
  db.pragma('wal_checkpoint(TRUNCATE)');
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

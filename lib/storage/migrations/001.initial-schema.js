/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Initial database schema.
 *
 * Creates three tables:
 *   - `monitored_processes`  – processes the user chose to monitor
 *   - `metrics_history`      – CPU/memory samples every 20 s per process
 *   - `log_entries`          – stored log lines for up to 14 days
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE monitored_processes (
      id         TEXT    PRIMARY KEY,
      pm2_name   TEXT    NOT NULL UNIQUE,
      is_orphan  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE metrics_history (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      monitored_process_id TEXT    NOT NULL REFERENCES monitored_processes(id) ON DELETE CASCADE,
      sampled_at           INTEGER NOT NULL,
      cpu                  REAL    NOT NULL,
      memory               INTEGER NOT NULL
    );
    CREATE INDEX metrics_history_proc_time ON metrics_history(monitored_process_id, sampled_at DESC);

    CREATE TABLE log_entries (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      monitored_process_id TEXT    NOT NULL REFERENCES monitored_processes(id) ON DELETE CASCADE,
      logged_at            INTEGER NOT NULL,
      log_level            TEXT,
      log                  TEXT    NOT NULL
    );
    CREATE INDEX log_entries_proc_time ON log_entries(monitored_process_id, logged_at DESC);
  `);
}

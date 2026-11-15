/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Index the timestamps the hourly retention purges delete by.
 *
 * `log_entries` and `metrics_history` were only indexed by process and time,
 * which a `WHERE logged_at < ?` across all processes cannot use, so every
 * purge read the whole table. `custom_metrics_history` and
 * `host_metrics_history` have a time index already.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE INDEX log_entries_time ON log_entries(logged_at);
    CREATE INDEX metrics_history_time ON metrics_history(sampled_at);
  `);
}

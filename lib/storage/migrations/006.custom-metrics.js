/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Custom metrics schema.
 *
 * Adds the `custom_metrics_history` table for the values applications report
 * through tx2 or @pm2/io. PM2 keeps the latest value of each metric in
 * `pm2_env.axm_monitor`; the metrics scheduler samples those values every
 * 20 seconds for monitored processes, next to CPU and memory.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE custom_metrics_history (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      monitored_process_id TEXT    NOT NULL REFERENCES monitored_processes(id) ON DELETE CASCADE,
      metric_name          TEXT    NOT NULL,
      unit                 TEXT,
      sampled_at           INTEGER NOT NULL,
      value                REAL    NOT NULL
    );
    CREATE INDEX custom_metrics_history_proc_name_time
      ON custom_metrics_history(monitored_process_id, metric_name, sampled_at DESC);
    CREATE INDEX custom_metrics_history_time ON custom_metrics_history(sampled_at);
  `);
}

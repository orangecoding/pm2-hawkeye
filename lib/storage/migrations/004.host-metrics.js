/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Adds the host_metrics_history table for server-level CPU, RAM, and Disk
 * percentage samples recorded every 20 seconds alongside per-process metrics.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    CREATE TABLE host_metrics_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sampled_at INTEGER NOT NULL,
      cpu        REAL    NOT NULL,
      ram        REAL    NOT NULL,
      disk       REAL    NOT NULL
    );
    CREATE INDEX idx_host_metrics_time ON host_metrics_history(sampled_at DESC);
  `);
}

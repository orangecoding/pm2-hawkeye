/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for host-level CPU, RAM, and disk percentage samples.
 *
 * Samples are recorded every 20 seconds and retained for up to 24 hours
 * (configurable via `retentionMs`), mirroring the per-process metrics table.
 */

import { getDb } from './db.js';
import config from '../config.js';

/**
 * Insert a host metric sample into the history table.
 *
 * Any null argument (collection error on the host) causes the sample to be
 * skipped entirely so the chart never stores partial data.
 *
 * @param {number|null} cpu  - CPU load percentage (0-100), or null on error.
 * @param {number|null} ram  - RAM usage percentage (0-100), or null on error.
 * @param {number|null} disk - Disk usage percentage (0-100), or null on error.
 */
export function insertHostMetric(cpu, ram, disk) {
  if (cpu === null || ram === null || disk === null) return;

  getDb()
    .prepare('INSERT INTO host_metrics_history (sampled_at, cpu, ram, disk) VALUES (?, ?, ?, ?)')
    .run(Date.now(), cpu, ram, disk);
}

/**
 * Return the most recent `limit` host metric samples, ordered oldest-first
 * so they are ready for charting.
 *
 * @param {number} [limit=180] - Maximum number of samples to return.
 * @returns {{ sampled_at: number, cpu: number, ram: number, disk: number }[]}
 */
export function getHostMetrics(limit = 180) {
  return getDb()
    .prepare(
      `SELECT sampled_at, cpu, ram, disk
         FROM host_metrics_history
        ORDER BY sampled_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit)
    .reverse(); // oldest first for charting
}

/**
 * Delete host metric samples older than `retentionMs` milliseconds.
 *
 * @param {number} [retentionMs] - Retention window. Defaults to `METRICS_RETENTION_MS` from config.
 */
export function purgeOldHostMetrics(retentionMs = config.METRICS_RETENTION_MS) {
  const cutoff = Date.now() - retentionMs;
  getDb().prepare('DELETE FROM host_metrics_history WHERE sampled_at < ?').run(cutoff);
}

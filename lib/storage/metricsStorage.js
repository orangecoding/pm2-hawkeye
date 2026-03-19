/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for CPU/memory metric samples.
 *
 * Samples are recorded every 20 seconds per monitored process and retained
 * for up to 24 hours (configurable via `retentionMs`).
 */

import { getDb } from './db.js';
import config from '../config.js';

/**
 * Insert a CPU/memory sample only when the values have changed since the last
 * stored sample.  Skipping unchanged readings keeps the table compact and
 * allows the sparkline to correctly represent time gaps as flat segments.
 *
 * @param {string} monitoredProcessId - UUID from `monitored_processes.id`.
 * @param {number} cpu - CPU usage percentage.
 * @param {number} memory - Memory usage in bytes.
 */
export function insertMetric(monitoredProcessId, cpu, memory) {
  const db = getDb();
  const last = db
    .prepare(
      'SELECT cpu, memory FROM metrics_history WHERE monitored_process_id = ? ORDER BY sampled_at DESC, id DESC LIMIT 1',
    )
    .get(monitoredProcessId);

  if (last && last.cpu === cpu && last.memory === memory) {
    return; // nothing changed - skip
  }

  db.prepare('INSERT INTO metrics_history (monitored_process_id, sampled_at, cpu, memory) VALUES (?, ?, ?, ?)').run(
    monitoredProcessId,
    Date.now(),
    cpu,
    memory,
  );
}

/**
 * Return the most recent `limit` samples for a monitored process, ordered
 * oldest-first so they are ready for charting.
 *
 * @param {string} monitoredProcessId
 * @param {number} [limit=180] - Maximum number of samples to return.
 * @returns {{ sampled_at: number, cpu: number, memory: number }[]}
 */
export function getMetrics(monitoredProcessId, limit = 180) {
  return getDb()
    .prepare(
      `SELECT sampled_at, cpu, memory
         FROM metrics_history
        WHERE monitored_process_id = ?
        ORDER BY sampled_at DESC, id DESC
        LIMIT ?`,
    )
    .all(monitoredProcessId, limit)
    .reverse(); // oldest first for charting
}

/**
 * Delete metric samples older than `retentionMs` milliseconds.
 *
 * @param {number} [retentionMs] - Retention window. Defaults to `METRICS_RETENTION_MS` from config.
 */
export function purgeOldMetrics(retentionMs = config.METRICS_RETENTION_MS) {
  const cutoff = Date.now() - retentionMs;
  getDb().prepare('DELETE FROM metrics_history WHERE sampled_at < ?').run(cutoff);
}

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
 * Default bucket width for windowed host metrics.
 *
 * A full retention window sampled every 20 s is thousands of rows, far more
 * than a chart a few hundred pixels wide can show. Averaging into 5-minute
 * buckets keeps a 24-hour window at 288 points, which draws the same curve for
 * a fraction of the payload.
 */
export const HOST_METRICS_BUCKET_MS = 5 * 60 * 1000;

/**
 * Return host metrics for a time window, averaged into fixed-width buckets and
 * ordered oldest-first so they are ready for charting.
 *
 * @param {number} [windowMs] - How far back to read. Defaults to `METRICS_RETENTION_MS`.
 * @param {number} [bucketMs] - Bucket width. Defaults to `HOST_METRICS_BUCKET_MS`.
 * @returns {{ sampled_at: number, cpu: number, ram: number, disk: number }[]}
 */
export function getHostMetricsWindow(windowMs = config.METRICS_RETENTION_MS, bucketMs = HOST_METRICS_BUCKET_MS) {
  const since = Date.now() - windowMs;
  return getDb()
    .prepare(
      `SELECT CAST(sampled_at / ? AS INTEGER) * ? AS sampled_at,
              AVG(cpu)  AS cpu,
              AVG(ram)  AS ram,
              AVG(disk) AS disk
         FROM host_metrics_history
        WHERE sampled_at >= ?
        GROUP BY CAST(sampled_at / ? AS INTEGER)
        ORDER BY sampled_at ASC`,
    )
    .all(bucketMs, bucketMs, since, bucketMs);
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

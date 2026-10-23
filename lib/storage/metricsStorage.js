/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for per-process metric samples: CPU/memory and the
 * application metrics a process reports through tx2 or @pm2/io.
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
 * Store one sample per application metric (tx2 / @pm2/io) for a monitored
 * process. As with `insertMetric`, a metric whose value and unit match its
 * last stored sample is skipped, so a constant metric costs one row rather
 * than one row every 20 seconds.
 *
 * @param {string} monitoredProcessId - UUID from `monitored_processes.id`.
 * @param {{ name: string, value: number, unit: string | null }[]} metrics - Output of `extractCustomMetrics`.
 */
export function insertCustomMetrics(monitoredProcessId, metrics) {
  if (!metrics.length) return;
  const db = getDb();
  const lastStmt = db.prepare(
    `SELECT unit, value
       FROM custom_metrics_history
      WHERE monitored_process_id = ? AND metric_name = ?
      ORDER BY sampled_at DESC, id DESC
      LIMIT 1`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO custom_metrics_history (monitored_process_id, metric_name, unit, sampled_at, value)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();

  db.transaction(() => {
    for (const metric of metrics) {
      const unit = metric.unit ?? null;
      const last = lastStmt.get(monitoredProcessId, metric.name);
      if (last && last.value === metric.value && last.unit === unit) continue;
      insertStmt.run(monitoredProcessId, metric.name, unit, now, metric.value);
    }
  })();
}

/**
 * Return the most recent `limit` samples of every application metric stored
 * for a monitored process, grouped by metric name and ordered oldest-first.
 * The unit reported is the one carried by the newest sample.
 *
 * @param {string} monitoredProcessId
 * @param {number} [limit=180] - Maximum number of samples per metric.
 * @returns {{ name: string, unit: string | null, samples: { sampled_at: number, value: number }[] }[]}
 */
export function getCustomMetrics(monitoredProcessId, limit = 180) {
  const rows = getDb()
    .prepare(
      `SELECT metric_name, unit, sampled_at, value
         FROM (
           SELECT metric_name, unit, sampled_at, value, id,
                  ROW_NUMBER() OVER (PARTITION BY metric_name ORDER BY sampled_at DESC, id DESC) AS rn
             FROM custom_metrics_history
            WHERE monitored_process_id = ?
         )
        WHERE rn <= ?
        ORDER BY metric_name, sampled_at, id`,
    )
    .all(monitoredProcessId, limit);

  /** @type {Map<string, { name: string, unit: string | null, samples: { sampled_at: number, value: number }[] }>} */
  const byName = new Map();
  for (const row of rows) {
    let entry = byName.get(row.metric_name);
    if (!entry) {
      entry = { name: row.metric_name, unit: null, samples: [] };
      byName.set(row.metric_name, entry);
    }
    entry.unit = row.unit; // rows are oldest-first, so the last one wins
    entry.samples.push({ sampled_at: row.sampled_at, value: row.value });
  }
  return [...byName.values()];
}

/**
 * Delete metric samples, CPU/memory and application metrics alike, older than
 * `retentionMs` milliseconds.
 *
 * @param {number} [retentionMs] - Retention window. Defaults to `METRICS_RETENTION_MS` from config.
 */
export function purgeOldMetrics(retentionMs = config.METRICS_RETENTION_MS) {
  const cutoff = Date.now() - retentionMs;
  const db = getDb();
  db.prepare('DELETE FROM metrics_history WHERE sampled_at < ?').run(cutoff);
  db.prepare('DELETE FROM custom_metrics_history WHERE sampled_at < ?').run(cutoff);
}

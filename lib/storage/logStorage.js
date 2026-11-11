/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for persisted log entries.
 *
 * Each entry may span multiple lines (e.g. stack traces). The `log` field is
 * stored as a JSON string: `{ lines: string[], raw: string }`.
 * Entries are retained for up to 14 days (configurable via `retentionMs`).
 */

import { getDb } from './db.js';
import config from '../config.js';

/**
 * @typedef {Object} LogEntryInput
 * @property {number} loggedAt - Unix timestamp (ms) of the entry.
 * @property {string | null} logLevel - 'error' | 'warn' | 'info' | 'debug' | null
 * @property {string} log      - JSON string: `{ lines: string[], raw: string }`
 */

/**
 * Persist a log entry for a monitored process.
 *
 * @param {string} monitoredProcessId - UUID from `monitored_processes.id`.
 * @param {LogEntryInput} entry
 */
export function insertLogEntry(monitoredProcessId, { loggedAt, logLevel, log }) {
  getDb()
    .prepare('INSERT INTO log_entries (monitored_process_id, logged_at, log_level, log) VALUES (?, ?, ?, ?)')
    .run(monitoredProcessId, loggedAt, logLevel, log);
}

/**
 * Retrieve stored log entries for a monitored process.
 *
 * Returns up to `limit` entries, optionally filtered to entries recorded
 * before the given `(before, beforeId)` cursor, ordered newest-first. A
 * timestamp-only `before` value remains supported for older callers.
 *
 * @param {string} monitoredProcessId
 * @param {{ limit?: number, before?: number, beforeId?: number, levels?: string[] }} [opts] -
 *   `levels` keeps only entries whose detected level is one of them.
 * @returns {{ id: number, logged_at: number, log_level: string, log: string }[]}
 */
export function getLogEntries(monitoredProcessId, { limit = 200, before, beforeId, levels } = {}) {
  const where = ['monitored_process_id = ?'];
  const params = [monitoredProcessId];

  if (before !== undefined && beforeId !== undefined) {
    where.push('(logged_at < ? OR (logged_at = ? AND id < ?))');
    params.push(before, before, beforeId);
  } else if (before !== undefined) {
    where.push('logged_at < ?');
    params.push(before);
  }

  if (levels?.length) {
    where.push(`log_level IN (${levels.map(() => '?').join(', ')})`);
    params.push(...levels);
  }

  return getDb()
    .prepare(
      `SELECT id, logged_at, log_level, log
         FROM log_entries
        WHERE ${where.join(' AND ')}
        ORDER BY logged_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit);
}

/**
 * Return the most recent log entry for a monitored process, or undefined if
 * none exist.
 *
 * @param {string} monitoredProcessId
 * @returns {{ logged_at: number } | undefined}
 */
export function getLastLogEntry(monitoredProcessId) {
  return getDb()
    .prepare(
      `SELECT logged_at FROM log_entries
        WHERE monitored_process_id = ?
        ORDER BY logged_at DESC, id DESC
        LIMIT 1`,
    )
    .get(monitoredProcessId);
}

/**
 * Return stored log payloads from an inclusive timestamp boundary.
 *
 * This is used to reconcile the inclusive startup-backfill boundary without
 * dropping distinct entries that happen to share a timestamp.
 *
 * @param {string} monitoredProcessId
 * @param {number} since
 * @returns {{ logged_at: number, log: string }[]}
 */
export function getLogEntriesSince(monitoredProcessId, since) {
  return getDb()
    .prepare(
      `SELECT logged_at, log FROM log_entries
        WHERE monitored_process_id = ? AND logged_at >= ?
        ORDER BY logged_at ASC, id ASC`,
    )
    .all(monitoredProcessId, since);
}

/**
 * Delete log entries older than `retentionMs` milliseconds.
 *
 * @param {number} [retentionMs] - Retention window. Defaults to `LOGS_RETENTION_MS` from config.
 */
export function purgeOldLogs(retentionMs = config.LOGS_RETENTION_MS) {
  const cutoff = Date.now() - retentionMs;
  getDb().prepare('DELETE FROM log_entries WHERE logged_at < ?').run(cutoff);
}

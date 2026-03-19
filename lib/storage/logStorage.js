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
 * before the given `before` timestamp (exclusive), ordered newest-first.
 *
 * @param {string} monitoredProcessId
 * @param {{ limit?: number, before?: number }} [opts]
 * @returns {{ id: number, logged_at: number, log_level: string, log: string }[]}
 */
export function getLogEntries(monitoredProcessId, { limit = 200, before } = {}) {
  if (before !== undefined) {
    return getDb()
      .prepare(
        `SELECT id, logged_at, log_level, log
           FROM log_entries
          WHERE monitored_process_id = ?
            AND logged_at < ?
          ORDER BY logged_at DESC, id DESC
          LIMIT ?`,
      )
      .all(monitoredProcessId, before, limit);
  }

  return getDb()
    .prepare(
      `SELECT id, logged_at, log_level, log
         FROM log_entries
        WHERE monitored_process_id = ?
        ORDER BY logged_at DESC, id DESC
        LIMIT ?`,
    )
    .all(monitoredProcessId, limit);
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
 * Delete log entries older than `retentionMs` milliseconds.
 *
 * @param {number} [retentionMs] - Retention window. Defaults to `LOGS_RETENTION_MS` from config.
 */
export function purgeOldLogs(retentionMs = config.LOGS_RETENTION_MS) {
  const cutoff = Date.now() - retentionMs;
  getDb().prepare('DELETE FROM log_entries WHERE logged_at < ?').run(cutoff);
}

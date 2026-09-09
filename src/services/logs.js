/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Convert DB log entries (newest-first) to flat display lines (oldest-first).
 *
 * @param {object[]} entries
 * @returns {{text: string, source: string, logLevel: string}[]}
 */
export function convertEntriesToLines(entries) {
  return entries
    .slice()
    .reverse()
    .flatMap((entry) => {
      const logLevel = entry.log_level || '';
      try {
        const parsed = JSON.parse(entry.log);
        return (parsed.lines || []).map((text, index) => ({
          key: `stored-${entry.id}-${index}`,
          text,
          source: 'stored',
          logLevel,
        }));
      } catch {
        return [{ key: `stored-${entry.id}-0`, text: entry.log, source: 'stored', logLevel }];
      }
    });
}

/**
 * Build the stored-log endpoint URL for an optional keyset cursor.
 *
 * @param {string|number} processId
 * @param {{before: number, beforeId: number}|null} [cursor]
 * @returns {string}
 */
export function buildStoredLogsUrl(processId, cursor = null) {
  const base = `/api/processes/${encodeURIComponent(processId)}/logs/stored`;
  if (!cursor) return base;
  const params = new URLSearchParams({ before: String(cursor.before), beforeId: String(cursor.beforeId) });
  return `${base}?${params}`;
}

/**
 * Prepend an older page while retaining the newer lines already displayed.
 *
 * @param {object[]} current
 * @param {object[]} older
 * @returns {object[]}
 */
export function prependStoredLogPage(current, older) {
  return [...older, ...current];
}

/**
 * Append items while retaining only the newest bounded window.
 *
 * @param {object[]} current
 * @param {object[]} incoming
 * @param {number} limit
 * @returns {object[]}
 */
export function appendBounded(current, incoming, limit) {
  return [...current, ...incoming].slice(-limit);
}

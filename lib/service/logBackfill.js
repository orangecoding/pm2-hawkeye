/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Log backfill service.
 *
 * Two entry points:
 *   - `backfillLogs`                -- called when monitoring is first enabled
 *     for a process; reads all existing log lines and stores them.
 *   - `startupBackfillAllMonitored` -- called once on server startup; for each
 *     monitored process, reads the log files and inserts only lines that are
 *     newer than the most recent entry already stored in the database.
 */

import * as pm2 from './pm2Service.js';
import { extractTimestamp } from './pm2Service.js';
import { getAllMonitored } from '../storage/monitoringStorage.js';
import { getLastLogEntry, getLogEntriesSince, insertLogEntry } from '../storage/logStorage.js';
import { detectLogLevel } from './logLevel.js';
import logger from './logger.js';

/**
 * Group lines into persistable primary + continuation log entries.
 *
 * Consecutive lines without a leading timestamp are treated as continuations
 * of the preceding timestamped line (e.g. stack traces).
 *
 * @param {{ text: string, source: string }[]} lines
 * @param {number} [fallbackAt] Timestamp for groups without a timestamp.
 * @returns {{ loggedAt: number, logLevel: string | null, log: string }[]}
 */
export function groupLogLines(lines, fallbackAt = Date.now()) {
  const groups = [];
  for (const line of lines) {
    const ts = extractTimestamp(line.text);
    const isContinuation = !ts && groups.length > 0;
    if (isContinuation) {
      groups[groups.length - 1].lines.push(line);
    } else {
      groups.push({ primary: line, lines: [line] });
    }
  }

  return groups.map((group) => {
    const primaryText = group.primary.text;
    const ts = extractTimestamp(primaryText);
    const loggedAt = ts ? new Date(ts.replace(' ', 'T')).getTime() || fallbackAt : fallbackAt;
    const logLevel = detectLogLevel(primaryText);
    const lineTexts = group.lines.map((l) => l.text);
    return {
      loggedAt,
      logLevel,
      log: JSON.stringify({ lines: lineTexts, raw: lineTexts.join('\n') }),
    };
  });
}

/**
 * Remove only as many matching groups as are already stored. Occurrence
 * counting preserves distinct identical messages at the same timestamp.
 *
 * @param {{ loggedAt: number, logLevel: string | null, log: string }[]} groups
 * @param {{ logged_at: number, log: string }[]} storedEntries
 * @returns {{ loggedAt: number, logLevel: string | null, log: string }[]}
 */
export function excludeStoredGroups(groups, storedEntries) {
  const remaining = new Map();
  for (const entry of storedEntries) {
    const key = `${entry.logged_at}\u0000${entry.log}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  return groups.filter((group) => {
    const key = `${group.loggedAt}\u0000${group.log}`;
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

/**
 * Group and insert log lines, reconciling an inclusive stored boundary.
 *
 * @param {{ text: string, source: string }[]} lines
 * @param {string} monitoredProcessId
 * @param {number} [boundary]
 * @returns {number} Number of groups inserted.
 */
function groupAndInsert(lines, monitoredProcessId, boundary = 0) {
  let groups = groupLogLines(lines);
  if (groups.length > 0) {
    const earliest = Math.min(...groups.map((group) => group.loggedAt));
    const reconcileSince = boundary > 0 ? Math.min(boundary, earliest) : earliest;
    groups = excludeStoredGroups(groups, getLogEntriesSince(monitoredProcessId, reconcileSince));
  }

  for (const group of groups) insertLogEntry(monitoredProcessId, group);

  return groups.length;
}

/**
 * Select timestamped log groups at or after a stored boundary. Including the
 * boundary gives restart recovery at-least-once semantics instead of dropping
 * distinct messages that share the same timestamp.
 *
 * @param {{ text: string, source: string }[]} lines
 * @param {number} since
 * @returns {{ text: string, source: string }[]}
 */
export function filterBackfillLines(lines, since) {
  if (since === 0) return lines;

  const filtered = [];
  let includeGroup = false;
  for (const line of lines) {
    const timestamp = extractTimestamp(line.text);
    if (timestamp) {
      const parsed = Date.parse(timestamp.replace(' ', 'T'));
      includeGroup = Number.isFinite(parsed) && parsed >= since;
    }
    if (includeGroup) filtered.push(line);
  }
  return filtered;
}

/**
 * Read all current log lines for `pm2Name` and insert them as log entries for
 * `monitoredProcessId`.
 *
 * Called when monitoring is first enabled for a process so the full existing
 * history is immediately available.
 *
 * @param {string} pm2Name
 * @param {string} monitoredProcessId - UUID from `monitored_processes.id`.
 * @returns {Promise<void>}
 */
export async function backfillLogs(pm2Name, monitoredProcessId) {
  try {
    const lines = await pm2.readLogLinesByName(pm2Name);
    if (!lines.length) {
      logger.info(`[BACKFILL] No existing log lines for ${pm2Name}`);
      return;
    }
    const count = groupAndInsert(lines, monitoredProcessId);
    logger.info(`[BACKFILL] Stored ${count} log entries for ${pm2Name}`);
  } catch (err) {
    logger.warn(`[BACKFILL] Failed for ${pm2Name}: ${err.message}`);
  }
}

/**
 * On server startup, backfill each monitored process with log lines that
 * arrived since the last entry stored in the database.
 *
 * For processes with no DB entries yet (e.g. monitoring was just enabled but
 * the server crashed before the first bus event), all available log lines are
 * inserted.  For processes with existing entries, only lines with a parsed
 * timestamp at or after the most-recent stored `logged_at` are inserted;
 * lines without a parseable timestamp are skipped in this case to avoid
 * inserting duplicates at an unknown position.
 *
 * @returns {Promise<void>}
 */
export async function startupBackfillAllMonitored() {
  let monitored;
  try {
    monitored = getAllMonitored();
  } catch {
    // DB not ready -- skip.
    return;
  }

  for (const row of monitored) {
    if (row.is_orphan) continue;
    try {
      const lastEntry = getLastLogEntry(row.id);
      const since = lastEntry?.logged_at ?? 0;

      const lines = await pm2.readLogLinesByName(row.pm2_name);
      if (!lines.length) continue;

      const filtered = filterBackfillLines(lines, since);

      if (!filtered.length) {
        logger.info(`[BACKFILL] No new lines for ${row.pm2_name}`);
        continue;
      }

      const count = groupAndInsert(filtered, row.id, since);
      logger.info(
        `[BACKFILL] Stored ${count} new entries for ${row.pm2_name} (since ${new Date(since).toISOString()})`,
      );
    } catch (err) {
      logger.warn(`[BACKFILL] Startup backfill failed for ${row.pm2_name}: ${err.message}`);
    }
  }
}

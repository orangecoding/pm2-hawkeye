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
import { insertLogEntry, getLastLogEntry } from '../storage/logStorage.js';
import { detectLogLevel } from './logLevel.js';
import logger from './logger.js';

/**
 * Group an array of `{ text, source }` lines into primary + continuation
 * groups and insert them as log entries for `monitoredProcessId`.
 *
 * Consecutive lines without a leading timestamp are treated as continuations
 * of the preceding timestamped line (e.g. stack traces).
 *
 * @param {{ text: string, source: string }[]} lines
 * @param {string} monitoredProcessId
 * @returns {number} Number of groups inserted.
 */
function groupAndInsert(lines, monitoredProcessId) {
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

  for (const group of groups) {
    const primaryText = group.primary.text;
    const ts = extractTimestamp(primaryText);
    const loggedAt = ts ? new Date(ts.replace(' ', 'T')).getTime() || Date.now() : Date.now();
    const logLevel = detectLogLevel(primaryText);
    const lineTexts = group.lines.map((l) => l.text);
    insertLogEntry(monitoredProcessId, {
      loggedAt,
      logLevel,
      log: JSON.stringify({ lines: lineTexts, raw: lineTexts.join('\n') }),
    });
  }

  return groups.length;
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
 * timestamp strictly after the most-recent stored `logged_at` are inserted;
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

      const filtered =
        since === 0
          ? lines
          : lines.filter((line) => {
              const ts = extractTimestamp(line.text);
              if (!ts) return false;
              const t = new Date(ts.replace(' ', 'T')).getTime();
              return !Number.isNaN(t) && t > since;
            });

      if (!filtered.length) {
        logger.info(`[BACKFILL] No new lines for ${row.pm2_name}`);
        continue;
      }

      const count = groupAndInsert(filtered, row.id);
      logger.info(
        `[BACKFILL] Stored ${count} new entries for ${row.pm2_name} (since ${new Date(since).toISOString()})`,
      );
    } catch (err) {
      logger.warn(`[BACKFILL] Startup backfill failed for ${row.pm2_name}: ${err.message}`);
    }
  }
}

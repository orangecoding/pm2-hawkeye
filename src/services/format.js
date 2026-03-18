/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Display formatting utilities.
 */

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) return '---';
  const seconds = Math.max(Math.floor((Date.now() - timestamp) / 1000), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatDate(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString('en-GB') : '---';
}

export function getStatusTone(status) {
  const s = String(status).toLowerCase();
  if (['online', 'launching'].includes(s)) return 'healthy';
  if (['stopped', 'errored', 'one-launch-status'].includes(s)) return 'critical';
  return 'muted';
}

/**
 * Detect the severity level of a log line for CSS class colouring.
 *
 * Uses the same structured patterns as the backend `lib/service/logLevel.js`
 * to avoid false positives from natural-language content (e.g. "getting info
 * from server" should not match as 'info').
 *
 * Returns an empty string (no class) when no level indicator is found.
 *
 * @param {string} text
 * @returns {'error' | 'warn' | 'info' | 'debug' | ''}
 */
export function detectLogLevel(text) {
  // -- 1. JSON-style "level" field -----------------------------------------
  if (/"level"\s*:\s*"(?:error|fatal|critical)"/i.test(text)) return 'error';
  if (/"level"\s*:\s*"warn(?:ing)?"/i.test(text)) return 'warn';
  if (/"level"\s*:\s*"info"/i.test(text)) return 'info';
  if (/"level"\s*:\s*"(?:debug|trace|verbose)"/i.test(text)) return 'debug';

  // -- 2. Bracket notation [LEVEL] / (LEVEL) ---------------------------------
  // Match only genuine bracket pairs; no spaces in the character class to
  // avoid false positives like " info " matching as a bracket pattern.
  if (/\[(?:error|fatal|crit(?:ical)?)\]|\((?:error|fatal|crit(?:ical)?)\)/i.test(text)) return 'error';
  if (/\[warn(?:ing)?\]|\(warn(?:ing)?\)/i.test(text)) return 'warn';
  if (/\[info\]|\(info\)/i.test(text)) return 'info';
  if (/\[(?:debug|trace|verbose)\]|\((?:debug|trace|verbose)\)/i.test(text)) return 'debug';

  // -- 3. Uppercase standalone label (e.g. `ERROR:`, `INFO |`, `WARN `) ----
  if (/(?:^|[\s|])(?:ERROR|FATAL|CRITICAL|EXCEPTION|CRIT)(?:[:\s|]|$)/.test(text)) return 'error';
  if (/(?:^|[\s|])WARN(?:ING)?(?:[:\s|]|$)/.test(text)) return 'warn';
  if (/(?:^|[\s|])INFO(?:[:\s|]|$)/.test(text)) return 'info';
  if (/(?:^|[\s|])(?:DEBUG|TRACE|VERBOSE)(?:[:\s|]|$)/.test(text)) return 'debug';

  return '';
}

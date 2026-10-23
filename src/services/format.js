/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Display formatting utilities.
 */

/**
 * Format a byte count with a binary unit, e.g. `1.5 GB` or `512 MB`.
 *
 * The unit is chosen from the rounded value, so 1023.6 MB reads `1.0 GB`
 * instead of `1024 MB`, and 9.96 KB reads `10 KB` instead of `10.0 KB`.
 *
 * @param {number} bytes
 * @returns {string}
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
  let digits = value >= 10 || i === 0 ? 0 : 1;
  const rounded = Number(value.toFixed(digits));
  if (rounded >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
    digits = 1;
  } else if (digits === 1 && rounded >= 10) {
    digits = 0;
  }
  return `${value.toFixed(digits)} ${units[i]}`;
}

/**
 * Format a used/total byte pair, naming the unit once when both share it:
 * `421 of 460 GB`, but `900 MB of 1.5 GB`.
 *
 * @param {number} used
 * @param {number} total
 * @returns {string}
 */
export function formatBytesOf(used, total) {
  const a = formatBytes(used);
  const b = formatBytes(total);
  const [aValue, aUnit] = a.split(' ');
  return aUnit === b.split(' ')[1] ? `${aValue} of ${b}` : `${a} of ${b}`;
}

/**
 * Parse a PM2 memory size such as `max_memory_restart` into bytes.
 *
 * PM2 accepts a plain byte count or a number with a `K`, `M` or `G` suffix
 * (binary units, case-insensitive, an optional trailing `B` is tolerated).
 *
 * @param {string|number|null|undefined} value - e.g. `300M`, `1G`, `524288000`.
 * @returns {number|null} Bytes, or null when the value is empty or unreadable.
 */
export function parseMemorySize(value) {
  if (value == null) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg])?b?\s*$/i.exec(String(value));
  if (!match) return null;
  const factor = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase()] ?? 1;
  const bytes = Math.round(Number(match[1]) * factor);
  return bytes > 0 ? bytes : null;
}

/**
 * Format a retention window in words, e.g. `24 hours` or `14 days`.
 *
 * Whole multiples of a day from two days up read as days; everything else
 * reads as hours, or as minutes below one hour.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const days = ms / 86_400_000;
  if (Number.isInteger(days) && days >= 2) return `${days} days`;
  const hours = Math.round((ms / 3_600_000) * 10) / 10;
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const minutes = Math.max(Math.round(ms / 60_000), 1);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Format a retention window compactly, e.g. `24 h`, `14 days` or `30 min`,
 * for chart headings such as "24 h peak".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatShortDuration(ms) {
  const days = ms / 86_400_000;
  if (Number.isInteger(days) && days >= 2) return `${days} days`;
  const hours = Math.round((ms / 3_600_000) * 10) / 10;
  if (hours >= 1) return `${hours} h`;
  return `${Math.max(Math.round(ms / 60_000), 1)} min`;
}

const metricNumberFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/**
 * Format an application metric value (tx2 / @pm2/io) with its unit.
 *
 * Values keep at most two decimals. A percent sign is attached directly, any
 * other unit follows after a space, and a missing unit leaves the bare number.
 *
 * @param {number} value
 * @param {string | null} [unit]
 * @returns {string}
 */
export function formatMetricValue(value, unit = null) {
  const number = metricNumberFormat.format(value);
  if (!unit) return number;
  return unit === '%' ? `${number}%` : `${number} ${unit}`;
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

/**
 * Format a moment as a short date and time, e.g. `23 Oct 2026, 11:42`.
 *
 * @param {number} timestamp - Unix ms.
 * @returns {string}
 */
export function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

/**
 * Format how long ago a moment was in words, e.g. `2 h ago` or `just now`.
 *
 * @param {number} timestamp - Unix ms.
 * @param {number} [now] - Current time in ms.
 * @returns {string}
 */
export function formatAgo(timestamp, now = Date.now()) {
  const minutes = Math.floor(Math.max(now - timestamp, 0) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
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

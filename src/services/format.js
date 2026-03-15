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

export function detectLogLevel(text) {
  const t = text.toLowerCase();
  if (/\berror\b|\bfatal\b|\bcrit(ical)?\b|\bexception\b|\btrace\b.*error/i.test(t)) return 'error';
  if (/\bwarn(ing)?\b/i.test(t)) return 'warn';
  if (/\binfo\b/i.test(t)) return 'info';
  if (/\bdebug\b|\btrace\b|\bverbose\b/i.test(t)) return 'debug';
  return '';
}

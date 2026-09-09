/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Convert a numeric form value while preserving valid zero values.
 *
 * @param {string|number} value
 * @param {number} fallback
 * @returns {number}
 */
export function normalizePm2Number(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

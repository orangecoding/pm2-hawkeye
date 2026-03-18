/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Shared log-level detection utility.
 *
 * Detects the severity level of a log line using structured patterns only --
 * never bare word matches -- to avoid false positives when the word "info",
 * "warn", etc. appears as content rather than as a label.
 *
 * Recognised formats (in evaluation order):
 *   1. JSON  - `"level":"info"` / `"level": "info"` (case-insensitive value)
 *   2. Bracket - `[INFO]` / `(INFO)` / `<INFO>` (case-insensitive)
 *   3. Uppercase label - `INFO:` / `INFO |` / standalone `INFO` (uppercase only,
 *      avoids false positives in natural-language content)
 *
 * @param {string} text - A single log line.
 * @returns {'error' | 'warn' | 'info' | 'debug' | null}
 */
export function detectLogLevel(text) {
  // -- 1. JSON-style "level" field ----------------------------------------
  if (/"level"\s*:\s*"(?:error|fatal|critical)"/i.test(text)) return 'error';
  if (/"level"\s*:\s*"warn(?:ing)?"/i.test(text)) return 'warn';
  if (/"level"\s*:\s*"info"/i.test(text)) return 'info';
  if (/"level"\s*:\s*"(?:debug|trace|verbose)"/i.test(text)) return 'debug';

  // -- 2. Bracket notation [LEVEL] / (LEVEL) ---------------------------------
  // Match only genuine bracket pairs -- no spaces in the character class to
  // avoid false positives like " info " matching as a bracket pattern.
  if (/\[(?:error|fatal|crit(?:ical)?)\]|\((?:error|fatal|crit(?:ical)?)\)/i.test(text)) return 'error';
  if (/\[warn(?:ing)?\]|\(warn(?:ing)?\)/i.test(text)) return 'warn';
  if (/\[info\]|\(info\)/i.test(text)) return 'info';
  if (/\[(?:debug|trace|verbose)\]|\((?:debug|trace|verbose)\)/i.test(text)) return 'debug';

  // -- 3. Uppercase standalone label (e.g. `ERROR:`, `INFO |`, `WARN `) ---
  // Require uppercase so natural-language content ("getting info from …")
  // does not trigger a false match.
  if (/(?:^|[\s|])(?:ERROR|FATAL|CRITICAL|EXCEPTION|CRIT)(?:[:\s|]|$)/.test(text)) return 'error';
  if (/(?:^|[\s|])WARN(?:ING)?(?:[:\s|]|$)/.test(text)) return 'warn';
  if (/(?:^|[\s|])INFO(?:[:\s|]|$)/.test(text)) return 'info';
  if (/(?:^|[\s|])(?:DEBUG|TRACE|VERBOSE)(?:[:\s|]|$)/.test(text)) return 'debug';

  return null;
}

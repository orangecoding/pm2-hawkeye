/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Store each log entry once, as plain text.
 *
 * The `log` column held JSON `{ lines, raw }`, where `raw` is nothing but the
 * lines joined with `\n`. Every line was stored twice, plus the escaping JSON
 * adds to quotes in the many applications that log JSON themselves. The
 * column now holds that `raw` text alone; readers split it at `\n`, which
 * gives back the lines, as a line never contains a newline itself.
 *
 * Rows written before the JSON format are plain text already and stay as
 * they are.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.prepare(
    `UPDATE log_entries
        SET log = json_extract(log, '$.raw')
      WHERE json_valid(log)
        AND json_type(log, '$.raw') = 'text'
        AND json_type(log, '$.lines') = 'array'`,
  ).run();
}

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * alerta 2 addresses endpoints, not phone targets.
 *
 * `reporter.alerta.targets` gave way to `reporter.alerta.endpoints`. The old value held phone
 * names, which mean nothing as endpoint names, so it is dropped instead of copied over. Left in
 * place it came back with every GET of the settings and the next save was rejected as an
 * unknown key.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.prepare("DELETE FROM alerting_settings WHERE key = 'reporter.alerta.targets'").run();
}

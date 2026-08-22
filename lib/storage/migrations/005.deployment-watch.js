/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Branch watching schema.
 *
 * Adds the per-deployment auto-deploy configuration and the bookkeeping columns
 * the branch watcher uses to decide whether a deployment is due for a poll and
 * whether the remote branch has moved ahead of what was deployed last.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    ALTER TABLE deployments ADD COLUMN watch_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE deployments ADD COLUMN watch_interval_minutes INTEGER NOT NULL DEFAULT 5;
    ALTER TABLE deployments ADD COLUMN watch_last_checked_at INTEGER;
    ALTER TABLE deployments ADD COLUMN watch_last_commit TEXT;
    ALTER TABLE deployments ADD COLUMN watch_last_error TEXT;
  `);
}

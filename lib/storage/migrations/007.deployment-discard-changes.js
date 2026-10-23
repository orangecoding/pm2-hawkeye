/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Per-deployment opt-in to discard local changes without asking.
 *
 * A redeploy that finds tracked local changes in the deploy directory normally
 * pauses and asks whether to discard them. With `discard_local_changes` set,
 * the deploy runner resets the working copy straight away, the same way an
 * auto-deploy triggered by the branch watcher does.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  db.exec(`
    ALTER TABLE deployments ADD COLUMN discard_local_changes INTEGER NOT NULL DEFAULT 0;
  `);
}

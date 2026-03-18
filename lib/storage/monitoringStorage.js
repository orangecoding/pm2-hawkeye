/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for monitored process records.
 *
 * All functions operate on the shared database handle obtained from `getDb()`.
 */

import crypto from 'node:crypto';
import { getDb } from './db.js';

/**
 * Return all rows from `monitored_processes`.
 *
 * @returns {{ id: string, pm2_name: string, is_orphan: number, created_at: number }[]}
 */
export function getAllMonitored() {
  return getDb().prepare('SELECT * FROM monitored_processes').all();
}

/**
 * Return true if a process with the given PM2 name is being monitored.
 *
 * @param {string} pm2Name
 * @returns {boolean}
 */
export function isMonitored(pm2Name) {
  const row = getDb().prepare('SELECT id FROM monitored_processes WHERE pm2_name = ?').get(pm2Name);
  return !!row;
}

/**
 * Start monitoring a process by PM2 name.
 *
 * Generates a random UUID for the new row.
 *
 * @param {string} pm2Name
 * @returns {{ id: string, pm2_name: string, is_orphan: number, created_at: number }}
 */
export function addMonitored(pm2Name) {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO monitored_processes (id, pm2_name, is_orphan, created_at) VALUES (?, ?, 0, ?)')
    .run(id, pm2Name, now);
  return { id, pm2_name: pm2Name, is_orphan: 0, created_at: now };
}

/**
 * Stop monitoring a process by PM2 name.
 *
 * @param {string} pm2Name
 */
export function removeMonitored(pm2Name) {
  getDb().prepare('DELETE FROM monitored_processes WHERE pm2_name = ?').run(pm2Name);
}

/**
 * Return the monitoring record for a given PM2 name, or `undefined` if not found.
 *
 * @param {string} pm2Name
 * @returns {{ id: string, pm2_name: string, is_orphan: number, created_at: number } | undefined}
 */
export function getByPm2Name(pm2Name) {
  return getDb().prepare('SELECT * FROM monitored_processes WHERE pm2_name = ?').get(pm2Name);
}

/**
 * Reconcile the `is_orphan` flag based on the current active PM2 process names.
 *
 * Processes that are in the database but absent from `activeNames` are marked
 * as orphaned; processes that reappear are un-orphaned.
 *
 * @param {string[]} activeNames - PM2 process names currently visible.
 */
export function reconcileOrphans(activeNames) {
  const db = getDb();
  const all = db.prepare('SELECT id, pm2_name FROM monitored_processes').all();
  const activeSet = new Set(activeNames);

  const markOrphan = db.prepare('UPDATE monitored_processes SET is_orphan = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of all) {
      const shouldBeOrphan = activeSet.has(row.pm2_name) ? 0 : 1;
      markOrphan.run(shouldBeOrphan, row.id);
    }
  })();
}

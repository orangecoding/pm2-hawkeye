/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for deployment records.
 *
 * All functions operate on the shared database handle obtained from `getDb()`.
 * JSON blob columns (`env_vars`, `pm2_options`) are transparently serialised on
 * write and deserialised on read.
 */

import crypto from 'node:crypto';
import { getDb } from './db.js';

/** Fallback poll interval (minutes) when a caller does not supply one. */
export const DEFAULT_WATCH_INTERVAL_MINUTES = 5;

/**
 * Parse JSON blob columns on a raw DB row.
 *
 * @param {object} row - Raw SQLite row.
 * @returns {object} Row with `env_vars` and `pm2_options` parsed.
 */
function parseRow(row) {
  if (!row) return row;
  return {
    ...row,
    env_vars: JSON.parse(row.env_vars || '{}'),
    pm2_options: JSON.parse(row.pm2_options || '{}'),
  };
}

/**
 * Create a new deployment record.
 *
 * @param {{
 *   pm2Name: string,
 *   repoUrl: string,
 *   branch: string,
 *   deployPath: string,
 *   startScript: string,
 *   installCmd: string,
 *   buildCmd: string | null,
 *   preSetupScript: string | null,
 *   postSetupScript: string | null,
 *   envVars: object,
 *   pm2Options: object,
 *   watchEnabled?: boolean,
 *   watchIntervalMinutes?: number,
 * }} opts
 * @returns {{ id: string, pm2_name: string, created_at: number }}
 */
export function createDeployment(opts) {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO deployments
        (id, pm2_name, repo_url, branch, deploy_path, start_script,
         install_cmd, build_cmd, pre_setup_script, post_setup_script,
         env_vars, pm2_options, watch_enabled, watch_interval_minutes,
         deploying, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      opts.pm2Name,
      opts.repoUrl,
      opts.branch,
      opts.deployPath,
      opts.startScript,
      opts.installCmd,
      opts.buildCmd ?? null,
      opts.preSetupScript ?? null,
      opts.postSetupScript ?? null,
      JSON.stringify(opts.envVars ?? {}),
      JSON.stringify(opts.pm2Options ?? {}),
      opts.watchEnabled ? 1 : 0,
      opts.watchIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES,
      now,
    );
  return { id, pm2_name: opts.pm2Name, created_at: now };
}

/**
 * Return the deployment record for a given PM2 name, or `undefined` if not found.
 *
 * @param {string} pm2Name
 * @returns {object | undefined}
 */
export function getDeploymentByName(pm2Name) {
  return parseRow(getDb().prepare('SELECT * FROM deployments WHERE pm2_name = ?').get(pm2Name));
}

/**
 * Return the deployment record for a given UUID, or `undefined` if not found.
 *
 * @param {string} id
 * @returns {object | undefined}
 */
export function getDeploymentById(id) {
  return parseRow(getDb().prepare('SELECT * FROM deployments WHERE id = ?').get(id));
}

/**
 * Return all deployment records ordered by creation date descending.
 *
 * @returns {object[]}
 */
export function getAllDeployments() {
  return getDb().prepare('SELECT * FROM deployments ORDER BY created_at DESC').all().map(parseRow);
}

/**
 * Set the `deploying` flag on a deployment record.
 *
 * @param {string} id
 * @param {boolean} deploying
 */
export function setDeploying(id, deploying) {
  getDb()
    .prepare('UPDATE deployments SET deploying = ? WHERE id = ?')
    .run(deploying ? 1 : 0, id);
}

/**
 * Update the `last_deployed_at` timestamp to the current time.
 *
 * @param {string} id
 */
export function updateLastDeployed(id) {
  getDb().prepare('UPDATE deployments SET last_deployed_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Update an existing deployment record.
 *
 * Replaces all editable fields in one shot. `id`, `created_at`, `deploying`,
 * and `last_deployed_at` are never touched by this function.
 *
 * @param {string} id
 * @param {{
 *   repoUrl: string,
 *   branch: string,
 *   startScript: string,
 *   installCmd: string,
 *   buildCmd: string | null,
 *   preSetupScript: string | null,
 *   postSetupScript: string | null,
 *   envVars: object,
 *   pm2Options: object,
 *   watchEnabled?: boolean,
 *   watchIntervalMinutes?: number,
 * }} opts
 */
export function updateDeployment(id, opts) {
  getDb()
    .prepare(
      `UPDATE deployments SET
        repo_url          = ?,
        branch            = ?,
        start_script      = ?,
        install_cmd       = ?,
        build_cmd         = ?,
        pre_setup_script  = ?,
        post_setup_script = ?,
        env_vars          = ?,
        pm2_options       = ?,
        watch_enabled     = ?,
        watch_interval_minutes = ?
       WHERE id = ?`,
    )
    .run(
      opts.repoUrl,
      opts.branch,
      opts.startScript,
      opts.installCmd,
      opts.buildCmd || null,
      opts.preSetupScript || null,
      opts.postSetupScript || null,
      JSON.stringify(opts.envVars ?? {}),
      JSON.stringify(opts.pm2Options ?? {}),
      opts.watchEnabled ? 1 : 0,
      opts.watchIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES,
      id,
    );
}

/**
 * Return all deployment records that have branch watching enabled.
 *
 * @returns {object[]}
 */
export function getWatchedDeployments() {
  return getDb().prepare('SELECT * FROM deployments WHERE watch_enabled = 1').all().map(parseRow);
}

/**
 * Update the branch-watcher bookkeeping columns of a deployment.
 *
 * All three fields are written on every call so a successful poll clears the
 * error text left behind by a previous failure.
 *
 * @param {string} id
 * @param {{ lastCheckedAt: number, lastCommit: string | null, lastError: string | null }} state
 */
export function updateWatchState(id, { lastCheckedAt, lastCommit, lastError }) {
  getDb()
    .prepare(
      `UPDATE deployments SET
        watch_last_checked_at = ?,
        watch_last_commit     = ?,
        watch_last_error      = ?
       WHERE id = ?`,
    )
    .run(lastCheckedAt, lastCommit ?? null, lastError ?? null, id);
}

/**
 * Delete a deployment record by UUID.
 *
 * @param {string} id
 */
export function deleteDeployment(id) {
  getDb().prepare('DELETE FROM deployments WHERE id = ?').run(id);
}

/**
 * Clear the `deploying` flag on every deployment record.
 *
 * Called at server startup so that any deployment that was interrupted by a
 * crash or restart does not remain permanently stuck in the "in progress" state.
 *
 * @returns {number} Number of records that were reset.
 */
export function resetAllDeployingFlags() {
  const result = getDb().prepare('UPDATE deployments SET deploying = 0 WHERE deploying = 1').run();
  return result.changes;
}

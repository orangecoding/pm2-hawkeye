/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Process operations shared by the HTTP API and the MCP server.
 *
 * Each function resolves its target itself and answers with a plain result
 * object instead of throwing for expected failures, so both transports map
 * the same outcome onto their own error format (HTTP status, MCP error text).
 */

import fs from 'node:fs';
import * as pm2 from './pm2Service.js';
import { backfillLogs } from './logBackfill.js';
import logger from './logger.js';
import { getDeploymentByName, deleteDeployment } from '../storage/deploymentStorage.js';
import { isMonitored, addMonitored, removeMonitored, getByPm2Name } from '../storage/monitoringStorage.js';
import { getMetrics, getCustomMetrics } from '../storage/metricsStorage.js';
import { getLogEntries } from '../storage/logStorage.js';

/** Maximum number of stored log entries returned by one page. */
export const MAX_LOG_PAGE_SIZE = 500;

/**
 * @typedef {Object} Actor
 * @property {string} name - Who acts, as it appears in the audit log, e.g. `User: admin` or `MCP`.
 * @property {string} identity - Client identity of the request (see `getClientIdentity`).
 */

/**
 * Resolve a process id or name to its PM2 name.
 *
 * Falls back to the given value when PM2 does not run such a process (an
 * orphan is addressed by its name) or PM2 cannot be reached, so the stored
 * history of a process stays readable after it is gone.
 *
 * @param {string|number} id - pm_id or name.
 * @returns {Promise<string>}
 */
export async function resolvePm2Name(id) {
  const proc = await pm2.findProcess(id).catch(() => null);
  return proc?.name ?? String(id);
}

/**
 * Delete a process from PM2 and optionally purge its deployment.
 *
 * With `deleteDeploy` every instance with the same name is deleted, since the
 * other cluster workers would run from a removed directory, and the
 * deployment record plus its directory on disk go too. The monitoring record
 * (keyed by name) is removed only once no instance with that name is left, so
 * deleting one cluster worker keeps the app monitored.
 *
 * @param {string|number} id - pm_id or name.
 * @param {{ deleteDeploy?: boolean, actor: Actor }} opts
 * @returns {Promise<{ ok: true, pm2Name: string } | { ok: false, status: number, error: string }>}
 */
export async function removeProcess(id, { deleteDeploy = false, actor }) {
  const proc = await pm2.findProcess(id);
  if (!proc) {
    return { ok: false, status: 404, error: 'Process not found' };
  }
  const pm2Name = proc.name;
  const deployment = deleteDeploy ? getDeploymentByName(pm2Name) : null;
  if (deployment?.deploying) {
    return { ok: false, status: 409, error: 'Cannot delete a deployment that is currently in progress.' };
  }

  const targets = deleteDeploy
    ? (await pm2.loadProcessList()).filter((p) => p.name === pm2Name).map((p) => p.pm_id)
    : [proc.pm_id];

  logger.info(
    `[ACTION] ${actor.name} is deleting process: ${pm2Name} (pm_id ${targets.join(', ')}) from identity: ${actor.identity}`,
  );
  for (const pmId of targets) {
    await pm2.deleteProcess(pmId);
  }

  const stillRunning = (await pm2.loadProcessList()).some((p) => p.name === pm2Name);
  if (!stillRunning) {
    removeMonitored(pm2Name);
  }

  if (deployment) {
    try {
      await fs.promises.rm(deployment.deploy_path, { recursive: true, force: true });
      logger.info(`[ACTION] Deleted deploy directory: ${deployment.deploy_path}`);
    } catch (rmErr) {
      logger.warn(`[ACTION] Could not delete deploy directory ${deployment.deploy_path}: ${rmErr.message}`);
    }
    deleteDeployment(deployment.id);
    logger.info(`[ACTION] Deleted deployment record for: ${pm2Name}`);
  }

  return { ok: true, pm2Name };
}

/**
 * Turn monitoring (stored logs and metrics) on or off for a process name.
 *
 * Turning it on backfills the existing log files in the background.
 *
 * @param {string} pm2Name
 * @param {boolean} monitored
 * @returns {{ pm2Name: string, isMonitored: boolean }}
 */
export function setMonitoring(pm2Name, monitored) {
  if (monitored) {
    if (!isMonitored(pm2Name)) {
      const newRow = addMonitored(pm2Name);
      // Fire-and-forget: the backfill can take a while for large log files.
      backfillLogs(pm2Name, newRow.id);
    }
  } else {
    removeMonitored(pm2Name);
  }
  return { pm2Name, isMonitored: monitored };
}

/**
 * Read the stored metric history of a monitored process: CPU/memory
 * `samples` and, under `custom`, one series per application metric. Both are
 * empty when the process is not monitored.
 *
 * @param {string|number} id - pm_id or name.
 * @returns {Promise<{ pm2Name: string, samples: object[], custom: object[] }>}
 */
export async function getMetricsHistory(id) {
  const pm2Name = await resolvePm2Name(id);
  const row = getByPm2Name(pm2Name);
  if (!row) {
    return { pm2Name, samples: [], custom: [] };
  }
  return { pm2Name, samples: getMetrics(row.id), custom: getCustomMetrics(row.id) };
}

/**
 * Read one page of stored log entries of a monitored process, newest first.
 *
 * @param {string|number} id - pm_id or name.
 * @param {{ limit: number, before?: number, beforeId?: number, levels?: string[] }} page - Already validated.
 * @returns {Promise<{ pm2Name: string, isMonitored: boolean, entries: object[], nextCursor: { before: number, beforeId: number } | null }>}
 */
export async function getStoredLogPage(id, page) {
  const pm2Name = await resolvePm2Name(id);
  const row = getByPm2Name(pm2Name);
  if (!row) {
    return { pm2Name, isMonitored: false, entries: [], nextCursor: null };
  }
  // One extra row tells whether another page exists.
  const fetched = getLogEntries(row.id, { ...page, limit: page.limit + 1 });
  const hasMore = fetched.length > page.limit;
  const entries = hasMore ? fetched.slice(0, page.limit) : fetched;
  const last = entries.at(-1);
  const nextCursor = hasMore && last ? { before: last.logged_at, beforeId: last.id } : null;
  return { pm2Name, isMonitored: true, entries, nextCursor };
}

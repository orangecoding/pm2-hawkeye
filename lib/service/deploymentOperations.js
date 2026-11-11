/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Deployment operations shared by the HTTP API and the MCP server.
 *
 * Validation lives here, at the trust boundary both transports cross, and
 * every function answers with a plain result object (`{ ok: false, status,
 * error }` for expected failures) that each transport maps onto its own
 * error format.
 */

import {
  validateAppName,
  validateRepoUrl,
  validateBranch,
  resolveDeployPath,
  runDeploy,
  resolveConfirmation,
} from './deployRunner.js';
import {
  createDeployment,
  updateDeployment,
  getDeploymentByName,
  getDeploymentById,
  deleteDeployment,
  DEFAULT_WATCH_INTERVAL_MINUTES,
} from '../storage/deploymentStorage.js';
import logger from './logger.js';

/** Upper bound for the branch-watch poll interval (24 hours, in minutes). */
const MAX_WATCH_INTERVAL_MINUTES = 1440;

/**
 * @typedef {{ ok: false, status: number, error: string }} OperationError
 */

/** True for a non-null object that is not an array. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalise the branch-watching fields of a deployment request body.
 *
 * @param {object} body - Parsed request body.
 * @returns {{ ok: true, watchEnabled: boolean, watchIntervalMinutes: number } | { ok: false, error: string }}
 */
function parseWatchFields(body) {
  const minutes = Number(body.watchIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WATCH_INTERVAL_MINUTES) {
    return {
      ok: false,
      error: `Invalid watch interval. Use a whole number of minutes between 1 and ${MAX_WATCH_INTERVAL_MINUTES}.`,
    };
  }
  return { ok: true, watchEnabled: body.watchEnabled === true, watchIntervalMinutes: minutes };
}

/**
 * Validate and normalise the editable fields of a deployment, shared by
 * create and update.
 *
 * Every field that later reaches git, a shell or PM2 is type-checked here:
 * the branch in particular is passed to `git fetch origin <branch>` as an
 * argument, so a value starting with `-` would be read as an option.
 *
 * @param {object} body - Deployment fields in camelCase.
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
export function parseDeploymentFields(body) {
  const {
    repoUrl,
    branch = 'master',
    startScript = 'index.js',
    installCmd = 'npm install',
    buildCmd = '',
    preSetupScript = '',
    postSetupScript = '',
    envVars = {},
    pm2Options = {},
  } = body;

  if (!validateRepoUrl(repoUrl)) {
    return {
      ok: false,
      error:
        'Invalid repo URL. Accepted: HTTPS GitHub/GitLab URLs or SSH git URLs (e.g. git@github.com:user/repo.git).',
    };
  }
  if (!validateBranch(branch)) {
    return { ok: false, error: 'Invalid branch name.' };
  }
  if (typeof startScript !== 'string' || !startScript.trim()) {
    return { ok: false, error: 'Start script must be a non-empty string.' };
  }
  if (typeof installCmd !== 'string' || !installCmd.trim()) {
    return { ok: false, error: 'Install command must be a non-empty string.' };
  }
  for (const [label, value] of [
    ['Build command', buildCmd],
    ['Pre-setup script', preSetupScript],
    ['Post-setup script', postSetupScript],
  ]) {
    if (value !== null && typeof value !== 'string') {
      return { ok: false, error: `${label} must be a string.` };
    }
  }
  if (!isPlainObject(envVars) || !Object.values(envVars).every((v) => typeof v === 'string')) {
    return { ok: false, error: 'Environment variables must be an object of strings.' };
  }
  if (!isPlainObject(pm2Options)) {
    return { ok: false, error: 'PM2 options must be an object.' };
  }

  const watch = parseWatchFields(body);
  if (!watch.ok) {
    return { ok: false, error: watch.error };
  }

  return {
    ok: true,
    fields: {
      repoUrl,
      branch,
      startScript: startScript.trim(),
      installCmd: installCmd.trim(),
      buildCmd: buildCmd || null,
      preSetupScript: preSetupScript || null,
      postSetupScript: postSetupScript || null,
      envVars,
      pm2Options,
      watchEnabled: watch.watchEnabled,
      watchIntervalMinutes: watch.watchIntervalMinutes,
      discardLocalChanges: body.discardLocalChanges === true,
    },
  };
}

/**
 * Map a stored deployment record onto the camelCase fields
 * `parseDeploymentFields` accepts, so a partial update can be merged over
 * the current values and validated as a whole.
 *
 * @param {object} record - Deployment record from deploymentStorage.
 * @returns {object}
 */
export function deploymentToFields(record) {
  return {
    repoUrl: record.repo_url,
    branch: record.branch,
    startScript: record.start_script,
    installCmd: record.install_cmd,
    buildCmd: record.build_cmd ?? '',
    preSetupScript: record.pre_setup_script ?? '',
    postSetupScript: record.post_setup_script ?? '',
    envVars: record.env_vars ?? {},
    pm2Options: record.pm2_options ?? {},
    watchEnabled: record.watch_enabled === 1,
    watchIntervalMinutes: record.watch_interval_minutes,
    discardLocalChanges: record.discard_local_changes === 1,
  };
}

/**
 * Create a deployment record and start its first deploy in the background.
 * Progress streams over the WebSocket and into the run log of `deployRunner`.
 *
 * @param {object} body - `appName` plus the deployment fields in camelCase.
 * @returns {{ ok: true, deploymentId: string } | OperationError}
 */
export function startDeployment(body) {
  const { appName } = body;
  if (!validateAppName(appName)) {
    return {
      ok: false,
      status: 400,
      error:
        'Invalid app name. Use alphanumeric characters, dashes, and underscores (max 64 chars), not only digits and not "all".',
    };
  }

  const parsed = parseDeploymentFields(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  let deployPath;
  try {
    deployPath = resolveDeployPath(appName);
  } catch {
    return { ok: false, status: 400, error: 'Deploy path would escape the base directory.' };
  }

  if (getDeploymentByName(appName)) {
    return {
      ok: false,
      status: 409,
      error: `A deployment named "${appName}" already exists. Use the redeploy endpoint to update it.`,
    };
  }

  const record = createDeployment({ pm2Name: appName, deployPath, ...parsed.fields });

  // Fire-and-forget: runDeploy never throws, it reports through its run log.
  runDeploy(getDeploymentById(record.id), { isRedeploy: false }).catch(() => {});

  logger.info(`[DEPLOY] Started deployment for "${appName}" from ${parsed.fields.repoUrl}`);
  return { ok: true, deploymentId: record.id };
}

/**
 * Replace the editable fields of a deployment. Does not redeploy; changes
 * take effect on the next deploy, which also follows a changed repository
 * URL or branch.
 *
 * @param {string} id - Deployment id.
 * @param {object} body - Deployment fields in camelCase.
 * @returns {{ ok: true, deployment: object } | OperationError}
 */
export function editDeployment(id, body) {
  const deployment = getDeploymentById(id);
  if (!deployment) {
    return { ok: false, status: 404, error: 'Deployment not found.' };
  }
  if (deployment.deploying) {
    return { ok: false, status: 409, error: 'Cannot edit a deployment that is currently in progress.' };
  }

  const parsed = parseDeploymentFields(body);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error };
  }

  updateDeployment(id, parsed.fields);
  logger.info(`[DEPLOY] Updated deployment record for "${deployment.pm2_name}"`);
  return { ok: true, deployment: getDeploymentById(id) };
}

/**
 * Start a redeploy (fetch, install, build, restart) in the background.
 *
 * @param {string} id - Deployment id.
 * @param {{ autoConfirm?: boolean }} [opts] - `autoConfirm` discards tracked
 *   local changes instead of waiting for someone to confirm it.
 * @returns {{ ok: true, deploymentId: string } | OperationError}
 */
export function startRedeploy(id, { autoConfirm = false } = {}) {
  const deployment = getDeploymentById(id);
  if (!deployment) {
    return { ok: false, status: 404, error: 'Deployment not found.' };
  }
  if (deployment.deploying) {
    return { ok: false, status: 409, error: 'A deployment is already in progress for this app.' };
  }

  runDeploy(deployment, { isRedeploy: true, autoConfirm }).catch(() => {});

  logger.info(`[DEPLOY] Started redeploy for "${deployment.pm2_name}"`);
  return { ok: true, deploymentId: deployment.id };
}

/**
 * Answer the pending local-changes question of a running deploy.
 *
 * @param {string} id - Deployment id.
 * @param {boolean} confirmed - True discards the changes and continues, false cancels.
 * @returns {{ ok: true } | OperationError}
 */
export function confirmDeployment(id, confirmed) {
  if (!resolveConfirmation(id, confirmed)) {
    return { ok: false, status: 409, error: 'No confirmation is pending for this deployment. It may have timed out.' };
  }
  logger.info(`[DEPLOY] Confirmation ${confirmed ? 'accepted' : 'rejected'} for deployment "${id}"`);
  return { ok: true };
}

/**
 * Delete a deployment record. The PM2 process and the directory on disk stay.
 *
 * @param {string} id - Deployment id.
 * @returns {{ ok: true } | OperationError}
 */
export function removeDeployment(id) {
  const deployment = getDeploymentById(id);
  if (!deployment) {
    return { ok: false, status: 404, error: 'Deployment not found.' };
  }
  if (deployment.deploying) {
    return { ok: false, status: 409, error: 'Cannot delete a deployment that is currently in progress.' };
  }
  deleteDeployment(id);
  logger.info(`[DEPLOY] Deleted deployment record for "${deployment.pm2_name}"`);
  return { ok: true };
}

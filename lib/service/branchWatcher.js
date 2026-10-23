/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Branch watcher.
 *
 * Polls the remote branch of every deployment that has branch watching enabled
 * and runs the regular redeploy pipeline whenever the branch has moved ahead of
 * what is checked out on disk.  The cron ticks once a minute; each deployment's
 * own `watch_interval_minutes` decides whether it is actually due.
 *
 * Git is invoked with credential prompts disabled so a repository the server
 * cannot authenticate against fails fast instead of hanging a background poll.
 */

import fs from 'node:fs';
import { Cron } from 'croner';
import { captureCommand, runDeploy } from './deployRunner.js';
import { dispatchDeployNotification } from './alertingService.js';
import {
  DEFAULT_WATCH_INTERVAL_MINUTES,
  getDeploymentById,
  getWatchedDeployments,
  updateWatchState,
} from '../storage/deploymentStorage.js';
import logger from './logger.js';

// Constants ────────────────────────────────────────────────────────────────

/** Cron expression for the poll tick. Per-deployment intervals gate the work. */
const POLL_CRON = '* * * * *';

/** Hard kill timeout for a single git invocation. */
const GIT_TIMEOUT_MS = 20_000;

// Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the SSH command git would use, following git's own precedence:
 * `GIT_SSH_COMMAND`, then `core.sshCommand`, then plain `ssh`.
 *
 * Without this, {@link gitEnv} would override a `core.sshCommand` that points
 * at a deploy key, and polls of such repositories would fail to authenticate.
 *
 * @param {string} [cwd] - Repository whose config is read as well, if it exists.
 * @returns {Promise<string>}
 */
async function resolveSshCommand(cwd) {
  if (process.env.GIT_SSH_COMMAND) return process.env.GIT_SSH_COMMAND;
  try {
    const configured = await captureCommand('git', ['config', '--get', 'core.sshCommand'], cwd, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (configured.trim()) return configured.trim();
  } catch {
    // Exit code 1 means the key is not set; a missing cwd lands here too.
  }
  return 'ssh';
}

/**
 * Environment for background git calls that talk to the remote.
 *
 * `GIT_TERMINAL_PROMPT=0` makes HTTPS remotes fail instead of asking for
 * credentials, and `BatchMode=yes` does the same for SSH remotes whose key
 * would otherwise trigger a passphrase prompt.
 *
 * @param {string} [cwd] - Repository whose `core.sshCommand` is honoured.
 * @returns {Promise<NodeJS.ProcessEnv>}
 */
async function gitEnv(cwd) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `${await resolveSshCommand(cwd)} -o BatchMode=yes`,
  };
}

/**
 * Extract the commit SHA from `git ls-remote` output.
 *
 * @param {string} output - Raw command output.
 * @returns {string | null} Lower-case 40-character SHA, or null if absent.
 */
export function parseLsRemote(output) {
  const line = String(output || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
  if (!line) return null;
  const sha = line.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}

/**
 * Return true when a deployment's poll interval has elapsed.
 *
 * @param {object} deployment - Deployment record.
 * @param {number} now - Current timestamp in ms.
 * @returns {boolean}
 */
export function isDue(deployment, now) {
  const last = deployment.watch_last_checked_at;
  if (last == null) return true;
  const minutes =
    deployment.watch_interval_minutes > 0 ? deployment.watch_interval_minutes : DEFAULT_WATCH_INTERVAL_MINUTES;
  return now - last >= minutes * 60_000;
}

/**
 * Decide whether the remote branch warrants a redeploy.
 *
 * The `lastCommit` comparison is a loop guard: when a deploy of the remote SHA
 * already ran but the local HEAD did not end up on it (the fetch failed, the
 * directory was replaced), every single poll would otherwise trigger another
 * deployment.
 *
 * @param {{ remote: string | null, local: string | null, lastCommit: string | null }} state
 * @returns {boolean}
 */
export function needsDeploy({ remote, local, lastCommit }) {
  if (!remote) return false;
  if (local && remote === local) return false;
  if (lastCommit && remote === lastCommit) return false;
  return true;
}

/**
 * Read the head commit of a branch on the remote.
 *
 * @param {string} repoUrl - Repository URL as stored on the deployment.
 * @param {string} branch - Branch name.
 * @param {string} deployPath - Local clone, used for its git config when present.
 * @returns {Promise<string | null>} SHA, or null when the branch does not exist.
 */
async function getRemoteHeadCommit(repoUrl, branch, deployPath) {
  const cwd = fs.existsSync(deployPath) ? deployPath : undefined;
  const output = await captureCommand('git', ['ls-remote', repoUrl, `refs/heads/${branch}`], cwd, {
    timeoutMs: GIT_TIMEOUT_MS,
    env: await gitEnv(cwd),
  });
  return parseLsRemote(output);
}

/**
 * Read the head commit of the working copy on disk.
 *
 * @param {string} deployPath - Absolute path of the cloned repository.
 * @returns {Promise<string | null>} SHA, or null when the path is not a repo.
 */
async function getLocalHeadCommit(deployPath) {
  try {
    const output = await captureCommand('git', ['-C', deployPath, 'rev-parse', 'HEAD'], undefined, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const sha = output.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    // A missing or broken working copy is not an error here - the deploy runner
    // falls back to a fresh clone on its own.
    return null;
  }
}

// Poll ─────────────────────────────────────────────────────────────────────

/**
 * Poll one deployment and redeploy it if its branch moved ahead.
 *
 * Never throws: a failure is recorded in `watch_last_error` so it shows up in
 * the UI, and the remaining deployments keep being polled.
 *
 * @param {object} deployment - Deployment record with watching enabled.
 * @returns {Promise<void>}
 */
async function checkDeployment(deployment) {
  const { id, pm2_name, repo_url, branch, deploy_path } = deployment;

  try {
    const remote = await getRemoteHeadCommit(repo_url, branch, deploy_path);
    if (!remote) {
      const message = `Branch "${branch}" does not exist on ${repo_url}`;
      logger.warn(`[WATCH] ${pm2_name}: ${message}`);
      updateWatchState(id, {
        lastCheckedAt: Date.now(),
        lastCommit: deployment.watch_last_commit,
        lastError: message,
      });
      return;
    }

    const local = await getLocalHeadCommit(deploy_path);
    if (!needsDeploy({ remote, local, lastCommit: deployment.watch_last_commit })) {
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit: deployment.watch_last_commit, lastError: null });
      return;
    }

    // Re-read the record: a manual deploy may have started while this cycle was
    // waiting on git.
    const fresh = getDeploymentById(id);
    if (!fresh || fresh.deploying) {
      // A manual deploy took over. Record the poll so this deployment waits for
      // its next interval instead of re-polling on every tick.
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit: deployment.watch_last_commit, lastError: null });
      return;
    }

    // Record the SHA before deploying so a failing deployment waits for the next
    // commit instead of retrying on every tick.
    updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit: remote, lastError: null });

    const short = remote.slice(0, 7);
    logger.info(`[WATCH] ${pm2_name}: new commit ${short} on ${branch} - starting auto-deploy.`);

    const result = await runDeploy(fresh, { isRedeploy: true, autoConfirm: true });

    if (result.ok) {
      await dispatchDeployNotification(pm2_name, 'info', `Auto-deployed ${pm2_name} from ${branch} at ${short}.`);
    } else {
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit: remote, lastError: result.error });
      await dispatchDeployNotification(
        pm2_name,
        'error',
        `Auto-deploy of ${pm2_name} from ${branch} at ${short} failed: ${result.error}`,
      );
    }
  } catch (err) {
    logger.warn(`[WATCH] ${pm2_name}: poll failed: ${err.message}`);
    updateWatchState(id, {
      lastCheckedAt: Date.now(),
      lastCommit: deployment.watch_last_commit,
      lastError: err.message,
    });
  }
}

/**
 * Run one full poll cycle over all watched deployments.
 *
 * Deployments are processed sequentially so a server with many watched apps
 * never spawns a burst of concurrent git processes.
 *
 * @returns {Promise<void>}
 */
export async function runWatchCycle() {
  let watched;
  try {
    watched = getWatchedDeployments();
  } catch (err) {
    logger.warn(`[WATCH] Could not read watched deployments: ${err.message}`);
    return;
  }

  const now = Date.now();
  for (const deployment of watched) {
    if (deployment.deploying) continue;
    if (!isDue(deployment, now)) continue;
    await checkDeployment(deployment);
  }
}

// Scheduler ────────────────────────────────────────────────────────────────

/**
 * Start the background branch-watching cron job.
 * The job's timer is unreferenced (`unref`) so it never prevents the process
 * from exiting, and
 * `protect` keeps a slow cycle from overlapping with the next tick.
 */
export function startBranchWatcher() {
  new Cron(POLL_CRON, { name: 'branch-watcher', protect: true, unref: true }, runWatchCycle);

  logger.debug(`[WATCH] Branch watcher scheduled (${POLL_CRON}).`);
}

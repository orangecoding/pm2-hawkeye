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

/** Longest pause between two attempts at a commit whose auto-deploy failed. */
const MAX_RETRY_DELAY_MINUTES = 60;

/**
 * Auto-deploys that failed, keyed by deployment id. The same commit is tried
 * again with growing pauses until it deploys, a newer commit arrives or a
 * deploy succeeds some other way. Kept in memory only: after a restart the
 * commit is simply tried once more, because it never counted as deployed.
 *
 * @type {Map<string, { commit: string, attempts: number, failedAt: number, retryAt: number }>}
 */
const failedDeploys = new Map();

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
 * Poll interval of a deployment in minutes, with the default for a value
 * that makes no sense.
 *
 * @param {object} deployment - Deployment record.
 * @returns {number}
 */
function pollIntervalMinutes(deployment) {
  return deployment.watch_interval_minutes > 0 ? deployment.watch_interval_minutes : DEFAULT_WATCH_INTERVAL_MINUTES;
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
  return now - last >= pollIntervalMinutes(deployment) * 60_000;
}

/**
 * Pause before the next attempt at a commit whose auto-deploy failed.
 *
 * Starts at the poll interval and doubles with every failed attempt, so a
 * short network outage is bridged quickly while a deploy that keeps failing
 * runs at most once an hour.
 *
 * @param {number} intervalMinutes - Poll interval of the deployment.
 * @param {number} attempts - Failed attempts at the commit so far, at least 1.
 * @returns {number} Milliseconds.
 */
export function retryDelayMs(intervalMinutes, attempts) {
  return Math.min(intervalMinutes * 2 ** (attempts - 1), MAX_RETRY_DELAY_MINUTES) * 60_000;
}

/**
 * Decide whether the remote branch warrants a deploy.
 *
 * A commit whose deploy failed is tried again once its retry is due, even when
 * the working copy is already on it: an install that failed on a registry
 * outage happens after the checkout.
 *
 * Otherwise the `lastCommit` comparison is a loop guard: when the commit was
 * already deployed but the local HEAD is no longer on it (the directory was
 * replaced), every single poll would trigger another deployment.
 *
 * @param {{
 *   remote: string | null,
 *   local: string | null,
 *   lastCommit: string | null,
 *   failure?: { commit: string, retryAt: number } | null,
 *   now?: number,
 * }} state - `lastCommit` is the commit the watcher last deployed successfully,
 *   `failure` the pending retry of a failed one.
 * @returns {boolean}
 */
export function needsDeploy({ remote, local, lastCommit, failure = null, now = Date.now() }) {
  if (!remote) return false;
  if (failure?.commit === remote) return now >= failure.retryAt;
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
 * Poll one deployment and deploy its branch head if the branch moved ahead.
 *
 * A commit counts as deployed (`watch_last_commit`) only once its deploy
 * succeeded. A failed deploy is tried again with growing pauses (see
 * {@link retryDelayMs}), its error stays in `watch_last_error` until the
 * failure is settled, and only the first failure of a commit sends an alert.
 *
 * Never throws: a failure is recorded in `watch_last_error` so it shows up in
 * the UI, and the remaining deployments keep being polled.
 *
 * @param {object} deployment - Deployment record with watching enabled.
 * @param {number} [now] - Time a pending retry is compared against.
 * @returns {Promise<void>}
 */
export async function checkDeployment(deployment, now = Date.now()) {
  const { id, pm2_name, repo_url, branch, deploy_path, watch_last_commit: lastCommit } = deployment;

  try {
    const remote = await getRemoteHeadCommit(repo_url, branch, deploy_path);
    if (!remote) {
      const message = `Branch "${branch}" does not exist on ${repo_url}`;
      logger.warn(`[WATCH] ${pm2_name}: ${message}`);
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit, lastError: message });
      return;
    }

    // A newer commit replaces a failed one, and a deploy that succeeded since
    // the failure (a manual one, say) settles it.
    let failure = failedDeploys.get(id) ?? null;
    if (failure && (failure.commit !== remote || deployment.last_deployed_at > failure.failedAt)) {
      failedDeploys.delete(id);
      failure = null;
    }
    // The error of a failed deploy stays on screen while its retries go on;
    // any other error is cleared by a poll that worked.
    const openError = failure ? deployment.watch_last_error : null;

    const local = await getLocalHeadCommit(deploy_path);
    if (!needsDeploy({ remote, local, lastCommit, failure, now })) {
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit, lastError: openError });
      return;
    }

    // Re-read the record: a manual deploy may have started while this cycle was
    // waiting on git.
    const fresh = getDeploymentById(id);
    if (!fresh || fresh.deploying) {
      // A manual deploy took over. Record the poll so this deployment waits for
      // its next interval instead of re-polling on every tick.
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit, lastError: openError });
      return;
    }

    // Record the poll before deploying. The commit itself is recorded only
    // after the deploy succeeded, so a failed one is tried again.
    updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit, lastError: openError });

    const short = remote.slice(0, 7);
    const attempt = (failure?.attempts ?? 0) + 1;
    logger.info(
      attempt === 1
        ? `[WATCH] ${pm2_name}: new commit ${short} on ${branch} - starting auto-deploy.`
        : `[WATCH] ${pm2_name}: retrying ${short} on ${branch} (attempt ${attempt}) - starting auto-deploy.`,
    );

    const result = await runDeploy(fresh, { isRedeploy: true, autoConfirm: true });

    if (result.ok) {
      failedDeploys.delete(id);
      updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit: remote, lastError: null });
      await dispatchDeployNotification(pm2_name, 'info', `Auto-deployed ${pm2_name} from ${branch} at ${short}.`);
      return;
    }

    const failedAt = Date.now();
    const delayMinutes = retryDelayMs(pollIntervalMinutes(deployment), attempt) / 60_000;
    failedDeploys.set(id, { commit: remote, attempts: attempt, failedAt, retryAt: failedAt + delayMinutes * 60_000 });
    updateWatchState(id, {
      lastCheckedAt: failedAt,
      lastCommit,
      lastError: `Deploying ${short} failed, next try in ${delayMinutes} min: ${result.error}`,
    });
    logger.warn(
      `[WATCH] ${pm2_name}: auto-deploy of ${short} failed (attempt ${attempt}), next try in ${delayMinutes} min.`,
    );

    // One alert per commit; the retries only update the error shown in the UI.
    if (attempt === 1) {
      await dispatchDeployNotification(
        pm2_name,
        'error',
        `Auto-deploy of ${pm2_name} from ${branch} at ${short} failed: ${result.error}. ` +
          `Hawkeye tries again in ${delayMinutes} min, with growing pauses, until it works or a new commit arrives.`,
      );
    }
  } catch (err) {
    logger.warn(`[WATCH] ${pm2_name}: poll failed: ${err.message}`);
    updateWatchState(id, { lastCheckedAt: Date.now(), lastCommit, lastError: err.message });
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

  // Forget the failures of deployments that were deleted or stopped watching.
  for (const id of failedDeploys.keys()) {
    if (!watched.some((deployment) => deployment.id === id)) failedDeploys.delete(id);
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

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Deployment runner.
 *
 * Orchestrates the full lifecycle of a deployment:
 *   pre_setup -> clone/pull -> install -> build -> post_setup -> pm2 start/restart
 *
 * All shell commands are spawned with argument arrays (never interpolated into
 * shell strings) to prevent injection.  Progress is streamed in real-time via
 * the WebSocket broadcast helper.
 */

import { spawn } from 'node:child_process';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import config from '../config.js';
import { setDeploying, updateLastDeployed } from '../storage/deploymentStorage.js';
import * as pm2 from './pm2Service.js';
import { broadcastDeployProgress } from '../transport/ws.js';
import logger from './logger.js';

// Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a PM2 app name: alphanumeric, dashes and underscores only.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function validateAppName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/**
 * Validate a repository URL.
 *
 * Accepted forms:
 *   - HTTPS: github.com or gitlab.com only (e.g. https://github.com/user/repo.git)
 *   - SSH URL: ssh://[user@]host/path (e.g. ssh://git@github.com/user/repo.git)
 *   - SCP-style SSH: user@host:path (e.g. git@github.com:user/repo.git)
 *
 * SSH addresses are accepted without host restriction because `git clone` will
 * reject invalid hosts on its own, and the server SSH key / known_hosts
 * configuration controls which remote hosts are trusted.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function validateRepoUrl(url) {
  if (typeof url !== 'string' || !url) return false;

  // Parseable URL schemes.
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      return parsed.hostname === 'github.com' || parsed.hostname === 'gitlab.com';
    }
    if (parsed.protocol === 'ssh:') {
      return parsed.hostname.length > 0 && parsed.pathname.length > 1;
    }
    return false;
  } catch {
    // Not a standard URL - fall through to SCP-style check.
  }

  // SCP-style SSH: user@host:path (e.g. git@github.com:user/repo.git)
  return /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[a-zA-Z0-9._\-/]+$/.test(url);
}

/**
 * Resolve the absolute deploy path for an app and verify that it stays
 * within the configured DEPLOY_BASE_DIR (prevents directory traversal).
 *
 * @param {string} appName - Validated PM2 app name.
 * @returns {string} Absolute deploy path.
 * @throws {Error} If the resolved path would escape the base directory.
 */
export function resolveDeployPath(appName) {
  const base = config.DEPLOY_BASE_DIR;
  const resolved = path.resolve(base, appName);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Deploy path escapes base directory: ${resolved}`);
  }
  return resolved;
}

// .env file parser ─────────────────────────────────────────────────────────

/**
 * Parse a .env file and return key-value pairs.
 * Lines beginning with # and blank lines are skipped.
 * Values are not unquoted - raw strings as written in the file are returned.
 *
 * The path can be absolute (used as-is) or relative (resolved against
 * deployPath). Absolute paths are useful when the .env file lives outside
 * the cloned repo, e.g. in a secrets directory on the server.
 *
 * @param {string} deployPath - Absolute path to the cloned repo.
 * @param {string} envFilePath - Absolute path or path relative to deployPath.
 * @returns {object} Key-value map of env vars, or {} on error.
 */
export function parseEnvFile(deployPath, envFilePath) {
  if (!envFilePath) return {};
  const resolved = path.isAbsolute(envFilePath) ? envFilePath : path.join(deployPath, envFilePath);
  let content;
  try {
    // Synchronous read is fine here - this file is always small.
    content = fs.readFileSync(resolved, 'utf8');
  } catch {
    return {};
  }
  const result = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

// Spawn helpers ────────────────────────────────────────────────────────────

/**
 * Run a command and capture its combined stdout+stderr output to a string.
 * Rejects if the process exits with a non-zero code or if the timeout expires.
 *
 * @param {string} cmd - Executable name or absolute path.
 * @param {string[]} args - Argument array.
 * @param {string} cwd - Working directory.
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts] - Optional
 *   kill timeout in milliseconds (0 disables it) and environment overrides.
 * @returns {Promise<string>}
 */
export function captureCommand(cmd, args, cwd, { timeoutMs = 0, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'pipe', env: env ?? process.env });
    const chunks = [];
    let timedOut = false;

    // A background poll must never hang forever (e.g. git waiting on a
    // credential prompt), so an optional timeout kills the child outright.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const output = Buffer.concat(chunks).toString();
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
      } else if (code === 0) {
        resolve(output);
      } else {
        // Keep the tail of the output in the message: an exit code alone tells
        // the user nothing when the failure surfaces in the UI.
        const detail = output.trim().split('\n').slice(-3).join(' ').trim().slice(0, 200);
        reject(new Error(detail ? `${cmd} exited with code ${code}: ${detail}` : `${cmd} exited with code ${code}`));
      }
    });
  });
}

/**
 * Run a deployment step and capture its output, without a timeout.
 *
 * @param {string} cmd - Executable name or absolute path.
 * @param {string[]} args - Argument array.
 * @param {string} cwd - Working directory.
 * @returns {Promise<string>}
 */
function captureStep(cmd, args, cwd) {
  return captureCommand(cmd, args, cwd);
}

/**
 * Run a command and stream its output via the WebSocket broadcast helper.
 * Rejects if the process exits with a non-zero code.
 *
 * @param {string} cmd - Executable name or absolute path.
 * @param {string[]} args - Argument array (never interpolated into shell strings).
 * @param {string} cwd - Working directory.
 * @param {string} deploymentId - Deployment UUID for broadcast routing.
 * @param {string} stage - Stage label sent with each progress message.
 * @returns {Promise<void>}
 */
function spawnStep(cmd, args, cwd, deploymentId, stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'pipe' });

    child.stdout.on('data', (chunk) => {
      broadcastDeployProgress(deploymentId, stage, chunk.toString(), 'running');
    });
    child.stderr.on('data', (chunk) => {
      broadcastDeployProgress(deploymentId, stage, chunk.toString(), 'running');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

/**
 * Write a shell script body to a temporary file, execute it, then delete it.
 * The script runs with `sh` in `cwd`.
 *
 * @param {string} scriptBody - Shell script contents.
 * @param {string} cwd - Working directory.
 * @param {string} deploymentId - Deployment UUID for broadcast routing.
 * @param {string} stage - Stage label sent with each progress message.
 * @returns {Promise<void>}
 */
async function runScript(scriptBody, cwd, deploymentId, stage) {
  const tmpFile = path.join(os.tmpdir(), `hawkeye-${crypto.randomUUID()}.sh`);
  try {
    await fsp.writeFile(tmpFile, scriptBody, { encoding: 'utf8', mode: 0o700 });
    await spawnStep('sh', [tmpFile], cwd, deploymentId, stage);
  } finally {
    await fsp.unlink(tmpFile).catch(() => {});
  }
}

// Pending confirmations ────────────────────────────────────────────────────

/**
 * @type {Map<string, { resolve: (confirmed: boolean) => void, timeout: ReturnType<typeof setTimeout> }>}
 */
const _pendingConfirmations = new Map();

/**
 * Broadcast a confirmation request and wait up to 60 seconds for the user to respond.
 * Resolves with true if the user confirms, false if they cancel.
 * Rejects if the 60-second timeout expires with no response.
 *
 * @param {string} deploymentId - UUID of the deployment record.
 * @param {string} changesText - Output of `git status --porcelain` (tracked changes only).
 * @returns {Promise<boolean>}
 */
function waitForConfirmation(deploymentId, changesText) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pendingConfirmations.delete(deploymentId);
      reject(new Error('Confirmation timed out after 60 seconds'));
    }, 60_000);
    _pendingConfirmations.set(deploymentId, { resolve, timeout });
    broadcastDeployProgress(deploymentId, 'clone', changesText, 'confirm');
  });
}

/**
 * Resolve a pending deployment confirmation.
 * Called by the HTTP confirm endpoint when the user clicks Discard or Cancel.
 *
 * @param {string} deploymentId - UUID of the deployment record.
 * @param {boolean} confirmed - True to discard changes and continue; false to cancel.
 */
export function resolveConfirmation(deploymentId, confirmed) {
  const pending = _pendingConfirmations.get(deploymentId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  _pendingConfirmations.delete(deploymentId);
  pending.resolve(confirmed);
}

// PM2 options builder ──────────────────────────────────────────────────────

/**
 * Build the pm2.start options object from a deployment record.
 *
 * Default values mirror PM2 ecosystem.config.js defaults where applicable.
 * `time: true` is always forced on so that pm2-hawkeye can sort logs
 * chronologically.
 *
 * @param {object} deployment - Deployment record from deploymentStorage.
 * @returns {object} Options object for pm2.startProcess().
 */
function buildPm2Options(deployment) {
  const opts = deployment.pm2_options || {};
  const envFileVars = parseEnvFile(deployment.deploy_path, opts.env_file || '');
  const env = { ...envFileVars, ...(deployment.env_vars || {}) };

  const result = {
    name: deployment.pm2_name,
    script: deployment.start_script,
    cwd: deployment.deploy_path,
    time: true,
    interpreter: opts.interpreter || 'node',
    interpreter_args: opts.interpreter_args || [],
    args: opts.args || [],
    exec_mode: opts.exec_mode || 'fork',
    instances: opts.instances ?? 1,
    watch: opts.watch ?? false,
    ignore_watch: opts.ignore_watch?.length ? opts.ignore_watch : null,
    max_memory_restart: opts.max_memory_restart || null,
    autorestart: opts.autorestart ?? true,
    max_restarts: opts.max_restarts ?? 10,
    restart_delay: opts.restart_delay ?? 0,
    min_uptime: opts.min_uptime ?? null,
    kill_timeout: opts.kill_timeout ?? null,
    listen_timeout: opts.listen_timeout ?? null,
    wait_ready: opts.wait_ready ?? false,
    shutdown_with_message: opts.shutdown_with_message ?? false,
    cron_restart: opts.cron_restart || null,
    merge_logs: opts.combine_logs ?? false,
    out_file: opts.out_file || null,
    error_file: opts.error_file || null,
    source_map_support: opts.source_map_support ?? true,
    env,
  };

  return result;
}

/** Return true when a PM2 option has no retained values. */
function isEmptyPm2Option(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Compare scalar, string, and array PM2 option representations. */
function pm2OptionEquals(actual, requested) {
  if (Array.isArray(actual) || Array.isArray(requested)) {
    return JSON.stringify(actual ?? []) === JSON.stringify(requested ?? []);
  }
  return actual === requested;
}

/** Convert PM2 byte-size strings to their daemon-side numeric representation. */
function normalizeMemoryLimit(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(/^(\d+)([KMG])?$/i);
  if (!match) return value;
  const factors = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  return Number(match[1]) * (factors[match[2]?.toUpperCase()] ?? 1);
}

/** Convert PM2 duration strings to their daemon-side millisecond value. */
function normalizeDuration(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(/^(\d+)([smh])?$/i);
  if (!match) return value;
  const factors = { S: 1000, M: 60_000, H: 3_600_000 };
  return Number(match[1]) * (factors[match[2]?.toUpperCase()] ?? 1);
}

/** Return true when a PM2 path has the generated default log filename. */
function isDefaultLogPath(filePath, name, stream) {
  if (!filePath) return false;
  const safeName = name.replace(/[^a-zA-Z0-9.-]/g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = stream === 'out' ? 'out' : 'error';
  return new RegExp(`^${safeName}-${suffix}(?:-\\d+)?\\.log$`).test(path.basename(filePath));
}

/**
 * Reject configuration removals which PM2's merge-based restart cannot apply.
 * The check runs before startProcess so the current process remains untouched.
 *
 * @param {object[]} processes
 * @param {object} options
 */
function rejectUnsupportedPm2Transitions(processes, options) {
  for (const process of processes) {
    const env = process.pm2_env ?? {};
    const removals = [
      ['ignored watch paths', env.ignore_watch, options.ignore_watch, null],
      ['memory restart limit', env.max_memory_restart, options.max_memory_restart, null],
      ['minimum uptime', normalizeDuration(env.min_uptime), options.min_uptime, 1000],
      ['kill timeout', normalizeDuration(env.kill_timeout), options.kill_timeout, 1600],
      ['listen timeout', normalizeDuration(env.listen_timeout), options.listen_timeout, 3000],
      ['cron restart', env.cron_restart, options.cron_restart, null],
    ];

    for (const [label, current, requested, defaultValue] of removals) {
      if (isEmptyPm2Option(requested) && !isEmptyPm2Option(current) && current !== defaultValue) {
        throw new Error(
          `PM2 cannot safely remove ${label} for "${options.name}" without replacing the process. ` +
            'Clear it in PM2 first, then redeploy.',
        );
      }
    }

    const currentMode = env.exec_mode?.replace(/_mode$/, '');
    const requestedMode = options.exec_mode.replace(/_mode$/, '');
    if (currentMode && currentMode !== requestedMode) {
      throw new Error(
        `PM2 cannot safely change execution mode for "${options.name}" without replacing the process. ` +
          'Change it in PM2 first, then redeploy.',
      );
    }
    if (env.merge_logs === true && options.merge_logs === false) {
      throw new Error(
        `PM2 cannot safely disable combined logs for "${options.name}" without replacing the process. ` +
          'Disable it in PM2 first, then redeploy.',
      );
    }
    if (!options.out_file && env.pm_out_log_path && !isDefaultLogPath(env.pm_out_log_path, options.name, 'out')) {
      throw new Error(
        `PM2 cannot safely remove the stdout log path for "${options.name}" without replacing the process. ` +
          'Reset it in PM2 first, then redeploy.',
      );
    }
    if (!options.error_file && env.pm_err_log_path && !isDefaultLogPath(env.pm_err_log_path, options.name, 'error')) {
      throw new Error(
        `PM2 cannot safely remove the stderr log path for "${options.name}" without replacing the process. ` +
          'Reset it in PM2 first, then redeploy.',
      );
    }

    const removedEnvironmentKeys = getRemovedEnvironmentKeys(env, options);
    if (removedEnvironmentKeys.length > 0) {
      throw new Error(
        `PM2 cannot safely remove environment variable "${removedEnvironmentKeys[0]}" for "${options.name}" ` +
          'without replacing the process. Remove it in PM2 first, then redeploy.',
      );
    }
  }
}

/** Return prior application environment keys that the deployment removed. */
function getRemovedEnvironmentKeys(processEnv, options) {
  const requested = new Set(Object.keys(options.env));
  return Object.keys(processEnv.env ?? {}).filter(
    (key) =>
      !requested.has(key) &&
      !(key in process.env) &&
      !/^PM2_/.test(key) &&
      !['NODE_APP_INSTANCE', 'pm_id', 'name', 'namespace'].includes(key),
  );
}

/**
 * Verify settings which PM2 otherwise merges with the old descriptor.
 *
 * @param {object} processEnv
 * @param {object} options
 * @param {string} name
 * @param {string[]} [removedEnvironmentKeys]
 */
function verifyAppliedPm2Options(processEnv, options, name, removedEnvironmentKeys = []) {
  const clearable = [
    ['args', processEnv.args, options.args, null],
    ['interpreter arguments', processEnv.node_args, options.interpreter_args, null],
    ['ignored watch paths', processEnv.ignore_watch, options.ignore_watch, null],
    ['memory restart limit', processEnv.max_memory_restart, normalizeMemoryLimit(options.max_memory_restart), null],
    ['minimum uptime', normalizeDuration(processEnv.min_uptime), normalizeDuration(options.min_uptime), 1000],
    ['kill timeout', normalizeDuration(processEnv.kill_timeout), normalizeDuration(options.kill_timeout), 1600],
    ['listen timeout', normalizeDuration(processEnv.listen_timeout), normalizeDuration(options.listen_timeout), 3000],
    ['cron restart', processEnv.cron_restart, options.cron_restart, null],
  ];
  for (const [label, actual, requested, defaultValue] of clearable) {
    if (isEmptyPm2Option(requested) && !isEmptyPm2Option(actual) && actual !== defaultValue) {
      throw new Error(`PM2 did not clear ${label} for "${name}".`);
    }
    if (!isEmptyPm2Option(requested) && !pm2OptionEquals(actual, requested)) {
      throw new Error(`PM2 did not apply ${label} for "${name}".`);
    }
  }

  const expectedMode = `${options.exec_mode.replace(/_mode$/, '')}_mode`;
  if (processEnv.exec_mode && processEnv.exec_mode !== expectedMode) {
    throw new Error(`PM2 did not apply execution mode for "${name}".`);
  }
  if (processEnv.instances != null && processEnv.instances !== options.instances) {
    throw new Error(`PM2 did not apply instance count for "${name}".`);
  }
  if (Boolean(processEnv.watch) !== Boolean(options.watch)) {
    throw new Error(`PM2 did not apply watch mode for "${name}".`);
  }
  if (processEnv.autorestart != null && processEnv.autorestart !== options.autorestart) {
    throw new Error(`PM2 did not apply autorestart for "${name}".`);
  }
  if (processEnv.wait_ready != null && processEnv.wait_ready !== options.wait_ready) {
    throw new Error(`PM2 did not apply ready-wait mode for "${name}".`);
  }
  if (processEnv.shutdown_with_message != null && processEnv.shutdown_with_message !== options.shutdown_with_message) {
    throw new Error(`PM2 did not apply shutdown mode for "${name}".`);
  }
  if (processEnv.max_restarts != null && processEnv.max_restarts !== options.max_restarts) {
    throw new Error(`PM2 did not apply maximum restarts for "${name}".`);
  }
  if (processEnv.restart_delay != null && processEnv.restart_delay !== options.restart_delay) {
    throw new Error(`PM2 did not apply restart delay for "${name}".`);
  }
  if (Boolean(processEnv.merge_logs) !== Boolean(options.merge_logs)) {
    throw new Error(`PM2 did not apply combined logs for "${name}".`);
  }
  if (processEnv.source_map_support != null && processEnv.source_map_support !== options.source_map_support) {
    throw new Error(`PM2 did not apply source-map support for "${name}".`);
  }

  if (options.out_file && path.resolve(options.cwd, options.out_file) !== processEnv.pm_out_log_path) {
    throw new Error(`PM2 did not apply stdout log path for "${name}".`);
  }
  if (options.error_file && path.resolve(options.cwd, options.error_file) !== processEnv.pm_err_log_path) {
    throw new Error(`PM2 did not apply stderr log path for "${name}".`);
  }

  for (const [key, value] of Object.entries(options.env)) {
    if (String(processEnv.env?.[key]) !== String(value)) {
      throw new Error(`PM2 did not apply environment variable "${key}" for "${name}".`);
    }
  }
  for (const key of removedEnvironmentKeys) {
    if (Object.hasOwn(processEnv.env ?? {}, key)) {
      throw new Error(`PM2 did not remove environment variable "${key}" for "${name}".`);
    }
  }
}

/**
 * Validate and activate a deployment through PM2. Starting with a complete
 * options object updates a matching PM2 application without deleting it first.
 *
 * @param {object} deployment
 * @param {{
 *   stat?: typeof fsp.stat,
 *   startProcess?: typeof pm2.startProcess,
 *   loadProcessList?: typeof pm2.loadProcessList,
 * }} [operations]
 * @returns {Promise<void>}
 */
export async function activateDeployment(
  deployment,
  { stat = fsp.stat, startProcess = pm2.startProcess, loadProcessList = pm2.loadProcessList } = {},
) {
  const pm2Options = buildPm2Options(deployment);
  const requestedOptions = structuredClone(pm2Options);
  const scriptPath = path.resolve(requestedOptions.cwd, requestedOptions.script);

  let scriptStat;
  try {
    scriptStat = await stat(scriptPath);
  } catch {
    throw new Error(`Start script not found: ${scriptPath}`);
  }
  if (typeof scriptStat.isFile === 'function' && !scriptStat.isFile()) {
    throw new Error(`Start script not found: ${scriptPath}`);
  }

  const beforeProcesses = (await loadProcessList()).filter((process) => process.name === requestedOptions.name);
  rejectUnsupportedPm2Transitions(beforeProcesses, requestedOptions);

  await startProcess(pm2Options);

  // PM2's object-based restart path can report success even when the daemon
  // failed to restart an existing application. Verify the daemon state before
  // the deployment record is marked successful.
  const processes = await loadProcessList();
  const active = processes.filter((process) => process.name === requestedOptions.name);
  if (active.length === 0) {
    throw new Error(`PM2 did not create process "${requestedOptions.name}".`);
  }

  for (const process of active) {
    const processEnv = process.pm2_env ?? {};
    if (!['online', 'launching'].includes(processEnv.status)) {
      throw new Error(`PM2 process "${requestedOptions.name}" status is "${processEnv.status ?? 'unknown'}".`);
    }
    if (path.resolve(processEnv.pm_exec_path ?? '') !== scriptPath) {
      throw new Error(`PM2 did not apply the requested start script for "${requestedOptions.name}".`);
    }
    if (path.resolve(processEnv.pm_cwd ?? '') !== path.resolve(requestedOptions.cwd)) {
      throw new Error(`PM2 did not apply the requested working directory for "${requestedOptions.name}".`);
    }
    const before = beforeProcesses.find((candidate) => candidate.pm_id === process.pm_id);
    const removedEnvironmentKeys = before ? getRemovedEnvironmentKeys(before.pm2_env ?? {}, requestedOptions) : [];
    verifyAppliedPm2Options(processEnv, requestedOptions, requestedOptions.name, removedEnvironmentKeys);

    if (
      before &&
      before.pid === process.pid &&
      before.pm2_env?.pm_uptime === processEnv.pm_uptime &&
      before.pm2_env?.restart_time === processEnv.restart_time
    ) {
      throw new Error(`PM2 did not restart process "${requestedOptions.name}".`);
    }
  }
}

// Main deploy function ─────────────────────────────────────────────────────

/**
 * Run a full deployment (first-time) or re-deployment (update) for a record.
 *
 * Execution sequence:
 *   1. pre_setup_script  (if set) - runs in DEPLOY_BASE_DIR
 *   2. git clone / git pull
 *   3. install command
 *   4. build command     (if set)
 *   5. post_setup_script (if set) - runs in deploy_path
 *   6. pm2 start / restart
 *
 * Progress is broadcast to all connected WebSocket clients via
 * broadcastDeployProgress().  The function never throws; errors are broadcast,
 * the deploying flag is cleared, and the failure is reported in the return value.
 *
 * @param {object} deployment - Full deployment record from deploymentStorage.
 * @param {{ isRedeploy: boolean, autoConfirm?: boolean }} opts - `autoConfirm`
 *   discards local tracked changes without asking, for unattended deploys
 *   triggered by the branch watcher.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runDeploy(deployment, { isRedeploy, autoConfirm = false }) {
  const { id, pm2_name, repo_url, branch, deploy_path, install_cmd, build_cmd, pre_setup_script, post_setup_script } =
    deployment;

  const broadcast = (stage, line, status) => broadcastDeployProgress(id, stage, line, status);

  try {
    setDeploying(id, true);

    // 1. Pre-setup script
    if (pre_setup_script) {
      broadcast('pre_setup', 'Running pre-setup script...\n', 'running');
      await runScript(pre_setup_script, config.DEPLOY_BASE_DIR, id, 'pre_setup');
    }

    // 2. Clone or pull.
    // Even during a redeploy, if the target directory does not contain a valid
    // git repository (e.g. the initial clone failed), we must fall back to a
    // fresh clone rather than attempting a pull into a non-existent or broken
    // directory.
    const hasGitDir = await fsp
      .stat(path.join(deploy_path, '.git'))
      .then(() => true)
      .catch(() => false);
    if (isRedeploy && hasGitDir) {
      // Check for tracked local changes that would cause git pull --rebase to fail.
      // Untracked files (lines starting with ??) do not affect the pull and are skipped.
      const statusOutput = await captureStep(
        'git',
        ['-C', deploy_path, 'status', '--porcelain'],
        config.DEPLOY_BASE_DIR,
      );
      const trackedChanges = statusOutput
        .split('\n')
        .filter((l) => l.length >= 2 && !l.startsWith('??'))
        .join('\n')
        .trim();
      if (trackedChanges) {
        if (autoConfirm) {
          // Nobody is watching an auto-deploy, so asking would only stall it
          // until the confirmation timeout expires.
          broadcast('clone', 'Local changes detected. Discarding them automatically...\n', 'running');
        } else {
          broadcast('clone', 'Local changes detected. Waiting for confirmation to discard them...\n', 'running');
          const confirmed = await waitForConfirmation(id, trackedChanges);
          if (!confirmed) throw new Error('Deployment cancelled: local changes were not discarded.');
          broadcast('clone', 'Discarding local changes...\n', 'running');
        }
        await spawnStep('git', ['-C', deploy_path, 'reset', '--hard', 'HEAD'], config.DEPLOY_BASE_DIR, id, 'clone');
        broadcast('clone', 'Local changes discarded.\n', 'running');
      }

      broadcast('clone', `Pulling ${branch} from origin...\n`, 'running');
      await spawnStep(
        'git',
        ['-C', deploy_path, 'pull', '--rebase', 'origin', branch],
        config.DEPLOY_BASE_DIR,
        id,
        'clone',
      );
    } else {
      // Remove a leftover partial directory from a previously failed clone so
      // git does not refuse to clone into a non-empty destination.
      await fsp.rm(deploy_path, { recursive: true, force: true });
      broadcast('clone', `Cloning ${repo_url} (branch: ${branch})...\n`, 'running');
      await fsp.mkdir(config.DEPLOY_BASE_DIR, { recursive: true });
      await spawnStep(
        'git',
        ['clone', '--branch', branch, '--depth', '1', repo_url, deploy_path],
        config.DEPLOY_BASE_DIR,
        id,
        'clone',
      );
    }

    // 3. Install
    if (install_cmd && install_cmd !== 'skip') {
      broadcast('install', `Running ${install_cmd}...\n`, 'running');
      // Split on runs of whitespace so extra/leading spaces never produce empty
      // argv entries (which a process like npm would reject).
      const [cmd, ...args] = install_cmd.trim().split(/\s+/);
      await spawnStep(cmd, args, deploy_path, id, 'install');
    }

    // 4. Build
    if (build_cmd) {
      broadcast('build', `Running ${build_cmd}...\n`, 'running');
      const [cmd, ...args] = build_cmd.trim().split(/\s+/);
      await spawnStep(cmd, args, deploy_path, id, 'build');
    }

    // 5. Post-setup script
    if (post_setup_script) {
      broadcast('post_setup', 'Running post-setup script...\n', 'running');
      await runScript(post_setup_script, deploy_path, id, 'post_setup');
    }

    // 6. Start or restart
    broadcast(
      'start',
      isRedeploy ? `Restarting PM2 process ${pm2_name}...\n` : `Starting PM2 process ${pm2_name}...\n`,
      'running',
    );

    await activateDeployment(deployment);

    updateLastDeployed(id);
    setDeploying(id, false);
    broadcast('done', '', 'success');
    return { ok: true };
  } catch (err) {
    setDeploying(id, false);
    // PM2 sometimes rejects with a plain string rather than an Error object.
    // Normalise to a non-empty message so the UI always shows something useful.
    const errMsg =
      (err instanceof Error ? err.message : null) ||
      (typeof err === 'string' ? err : null) ||
      err?.msg ||
      JSON.stringify(err) ||
      'Unknown error';
    logger.error(`[DEPLOY] Deployment failed for "${pm2_name}": ${errMsg}`);
    broadcast('error', errMsg, 'error');
    return { ok: false, error: errMsg };
  }
}

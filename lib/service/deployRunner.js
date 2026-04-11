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
  };

  if (opts.interpreter && opts.interpreter !== 'node') result.interpreter = opts.interpreter;
  if (opts.interpreter_args) result.interpreter_args = opts.interpreter_args;
  if (opts.args) result.args = opts.args;
  if (opts.exec_mode) result.exec_mode = opts.exec_mode;

  result.instances = opts.instances ?? 1;
  result.watch = opts.watch ?? false;

  if (opts.ignore_watch && opts.ignore_watch.length > 0) result.ignore_watch = opts.ignore_watch;

  if (opts.max_memory_restart) result.max_memory_restart = opts.max_memory_restart;

  result.autorestart = opts.autorestart ?? true;
  result.max_restarts = opts.max_restarts ?? 10;
  result.restart_delay = opts.restart_delay ?? 0;

  if (opts.min_uptime != null) result.min_uptime = opts.min_uptime;
  if (opts.kill_timeout != null) result.kill_timeout = opts.kill_timeout;
  if (opts.listen_timeout != null) result.listen_timeout = opts.listen_timeout;
  if (opts.wait_ready) result.wait_ready = true;
  if (opts.shutdown_with_message) result.shutdown_with_message = true;
  if (opts.cron_restart) result.cron_restart = opts.cron_restart;

  result.combine_logs = opts.combine_logs ?? false;

  if (opts.out_file) result.out_file = opts.out_file;
  if (opts.error_file) result.error_file = opts.error_file;

  if (opts.source_map_support === false) result.source_map_support = false;

  if (Object.keys(env).length > 0) result.env = env;

  return result;
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
 * broadcastDeployProgress().  The function never throws; errors are broadcast
 * and the deploying flag is cleared before returning.
 *
 * @param {object} deployment - Full deployment record from deploymentStorage.
 * @param {{ isRedeploy: boolean }} opts
 * @returns {Promise<void>}
 */
export async function runDeploy(deployment, { isRedeploy }) {
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
    const hasGitDir = await fsp.stat(path.join(deploy_path, '.git')).then(() => true).catch(() => false);
    if (isRedeploy && hasGitDir) {
      broadcast('clone', `Pulling ${branch} from origin...\n`, 'running');
      await spawnStep('git', ['-C', deploy_path, 'pull', '--rebase', 'origin', branch], config.DEPLOY_BASE_DIR, id, 'clone');
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
      const [cmd, ...args] = install_cmd.split(' ');
      await spawnStep(cmd, args, deploy_path, id, 'install');
    }

    // 4. Build
    if (build_cmd) {
      broadcast('build', `Running ${build_cmd}...\n`, 'running');
      const [cmd, ...args] = build_cmd.split(' ');
      await spawnStep(cmd, args, deploy_path, id, 'build');
    }

    // 5. Post-setup script
    if (post_setup_script) {
      broadcast('post_setup', 'Running post-setup script...\n', 'running');
      await runScript(post_setup_script, deploy_path, id, 'post_setup');
    }

    // 6. Start or restart
    broadcast('start', isRedeploy ? `Restarting PM2 process ${pm2_name}...\n` : `Starting PM2 process ${pm2_name}...\n`, 'running');

    if (isRedeploy) {
      // Delete first so PM2 picks up updated options (env vars, interpreter
      // settings, etc.) on the fresh start. Ignore errors - the process may
      // have been removed from PM2 manually between deploys.
      try {
        await pm2.deleteProcess(pm2_name);
      } catch {
        // intentionally ignored
      }
    }

    const pm2Opts = buildPm2Options(deployment);
    broadcast('start', `PM2 options: script="${pm2Opts.script}" cwd="${pm2Opts.cwd}"\n`, 'running');

    // Verify the start script exists before handing off to PM2, so a missing
    // file produces a clear message rather than a silent PM2 failure.
    const scriptPath = path.join(pm2Opts.cwd, pm2Opts.script);
    const scriptExists = await fsp.stat(scriptPath).then(() => true).catch(() => false);
    if (!scriptExists) {
      throw new Error(`Start script not found: ${scriptPath}`);
    }

    await pm2.startProcess(pm2Opts);

    updateLastDeployed(id);
    setDeploying(id, false);
    broadcast('done', '', 'success');
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
  }
}

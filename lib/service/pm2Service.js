/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import pm2 from 'pm2';
import config from '../config.js';

// PM2 API helpers ──────────────────────────────────────────────────────────

const pm2Connect = promisify(pm2.connect.bind(pm2));
const pm2List = promisify(pm2.list.bind(pm2));
const pm2Restart = promisify(pm2.restart.bind(pm2));
const pm2Trigger = promisify(pm2.trigger.bind(pm2));

// Single persistent connection - pm2's client is not safe to connect/disconnect
// in rapid succession (sock state becomes null mid-reconnect and crashes).
let connected = false;
let connectingPromise = null;

/**
 * Ensure a single persistent connection to the PM2 daemon is established.
 * Concurrent callers wait on the same in-flight connect.
 */
async function ensureConnected() {
  if (connected) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = pm2Connect().then(() => {
    connected = true;
    connectingPromise = null;
  });
  await connectingPromise;
}

/**
 * Reset the connection state so the next API call triggers a fresh connect.
 * Called whenever a PM2 RPC call fails, which indicates the socket has dropped.
 */
function resetConnection() {
  connected = false;
  connectingPromise = null;
}

// Process list ────────────────────────────────────────────────────────────

/**
 * Fetch the full PM2 process list.
 *
 * If the PM2 RPC call fails (e.g. the socket dropped while idle), the
 * connection state is reset so the next caller triggers a fresh connect.
 *
 * @returns {Promise<object[]>} Raw PM2 process descriptors.
 */
export async function loadProcessList() {
  await ensureConnected();
  try {
    const list = await pm2List();
    return Array.isArray(list) ? list : [];
  } catch (err) {
    resetConnection();
    throw err;
  }
}

/** Safely coerce a value to a finite number, falling back to `fallback`. */
function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Normalise a raw PM2 descriptor into a compact summary object suitable for
 * the API response.
 *
 * @param {object} proc - Raw PM2 process descriptor.
 * @returns {object} Normalised summary.
 */
export function normalizeProcessSummary(proc) {
  const env = proc.pm2_env || {};
  const monit = proc.monit || {};

  return {
    id: proc.pm_id,
    name: proc.name || `pm2-${proc.pm_id}`,
    pid: proc.pid || null,
    status: env.status || 'unknown',
    version: env.version || null,
    namespace: env.namespace || null,
    execMode: env.exec_mode || null,
    instances: env.instances ?? null,
    restarts: env.restart_time ?? 0,
    uptime: env.pm_uptime || null,
    createdAt: env.created_at || null,
    scriptPath: env.pm_exec_path || env.pm_cwd || null,
    cwd: env.pm_cwd || null,
    watch: Boolean(env.watch),
    cpu: safeNumber(monit.cpu),
    memory: safeNumber(monit.memory),
  };
}

// Log file helpers ────────────────────────────────────────────────────────

/**
 * Extract the first ISO-like timestamp found anywhere in a log line.
 * Matches formats like `2026-03-14T16:25:41` or `2026-03-14 16:25:41`.
 * Returns an empty string when no timestamp is present (lines without a
 * timestamp are stable-sorted to the end).
 *
 * @param {string} line
 * @returns {string}
 */
export function extractTimestamp(line) {
  return line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/)?.[1] ?? '';
}

/**
 * Collect de-duplicated log file paths from a PM2 process descriptor.
 *
 * @param {object} proc - Raw PM2 process descriptor.
 * @returns {{ type: string, path: string }[]}
 */
function uniqueLogFiles(proc) {
  const env = proc.pm2_env || {};

  const combinedPath = env.pm_log_path || env.log_file || null;
  const infoPath = env.pm_out_log_path || env.out_file || null;
  const errorPath = env.pm_err_log_path || env.error_file || null;

  // When individual out/error logs are available, skip the combined log to
  // avoid duplicate lines (PM2 writes the same content to both).
  const hasIndividualLogs = (infoPath && infoPath !== '/dev/null') || (errorPath && errorPath !== '/dev/null');

  const candidates = [];
  if (!hasIndividualLogs) {
    candidates.push({ type: 'combined', path: combinedPath });
  }
  candidates.push({ type: 'stdout', path: infoPath });
  candidates.push({ type: 'stderr', path: errorPath });

  const seen = new Set();
  const files = [];

  for (const candidate of candidates) {
    if (!candidate.path || candidate.path === '/dev/null') {
      continue;
    }

    const resolved = path.resolve(candidate.path);
    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    files.push({ ...candidate, path: resolved });
  }

  return files;
}

/**
 * Read the tail of a single log file, split into lines, and annotate each
 * line with its source type. Large files are truncated to the configured
 * MAX_LOG_BYTES_PER_FILE.
 *
 * @param {{ type: string, path: string }} logFile
 * @returns {Promise<object>} Enriched log-file descriptor.
 */
async function readLogFile(logFile) {
  try {
    const stat = await fsp.stat(logFile.path);
    if (!stat.isFile()) {
      return { ...logFile, available: false, reason: 'not_a_file' };
    }

    let start = 0;
    let truncated = false;

    if (config.MAX_LOG_BYTES_PER_FILE > 0 && stat.size > config.MAX_LOG_BYTES_PER_FILE) {
      start = stat.size - config.MAX_LOG_BYTES_PER_FILE;
      truncated = true;
    }

    const handle = await fsp.open(logFile.path, 'r');
    try {
      const length = Math.max(stat.size - start, 0);
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        await handle.read(buffer, 0, length, start);
      }

      const content = buffer.toString('utf8');
      // When truncated the first (partial) line is discarded.
      const normalized = truncated ? content.replace(/^[^\n]*\n?/, '') : content;
      const lines = normalized
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line, index) => ({
          lineNumber: index + 1,
          text: line,
          source: logFile.type,
        }));

      return {
        ...logFile,
        available: true,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        truncated,
        loadedBytes: Buffer.byteLength(normalized),
        lines,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ...logFile,
      available: false,
      reason: error.code || 'read_failed',
      error: error.message,
    };
  }
}

// Composite queries ───────────────────────────────────────────────────────

/**
 * Load the summary details for a single PM2 process.
 *
 * Returns only the process summary object with extended metadata fields.
 * Log data is no longer included here; it is streamed via the WS log bus
 * or fetched from the stored-logs HTTP endpoint.
 *
 * @param {string|number} processId
 * @returns {Promise<object|null>} Detail payload, or null if not found.
 */
export async function loadProcessDetails(processId) {
  const processes = await loadProcessList();
  const proc = processes.find((entry) => String(entry.pm_id) === String(processId));

  if (!proc) {
    return null;
  }

  const summary = normalizeProcessSummary(proc);

  return {
    process: {
      ...summary,
      interpreter: proc.pm2_env?.exec_interpreter || null,
      nodeVersion: proc.pm2_env?.node_version || null,
      username: proc.pm2_env?.username || null,
      autorestart: proc.pm2_env?.autorestart ?? null,
      unstableRestarts: proc.pm2_env?.unstable_restarts ?? null,
      mergeLogs: proc.pm2_env?.merge_logs ?? null,
    },
  };
}

/**
 * Restart a PM2 process by id.
 *
 * @param {string|number} processId
 * @returns {Promise<void>}
 */
export async function restartProcess(processId) {
  await ensureConnected();
  try {
    await pm2Restart(String(processId));
  } catch (err) {
    resetConnection();
    throw err;
  }
}

/**
 * Get available PM2 custom actions for a process from its axm_actions metadata.
 *
 * @param {string|number} processId
 * @returns {Promise<{ name: string, params: any[] }[]>} List of actions.
 */
export async function getProcessActions(processId) {
  const processes = await loadProcessList();
  const proc = processes.find((entry) => String(entry.pm_id) === String(processId));
  if (!proc) {
    return [];
  }
  const axm = proc.pm2_env?.axm_actions || [];
  return axm
    .filter((a) => a.action_name)
    .map((a) => {
      const params = Array.isArray(a.arity) ? a.arity : Array.isArray(a.opts) ? a.opts : [];
      return { name: a.action_name, params };
    });
}

/**
 * Trigger a PM2 custom action on a process.
 *
 * @param {string|number} processId
 * @param {string} actionName
 * @param {*} [params]
 * @returns {Promise<*>}
 */
export async function triggerProcessAction(processId, actionName, params) {
  await ensureConnected();
  try {
    const hasParams = params !== undefined && params !== null && params !== '';
    return await pm2Trigger(String(processId), actionName, ...(hasParams ? [params] : []));
  } catch (err) {
    resetConnection();
    throw err;
  }
}

/**
 * Return the resolved log-file descriptors for a given process.
 *
 * Each descriptor includes the file type (`'stdout'`, `'stderr'`, or
 * `'combined'`) so callers can use it to set a default log level when the
 * line itself carries no level indicator.
 *
 * @param {string|number} processId
 * @returns {Promise<{type: string, path: string}[]>}
 */
export async function getLogFiles(processId) {
  const processes = await loadProcessList();
  const proc = processes.find((entry) => String(entry.pm_id) === String(processId));
  if (!proc) {
    return [];
  }
  return uniqueLogFiles(proc);
}

/**
 * Read all current log lines for a PM2 process by name, sorted chronologically.
 *
 * Used for initial log backfill when monitoring is first enabled.
 *
 * @param {string} pm2Name - The PM2 process name.
 * @returns {Promise<{text: string, source: string}[]>} Lines sorted by timestamp prefix.
 */
export async function readLogLinesByName(pm2Name) {
  const processes = await loadProcessList();
  const proc = processes.find((p) => p.name === pm2Name);
  if (!proc) return [];

  const logFiles = uniqueLogFiles(proc);
  const readResults = await Promise.all(logFiles.map(readLogFile));

  const allLines = [];
  for (const lf of readResults) {
    if (!lf.available) continue;
    for (const line of lf.lines) {
      allLines.push({ text: line.text, source: lf.type });
    }
  }

  allLines.sort((a, b) => {
    const tsA = extractTimestamp(a.text);
    const tsB = extractTimestamp(b.text);
    return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
  });

  return allLines;
}

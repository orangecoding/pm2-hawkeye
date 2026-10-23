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
const pm2Stop = promisify(pm2.stop.bind(pm2));
const pm2Trigger = promisify(pm2.trigger.bind(pm2));
const pm2Delete = promisify(pm2.delete.bind(pm2));
const pm2SendData = promisify(pm2.sendDataToProcessId.bind(pm2));
const pm2GetVersion = promisify(pm2.getVersion.bind(pm2));

/**
 * Start a PM2 process.
 *
 * PM2's `start` callback does not follow the Node convention. When it starts
 * apps from a configuration object, its first argument is the array of
 * per-app errors: empty (or null) when everything started, otherwise the
 * Errors that stopped an app from starting. `util.promisify` would treat even
 * the empty array as a failure, and treating every array as success would
 * swallow the real error, so this wrapper rejects on a real Error, a
 * non-empty string or a non-empty error array, and resolves otherwise.
 *
 * @param {object | string} options - PM2 start options, or a name / pm_id.
 * @returns {Promise<object[]>} Resolved with the started process descriptor array.
 */
function pm2Start(options) {
  return new Promise((resolve, reject) => {
    pm2.start(options, (err, apps) => {
      if (err instanceof Error) {
        reject(err);
      } else if (typeof err === 'string' && err.length > 0) {
        reject(new Error(err));
      } else if (Array.isArray(err) && err.length > 0) {
        reject(new Error(err.map((e) => e?.message ?? String(e)).join('; ')));
      } else {
        resolve(apps ?? []);
      }
    });
  });
}

// Single persistent connection - pm2's client is not safe to connect/disconnect
// in rapid succession (sock state becomes null mid-reconnect and crashes).
/**
 * Create a reusable connection gate around an asynchronous connect operation.
 * Failed attempts are never cached, so a later caller can retry normally.
 *
 * @param {() => Promise<void>} connect
 * @returns {{ ensureConnected: () => Promise<void>, resetConnection: () => void }}
 */
export function createConnectionGate(connect) {
  let connected = false;
  let connectingPromise = null;

  async function ensureConnected() {
    if (connected) return;
    if (connectingPromise) return connectingPromise;

    const attempt = Promise.resolve().then(connect);
    connectingPromise = attempt;
    try {
      await attempt;
      connected = true;
    } finally {
      if (connectingPromise === attempt) {
        connectingPromise = null;
      }
    }
  }

  function resetConnection() {
    connected = false;
    connectingPromise = null;
  }

  return { ensureConnected, resetConnection };
}

const connectionGate = createConnectionGate(pm2Connect);

/**
 * Ensure a single persistent connection to the PM2 daemon is established.
 * Concurrent callers wait on the same in-flight connect.
 */
async function ensureConnected() {
  await connectionGate.ensureConnected();
}

/**
 * Ensure the shared PM2 connection is up. Exported for the log bus, so the
 * whole app shares one RPC socket instead of each module calling
 * `pm2.connect()` (every call opens a new socket).
 *
 * @returns {Promise<void>}
 */
export async function connect() {
  await ensureConnected();
}

/** Error codes that mean the RPC socket to the daemon is gone, not that the daemon refused a request. */
const TRANSPORT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EPIPE', 'ETIMEDOUT']);

/**
 * Tell a dropped daemon connection apart from an ordinary failed request
 * ("process not found", an action that threw).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransportError(err) {
  return (
    TRANSPORT_ERROR_CODES.has(err?.code) ||
    /not connected|socket (?:hang up|closed)|connection (?:closed|lost)/i.test(String(err?.message ?? ''))
  );
}

/**
 * Reset the connection state so the next API call triggers a fresh connect.
 *
 * `pm2.connect()` opens a new RPC socket without closing the previous one, so
 * the stale socket is closed here first; otherwise every reconnect would leak
 * an auto-reconnecting socket to the daemon.
 */
function resetConnection() {
  try {
    pm2.Client?.client_sock?.close?.();
  } catch {
    // Already closed.
  }
  connectionGate.resetConnection();
}

/**
 * Run one PM2 RPC call on the shared connection.
 *
 * Only a transport error resets the connection. A request the daemon answered
 * with an error leaves the socket healthy, and reconnecting for it would just
 * churn sockets.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
async function withConnection(call) {
  await ensureConnected();
  try {
    return await call();
  } catch (err) {
    if (isTransportError(err)) resetConnection();
    throw err;
  }
}

/**
 * Read the version of the PM2 daemon Hawkeye is connected to.
 *
 * This can differ from the installed PM2: upgrading the global package leaves
 * the old daemon running until `pm2 update` replaces it.
 *
 * @returns {Promise<string>} The daemon's PM2 version, e.g. `7.1.0`.
 */
export async function getDaemonVersion() {
  return withConnection(() => pm2GetVersion());
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
  const list = await withConnection(() => pm2List());
  return Array.isArray(list) ? list : [];
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

/** Longest metric name kept; longer names are cut so one process cannot bloat the database. */
export const MAX_METRIC_NAME_LENGTH = 100;
/** Longest unit kept, for the same reason. */
const MAX_METRIC_UNIT_LENGTH = 20;
/** Most metrics read per process. Anything beyond is dropped, after sorting by name. */
export const MAX_CUSTOM_METRICS = 50;

/**
 * Coerce a metric value reported by tx2 or @pm2/io to a finite number.
 * PM2 passes values through unchanged, so numbers arrive as numbers or as
 * numeric strings such as `'35.25'`. A tx2 meter appends its unit to the
 * value (`'12.5req/sec'`), so a trailing copy of `unit` is stripped first.
 * Anything else is not chartable.
 *
 * @param {unknown} value
 * @param {string | null} unit - The metric's unit, if any.
 * @returns {number | null}
 */
function toMetricNumber(value, unit) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (unit && text.endsWith(unit)) text = text.slice(0, -unit.length).trim();
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the application metrics a process reports through tx2 or @pm2/io.
 *
 * Both libraries send their values to the PM2 daemon as `axm:monitor`
 * packets, and the daemon keeps the latest value of each metric in
 * `pm2_env.axm_monitor` as `{ [name]: { value, unit?, ... } }`. That includes
 * the runtime metrics @pm2/io collects on its own (heap, event loop latency,
 * active handles), since PM2 injects it into every Node process it starts.
 *
 * Non-numeric values are skipped. Names and units are trimmed and capped, and
 * at most `MAX_CUSTOM_METRICS` metrics are returned, sorted by name.
 *
 * @param {object} proc - Raw PM2 process descriptor.
 * @returns {{ name: string, value: number, unit: string | null }[]}
 */
export function extractCustomMetrics(proc) {
  const monitor = proc?.pm2_env?.axm_monitor;
  if (!monitor || typeof monitor !== 'object') return [];

  const metrics = [];
  for (const [rawName, entry] of Object.entries(monitor)) {
    const name = rawName.trim().slice(0, MAX_METRIC_NAME_LENGTH);
    if (!name || !entry || typeof entry !== 'object') continue;
    const fullUnit = typeof entry.unit === 'string' ? entry.unit.trim() || null : null;
    const value = toMetricNumber(entry.value, fullUnit);
    if (value === null) continue;
    metrics.push({ name, value, unit: fullUnit ? fullUnit.slice(0, MAX_METRIC_UNIT_LENGTH) : null });
  }

  metrics.sort((a, b) => a.name.localeCompare(b.name));
  return metrics.slice(0, MAX_CUSTOM_METRICS);
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
  return line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/)?.[1] ?? '';
}

/**
 * Merge lines from multiple PM2 log files while keeping untimestamped
 * continuation lines attached to the timestamped line that precedes them.
 *
 * @param {{ type: string, available: boolean, lines: { text: string }[] }[]} readResults
 * @returns {{ text: string, source: string }[]}
 */
export function mergeLogFileLines(readResults) {
  const groups = [];
  let sequence = 0;

  for (const logFile of readResults) {
    if (!logFile.available) continue;
    let current = null;
    for (const line of logFile.lines) {
      const timestamp = extractTimestamp(line.text);
      if (timestamp || current === null) {
        current = { timestamp, sequence: sequence++, source: logFile.type, lines: [] };
        groups.push(current);
      }
      current.lines.push(line.text);
    }
  }

  groups.sort((left, right) => {
    if (left.timestamp && right.timestamp) {
      const leftTime = Date.parse(left.timestamp.replace(' ', 'T'));
      const rightTime = Date.parse(right.timestamp.replace(' ', 'T'));
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
    }
    if (left.timestamp && !right.timestamp) return -1;
    if (!left.timestamp && right.timestamp) return 1;
    return left.sequence - right.sequence;
  });

  return groups.flatMap((group) => group.lines.map((text) => ({ text, source: group.source })));
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
 * Returns the process summary object with extended metadata fields, plus the
 * latest value of every application metric (see `extractCustomMetrics`).
 * Log data is no longer included here; it is streamed via the WS log bus
 * or fetched from the stored-logs HTTP endpoint.
 *
 * @param {string|number} processId
 * @returns {Promise<{ process: object, customMetrics: { name: string, value: number, unit: string | null }[] } | null>}
 *   Detail payload, or null if not found.
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
    customMetrics: extractCustomMetrics(proc),
  };
}

/**
 * Restart a PM2 process by id.
 *
 * @param {string|number} processId
 * @returns {Promise<void>}
 */
export async function restartProcess(processId) {
  await withConnection(() => pm2Restart(String(processId)));
}

/**
 * Stop a PM2 process by id without removing it from PM2.
 *
 * The process descriptor is kept in PM2's list with a `stopped` status so it
 * can be started again later.
 *
 * @param {string|number} processId
 * @returns {Promise<void>}
 */
export async function stopProcess(processId) {
  await withConnection(() => pm2Stop(String(processId)));
}

/**
 * Start an existing (stopped) PM2 process by name or id.
 *
 * Unlike {@link startProcess}, which launches a brand-new process from a
 * configuration object, this resumes a process that PM2 already knows about.
 *
 * @param {string|number} processId
 * @returns {Promise<void>}
 */
export async function startStoppedProcess(processId) {
  await withConnection(() => pm2Start(String(processId)));
}

/**
 * Start a new PM2 process from a configuration object.
 *
 * @param {object} options - pm2.start options (name, script, cwd, instances, env, etc.)
 * @returns {Promise<void>}
 */
export async function startProcess(options) {
  await withConnection(() => pm2Start(options));
}

/**
 * Delete a PM2 process by name or numeric id.
 *
 * @param {string | number} nameOrId
 * @returns {Promise<void>}
 */
export async function deleteProcess(nameOrId) {
  await withConnection(() => pm2Delete(String(nameOrId)));
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
  return withConnection(async () => {
    const hasParams = params !== undefined && params !== null && params !== '';
    return await pm2Trigger(String(processId), actionName, ...(hasParams ? [params] : []));
  });
}

/**
 * Send an IPC packet to a running process through the PM2 daemon.
 *
 * PM2 opens an IPC channel to every Node process it starts, so the target
 * needs no dependency to receive this: a `process.on('message')` listener is
 * enough, and PM2 delivers `type`, `topic` and `data` unchanged, adding the
 * process id as `id` itself.
 *
 * Delivery is fire and forget. The daemon confirms that it handed the packet
 * over, not that the application did anything with it, so callers that need
 * certainty must wait for an answer of their own.
 *
 * @param {string|number} pmId - PM2 process id.
 * @param {object} packet - Packet with at least `type`, `topic` and `data`.
 * @returns {Promise<void>}
 */
export async function sendDataToProcess(pmId, packet) {
  await withConnection(() => pm2SendData(pmId, packet));
}

/**
 * Read all current log lines for a PM2 process by name, sorted chronologically.
 *
 * Used for initial log backfill when monitoring is first enabled. Covers every
 * instance of a cluster app.
 *
 * @param {string} pm2Name - The PM2 process name.
 * @returns {Promise<{text: string, source: string}[]>} Lines sorted by timestamp prefix.
 */
export async function readLogLinesByName(pm2Name) {
  const processes = await loadProcessList();

  // In cluster mode without merge_logs every instance writes its own
  // `-<pm_id>.log` files, so read the files of all instances with this name.
  const seen = new Set();
  const logFiles = [];
  for (const proc of processes.filter((p) => p.name === pm2Name)) {
    for (const file of uniqueLogFiles(proc)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      logFiles.push(file);
    }
  }
  if (!logFiles.length) return [];

  const readResults = await Promise.all(logFiles.map(readLogFile));

  return mergeLogFileLines(readResults);
}

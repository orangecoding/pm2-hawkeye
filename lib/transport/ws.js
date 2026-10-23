/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unified WebSocket server for PM2-Hawkeye.
 *
 * A single endpoint `/ws/stream` multiplexes all real-time data:
 *   - Process list pushed every 3 seconds (always active).
 *   - Process details pushed every 3 seconds (while a process is selected).
 *   - Live log lines streamed from the PM2 bus (while a process is selected).
 *   - Heartbeat every 15 seconds to keep the connection alive.
 *
 * The client controls which process is being watched by sending:
 *   { type: "select",   data: { processId: string } }
 *   { type: "deselect" }
 */

import WebSocket, { WebSocketServer } from 'ws';
import { parseCookie } from 'cookie';
import config from '../config.js';
import { getAuthenticatedSession } from '../security/session.js';
import * as pm2 from '../service/pm2Service.js';
import { getAllMonitored, getByPm2Name, getAllAlertPrefs } from '../storage/monitoringStorage.js';
import { subscribeToLogs } from '../service/logBus.js';
import { getLastHostReading } from '../service/hostMetricsCollector.js';
import { sanitizeForLog } from '../security/security.js';
import logger from '../service/logger.js';

// Module-level WebSocket server reference, used by broadcastDeployProgress.
let _wss = null;

// Helpers ──────────────────────────────────────────────────────────────────

/** Send a JSON message on a WebSocket if it is still open. */
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// Unified stream ────────────────────────────────────────────────────────────

/**
 * Build the annotated process list: every PM2 process with its monitoring
 * state and alert preference, plus monitored names PM2 no longer runs
 * (orphans), sorted monitored, unmonitored, orphan, then by name. Shared by
 * the WebSocket push and `GET /api/processes`, so both always agree.
 *
 * @returns {Promise<object>} Payload with `items` and host details.
 */
export async function buildProcessList() {
  const processes = await pm2.loadProcessList();
  const normalised = processes.map(pm2.normalizeProcessSummary);
  const activeNames = new Set(normalised.map((p) => p.name));

  let monitoredRows = [];
  try {
    monitoredRows = getAllMonitored();
  } catch {
    // DB may not be ready in test environments - degrade gracefully.
  }

  const monitoredMap = new Map(monitoredRows.map((r) => [r.pm2_name, r]));

  let alertPrefs = [];
  try {
    alertPrefs = getAllAlertPrefs();
  } catch {
    // DB may not be ready in test environments.
  }
  const alertMap = new Map(alertPrefs.map((r) => [r.pm2_name, r.alerts_enabled !== 0]));

  const annotated = normalised.map((item) => {
    const row = monitoredMap.get(item.name);
    return {
      ...item,
      isMonitored: !!row,
      isOrphan: false,
      alertsEnabled: alertMap.get(item.name) ?? true,
    };
  });

  for (const row of monitoredRows) {
    if (!activeNames.has(row.pm2_name)) {
      annotated.push({
        id: null,
        name: row.pm2_name,
        status: 'orphan',
        cpu: 0,
        memory: 0,
        restarts: 0,
        uptime: null,
        isMonitored: true,
        isOrphan: true,
        alertsEnabled: alertMap.get(row.pm2_name) ?? true,
      });
    }
  }

  // Sort: monitored non-orphan (alpha) → unmonitored (alpha) → orphan (alpha)
  // Running processes always precede orphans regardless of monitoring state.
  annotated.sort((a, b) => {
    const rankA = a.isOrphan ? 2 : a.isMonitored ? 0 : 1;
    const rankB = b.isOrphan ? 2 : b.isMonitored ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return a.name.localeCompare(b.name, 'en');
  });

  return {
    host: config.HOST,
    port: config.PORT,
    processCount: annotated.length,
    generatedAt: Date.now(),
    items: annotated,
    hostCurrent: getLastHostReading(),
  };
}

/**
 * Build and send the annotated process list to the client.
 *
 * @param {import('ws').WebSocket} ws
 */
async function sendProcessList(ws) {
  try {
    send(ws, 'processes', await buildProcessList());
  } catch {
    // Ignore transient PM2 errors; next tick will retry.
  }
}

/**
 * Handle the single unified WebSocket stream.
 *
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, string>} cookies - Parsed request cookies, used to
 *   re-validate the backing session for the lifetime of the connection.
 */
function handleUnifiedStream(ws, cookies) {
  // Per-connection selection state.
  let selectionGeneration = 0;
  let detailInterval = null;
  let logUnsubscribe = null;

  // Liveness flag for the server-level ping/pong loop (see attachWebSocketServer).
  // A half-open connection that vanished without a close frame never resets this,
  // so the loop can terminate it and free its intervals and log subscription.
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  send(ws, 'connected', {});

  // Process list, always running.
  sendProcessList(ws);
  const processListInterval = setInterval(() => sendProcessList(ws), 3000);

  // Heartbeat: keeps the connection alive through proxies / NAT, and re-checks
  // that the backing session is still valid. A WebSocket is authenticated only
  // once at upgrade; without this the connection would keep streaming after the
  // session expired or was destroyed (e.g. by logout).
  const heartbeatInterval = setInterval(() => {
    if (!getAuthenticatedSession({ cookies })) {
      ws.close(4001, 'session expired');
      return;
    }
    send(ws, 'heartbeat', {});
  }, 15000);

  /**
   * Tear down the current per-process subscriptions.
   */
  function clearSelection() {
    if (detailInterval !== null) {
      clearInterval(detailInterval);
      detailInterval = null;
    }
    if (logUnsubscribe !== null) {
      logUnsubscribe();
      logUnsubscribe = null;
    }
  }

  /**
   * Start streaming details and live logs for `processId` (a pm_id, or a name).
   * A generation counter guards against races when the user switches
   * processes quickly while async resolution is still in flight, and against
   * work resuming after the socket closed.
   *
   * Every `details`, `snapshot` and `log` message carries the requested
   * `processId`, so the client can drop messages that were already in flight
   * for the process it just left.
   *
   * A process PM2 does not run (an orphan, kept only for its stored history)
   * gets no stream at all: there is nothing live to send.
   *
   * @param {string} processId
   */
  async function selectProcess(processId) {
    clearSelection();

    const generation = ++selectionGeneration;

    let proc;
    try {
      const processes = await pm2.loadProcessList();
      if (generation !== selectionGeneration) return;
      proc =
        processes.find((p) => String(p.pm_id) === processId) ?? processes.find((p) => p.name === processId) ?? null;
    } catch {
      if (generation === selectionGeneration) send(ws, 'error', { error: 'Failed to load process list' });
      return;
    }
    if (!proc) return;

    const pmId = proc.pm_id;
    const pm2Name = proc.name;

    // Details stream. When the process disappears (deleted), stop polling: the
    // process list push tells the client, which then selects another one.
    async function sendDetail() {
      try {
        const details = await pm2.loadProcessDetails(pmId);
        if (generation !== selectionGeneration) return;
        if (!details) {
          clearSelection();
          return;
        }
        send(ws, 'details', { ...details, processId });
      } catch {
        // Ignore transient PM2 errors; next tick will retry.
      }
    }

    await sendDetail();
    if (generation !== selectionGeneration) return;

    detailInterval = setInterval(sendDetail, 3000);

    // For non-monitored processes, send a one-shot snapshot of the current
    // log file.  Monitored processes load history via the HTTP endpoint.
    let monitoredRow = null;
    try {
      monitoredRow = getByPm2Name(pm2Name);
    } catch {
      // DB may not be ready in test environments.
    }

    if (!monitoredRow) {
      try {
        const lines = await pm2.readLogLinesByName(pm2Name);
        if (generation !== selectionGeneration) return;
        send(ws, 'snapshot', { processId, lines: lines.map((l) => ({ text: l.text })) });
      } catch {
        if (generation !== selectionGeneration) return;
        send(ws, 'snapshot', { processId, lines: [] });
      }
    }

    if (generation !== selectionGeneration) return;

    // Subscribe to the PM2 bus for live log events.
    logUnsubscribe = subscribeToLogs(pm2Name, ({ text }) => {
      send(ws, 'log', { processId, text });
    });
  }

  // Handle messages from the client.
  ws.on('message', (rawMsg) => {
    try {
      const { type, data } = JSON.parse(rawMsg.toString());
      if (type === 'select' && data?.processId != null && data.processId !== '') {
        selectProcess(String(data.processId));
      } else if (type === 'deselect') {
        clearSelection();
        selectionGeneration++;
      }
    } catch {
      // Ignore malformed messages.
    }
  });

  ws.on('close', () => {
    clearInterval(processListInterval);
    clearInterval(heartbeatInterval);
    // Bump the generation so a selectProcess still awaiting PM2 does not
    // resume after close and start an interval or log subscription nobody
    // would ever clear.
    selectionGeneration++;
    clearSelection();
  });
}

/**
 * Broadcast a deploy_progress message to all open authenticated clients.
 *
 * Called by deployRunner.js whenever a deployment step produces output or
 * changes status.  All connected sessions see deployment progress, which is
 * acceptable because there is a single admin user.
 *
 * @param {string} deploymentId - UUID of the deployment record.
 * @param {string} stage - Current stage name (clone, install, build, etc.).
 * @param {string} line - Output line text (may be empty for status-only events).
 * @param {string} status - 'running' | 'success' | 'error' | 'confirm'
 */
export function broadcastDeployProgress(deploymentId, stage, line, status) {
  if (!_wss) return;
  const payload = JSON.stringify({ type: 'deploy_progress', data: { deploymentId, stage, line, status } });
  for (const client of _wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Attach WebSocket server ───────────────────────────────────────────────────

const STREAM_PATH = '/ws/stream';

/** Interval between protocol-level ping frames used for dead-connection detection. */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Check that a WebSocket upgrade comes from a page served by this app.
 *
 * Browsers attach the session cookie to WebSocket upgrades and do not apply
 * CORS to them, and `SameSite=Strict` still lets another origin on the same
 * site through (another port on the same host, a sibling subdomain). Without
 * this check a page there could open the stream with the admin's cookie and
 * read every log line (cross-site WebSocket hijacking).
 *
 * The Origin host must equal the Host header, or `X-Forwarded-Host` when
 * `TRUST_PROXY` is on, since a reverse proxy may rewrite Host. Requests with no
 * Origin (non-browser clients) are allowed; they cannot ride a victim's
 * cookie.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [req.headers.host];
  if (config.TRUST_PROXY) {
    hosts.push(...String(req.headers['x-forwarded-host'] || '').split(','));
  }
  return hosts.some((host) => host && host.trim().toLowerCase() === originHost);
}

/**
 * Attach the unified WebSocket server to an existing HTTP server.
 *
 * @param {import('http').Server} server
 */
export function attachWebSocketServer(server) {
  _wss = new WebSocketServer({ noServer: true });

  // Protocol-level ping/pong sweep: terminate connections that did not answer
  // the previous ping (half-open sockets from laptop sleep, NAT timeouts, or
  // dropped networks never fire 'close' on their own), then ping the rest.
  // Terminating fires 'close', which tears down the per-connection intervals
  // and log subscription in handleUnifiedStream.
  const heartbeat = setInterval(() => {
    for (const ws of _wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  _wss.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (req, socket, head) => {
    if (!isAllowedOrigin(req)) {
      logger.warn(`[SECURITY] Rejected WebSocket upgrade from origin: ${sanitizeForLog(req.headers.origin)}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const cookies = parseCookie(req.headers.cookie || '');
    const session = getAuthenticatedSession({ cookies });
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (req.url === STREAM_PATH) {
      _wss.handleUpgrade(req, socket, head, (ws) => {
        handleUnifiedStream(ws, cookies);
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
}

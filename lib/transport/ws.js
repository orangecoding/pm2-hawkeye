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
import { parse as parseCookies } from 'cookie';
import config from '../config.js';
import { getAuthenticatedSession } from '../security/session.js';
import * as pm2 from '../service/pm2Service.js';
import { getAllMonitored, getByPm2Name, getAllAlertPrefs } from '../storage/monitoringStorage.js';
import { subscribeToLogs } from '../service/logBus.js';

// Helpers ──────────────────────────────────────────────────────────────────

/** Authenticate a WebSocket upgrade request via session cookie. */
function authenticate(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const cookies = parseCookies(cookieHeader);
  return getAuthenticatedSession({ cookies });
}

/** Send a JSON message on a WebSocket if it is still open. */
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// Unified stream ────────────────────────────────────────────────────────────

/**
 * Build and send the annotated process list to the client.
 *
 * @param {import('ws').WebSocket} ws
 */
async function sendProcessList(ws) {
  try {
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

    // Sort: monitored non-orphan (alpha) → orphan (alpha) → unmonitored (alpha)
    annotated.sort((a, b) => {
      const rankA = a.isOrphan ? 1 : a.isMonitored ? 0 : 2;
      const rankB = b.isOrphan ? 1 : b.isMonitored ? 0 : 2;
      if (rankA !== rankB) return rankA - rankB;
      return a.name.localeCompare(b.name, 'en');
    });

    send(ws, 'processes', {
      host: config.HOST,
      port: config.PORT,
      processCount: annotated.length,
      generatedAt: Date.now(),
      items: annotated,
    });
  } catch {
    // Ignore transient PM2 errors; next tick will retry.
  }
}

/**
 * Handle the single unified WebSocket stream.
 *
 * @param {import('ws').WebSocket} ws
 */
function handleUnifiedStream(ws) {
  // Per-connection selection state.
  let selectionGeneration = 0;
  let detailInterval = null;
  let logUnsubscribe = null;

  send(ws, 'connected', {});

  // Process list — always running.
  sendProcessList(ws);
  const processListInterval = setInterval(() => sendProcessList(ws), 3000);

  // Heartbeat — keeps the connection alive through proxies / NAT.
  const heartbeatInterval = setInterval(() => send(ws, 'heartbeat', {}), 15000);

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
   * Start streaming details and live logs for `processId`.
   * A generation counter guards against races when the user switches
   * processes quickly while async resolution is still in flight.
   *
   * @param {string} processId
   */
  async function selectProcess(processId) {
    clearSelection();

    const generation = ++selectionGeneration;

    // Details stream.
    async function sendDetail() {
      try {
        const details = await pm2.loadProcessDetails(processId);
        if (generation !== selectionGeneration) return; // superseded
        if (!details) {
          send(ws, 'error', { error: 'Process not found' });
          return;
        }
        send(ws, 'details', details);
      } catch {
        // Ignore transient PM2 errors; next tick will retry.
      }
    }

    await sendDetail();
    if (generation !== selectionGeneration) return;

    detailInterval = setInterval(sendDetail, 3000);

    // Resolve PM2 name for log subscription.
    let pm2Name;
    try {
      const processes = await pm2.loadProcessList();
      if (generation !== selectionGeneration) return;
      const proc = processes.find((p) => String(p.pm_id) === String(processId) || p.name === processId);
      if (!proc) {
        send(ws, 'error', { error: 'Process not found' });
        return;
      }
      pm2Name = proc.name;
    } catch {
      send(ws, 'error', { error: 'Failed to load process list' });
      return;
    }

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
        send(ws, 'snapshot', { lines: lines.map((l) => ({ text: l.text })) });
      } catch {
        if (generation !== selectionGeneration) return;
        send(ws, 'snapshot', { lines: [] });
      }
    }

    if (generation !== selectionGeneration) return;

    // Subscribe to the PM2 bus for live log events.
    logUnsubscribe = subscribeToLogs(pm2Name, ({ text }) => {
      send(ws, 'log', { text });
    });
  }

  // Handle messages from the client.
  ws.on('message', (rawMsg) => {
    try {
      const { type, data } = JSON.parse(rawMsg.toString());
      if (type === 'select' && data?.processId) {
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
    clearSelection();
  });
}

// Attach WebSocket server ───────────────────────────────────────────────────

const STREAM_PATH = '/ws/stream';

/**
 * Attach the unified WebSocket server to an existing HTTP server.
 *
 * @param {import('http').Server} server
 */
export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const session = authenticate(req);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (req.url === STREAM_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleUnifiedStream(ws);
      });
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
}

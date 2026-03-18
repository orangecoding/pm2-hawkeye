/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * wsWebSocket server for PM2 Manager.
 *
 * Handles two upgrade paths:
 *   /ws/processes/stream    pushes updated process list every 3 seconds
 *   /ws/processes/:id/logs  streams live log lines for a given process
 */

import WebSocket, { WebSocketServer } from 'ws';
import { parse as parseCookies } from 'cookie';
import config from '../config.js';
import { getAuthenticatedSession } from '../security/session.js';
import * as pm2 from '../service/pm2Service.js';
import { getAllMonitored, getByPm2Name } from '../storage/monitoringStorage.js';
import { subscribeToLogs } from '../service/logBus.js';

// Helpers ──────────────────────────────────────────────────────────────────

/** Authenticate a WebSocket upgrade request via session cookie. */
function authenticate(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const cookies = parseCookies(cookieHeader);
  // getAuthenticatedSession expects req.cookies
  return getAuthenticatedSession({ cookies });
}

/** Send a JSON message on a WebSocket if it is still open. */
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// Process list stream ───────────────────────────────────────────────────────

function handleProcessStream(ws) {
  send(ws, 'connected', {});

  async function sendUpdate() {
    try {
      const processes = await pm2.loadProcessList();
      const normalised = processes.map(pm2.normalizeProcessSummary);
      const activeNames = new Set(normalised.map((p) => p.name));

      // Fetch current monitoring state from the database.
      let monitoredRows = [];
      try {
        monitoredRows = getAllMonitored();
      } catch {
        // DB may not be ready in test environments - degrade gracefully.
      }

      const monitoredMap = new Map(monitoredRows.map((r) => [r.pm2_name, r]));

      // Annotate each real process with monitoring metadata.
      const annotated = normalised.map((item) => {
        const row = monitoredMap.get(item.name);
        return {
          ...item,
          isMonitored: !!row,
          isOrphan: false,
        };
      });

      // Inject synthetic orphan entries for monitored processes that have
      // disappeared from PM2.
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

  sendUpdate();
  const interval = setInterval(sendUpdate, 3000);

  ws.on('close', () => clearInterval(interval));
}

// Log stream ────────────────────────────────────────────────────────────────


/**
 * Handle a WebSocket log stream connection for a PM2 process.
 *
 * For non-monitored processes, sends a one-shot `snapshot` message with the
 * current log file contents, then streams live log events from the PM2 bus.
 * For monitored processes, skips the snapshot (stored history is loaded via
 * the HTTP endpoint) and goes straight to live streaming.
 *
 * @param {import('ws').WebSocket} ws
 * @param {string} processId - PM2 numeric ID or process name.
 * @returns {Promise<void>}
 */
async function handleLogStream(ws, processId) {
  // Resolve the process to get its canonical PM2 name.
  let pm2Name;
  try {
    const processes = await pm2.loadProcessList();
    const proc = processes.find(
      (p) => String(p.pm_id) === String(processId) || p.name === processId,
    );
    if (!proc) {
      send(ws, 'error', { error: 'Process not found' });
      ws.close();
      return;
    }
    pm2Name = proc.name;
  } catch {
    send(ws, 'error', { error: 'Failed to load process list' });
    ws.close();
    return;
  }

  send(ws, 'connected', { processId, name: pm2Name });

  // For non-monitored processes send the current log file contents as a
  // one-shot snapshot so the viewer has context immediately.  Monitored
  // processes load their history via the stored-logs HTTP endpoint.
  let monitoredRow = null;
  try {
    monitoredRow = getByPm2Name(pm2Name);
  } catch {
    // DB may not be ready in test environments.
  }

  if (!monitoredRow) {
    try {
      const lines = await pm2.readLogLinesByName(pm2Name);
      send(ws, 'snapshot', { lines: lines.map((l) => ({ text: l.text })) });
    } catch {
      send(ws, 'snapshot', { lines: [] });
    }
  }

  // Subscribe to the PM2 bus for live log events.
  const unsubscribe = subscribeToLogs(pm2Name, ({ text }) => {
    send(ws, 'log', { text });
  });

  const heartbeat = setInterval(() => send(ws, 'heartbeat', {}), 15000);

  ws.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// Process detail stream ────────────────────────────────────────────────────

async function handleProcessDetailStream(ws, processId) {
  send(ws, 'connected', { processId });

  async function sendUpdate() {
    try {
      const details = await pm2.loadProcessDetails(processId);
      if (!details) {
        send(ws, 'error', { error: 'Process not found' });
        return;
      }
      send(ws, 'details', details);
    } catch {
      // Ignore transient PM2 errors; next tick will retry.
    }
  }

  sendUpdate();
  const interval = setInterval(sendUpdate, 3000);

  ws.on('close', () => clearInterval(interval));
}

// Attach WebSocket server ───────────────────────────────────────────────────

const PROCESS_STREAM_PATH = '/ws/processes/stream';
const LOG_STREAM_RE = /^\/ws\/processes\/([a-zA-Z0-9_-]+)\/logs$/;
const PROCESS_DETAIL_RE = /^\/ws\/processes\/([a-zA-Z0-9_-]+)\/details$/;

export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url;

    // Authenticate
    const session = authenticate(req);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url === PROCESS_STREAM_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleProcessStream(ws);
      });
      return;
    }

    const logMatch = LOG_STREAM_RE.exec(url);
    if (logMatch) {
      const processId = logMatch[1];
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleLogStream(ws, processId);
      });
      return;
    }

    const detailMatch = PROCESS_DETAIL_RE.exec(url);
    if (detailMatch) {
      const processId = detailMatch[1];
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleProcessDetailStream(ws, processId);
      });
      return;
    }

    // Unknown path
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });
}

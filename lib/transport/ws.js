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

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { parse as parseCookies } from 'cookie';
import config from '../config.js';
import { getAuthenticatedSession } from '../security/session.js';
import * as pm2 from '../service/pm2Service.js';


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
      const items = processes
        .map(pm2.normalizeProcessSummary)
        .sort((left, right) => left.name.localeCompare(right.name, 'en'));

      send(ws, 'processes', {
        host: config.HOST,
        port: config.PORT,
        processCount: items.length,
        generatedAt: Date.now(),
        items,
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
 * Extract the first ISO-like timestamp found anywhere in a log line.
 * Matches formats like `2026-03-14T16:25:41` or `2026-03-14 16:25:41`.
 * Returns an empty string when no timestamp is present.
 *
 * @param {string} line
 * @returns {string}
 */
function extractTimestamp(line) {
  return line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/)?.[1] ?? '';
}

async function handleLogStream(ws, processId) {
  const logPaths = await pm2.getLogPaths(processId);

  send(ws, 'connected', { processId, files: logPaths.length });

  if (!logPaths.length) {
    send(ws, 'error', { error: 'No log files found' });
    ws.close();
    return;
  }

  // Initialise known file sizes so we only stream new bytes going forward.
  const fileSizes = new Map(
    logPaths.map((p) => {
      try {
        return [p, fs.statSync(p).size];
      } catch {
        return [p, 0];
      }
    }),
  );

  let debounceTimer = null;

  // Shared handler: called when any watched file changes.
  // Reads new bytes from ALL files, sorts all new lines by timestamp, sends.
  async function sendNewLines() {
    const lines = [];

    for (const filePath of logPaths) {
      try {
        const stat = await fsp.stat(filePath);
        const previousSize = fileSizes.get(filePath) ?? stat.size;
        if (stat.size <= previousSize) {
          fileSizes.set(filePath, stat.size);
          continue;
        }
        const handle = await fsp.open(filePath, 'r');
        try {
          const length = stat.size - previousSize;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, previousSize);
          for (const line of buffer.toString('utf8').split(/\r?\n/).filter((l) => l.length > 0)) {
            lines.push(line);
          }
        } finally {
          await handle.close();
        }
        fileSizes.set(filePath, stat.size);
      } catch {
        // Ignore transient errors (log rotation, etc.)
      }
    }

    lines.sort((a, b) => {
      const tsA = extractTimestamp(a);
      const tsB = extractTimestamp(b);
      return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
    });

    for (const line of lines) {
      send(ws, 'log', { text: line });
    }
  }

  function onFileChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(sendNewLines, 80);
  }

  const watchers = logPaths
    .map((filePath) => {
      try {
        return fs.watch(filePath, onFileChange);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const heartbeat = setInterval(() => send(ws, 'heartbeat', {}), 15000);

  ws.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(debounceTimer);
    watchers.forEach((w) => w.close());
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
const LOG_STREAM_RE = /^\/ws\/processes\/([a-zA-Z0-9_\-]+)\/logs$/;
const PROCESS_DETAIL_RE = /^\/ws\/processes\/([a-zA-Z0-9_\-]+)\/details$/;

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

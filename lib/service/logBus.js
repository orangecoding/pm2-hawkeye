/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * PM2 log bus service.
 *
 * Opens a single PM2 pub/sub bus connection that receives all process log
 * events in real time.  Each event is:
 *   1. Persisted to the database when the originating process is monitored.
 *   2. Forwarded to any active WebSocket subscribers for that process.
 *
 * The bus is started once at server startup via `startLogBus`.
 */

import EventEmitter from 'node:events';
import { promisify } from 'node:util';
import pm2 from 'pm2';
import { extractTimestamp } from './pm2Service.js';
import { detectLogLevel } from './logLevel.js';
import { getByPm2Name } from '../storage/monitoringStorage.js';
import { insertLogEntry } from '../storage/logStorage.js';
import logger from './logger.js';

const pm2Connect = promisify(pm2.connect.bind(pm2));
const pm2LaunchBus = promisify(pm2.launchBus.bind(pm2));

/** Internal event emitter -- one 'log' event per line for all processes. */
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

let started = false;

/**
 * Start the PM2 log bus listener.  Safe to call multiple times (idempotent).
 *
 * Must be called after the DB is initialised and PM2 is reachable.
 *
 * @returns {Promise<void>}
 */
export async function startLogBus() {
  if (started) return;
  started = true;

  try {
    // pm2.connect is idempotent -- reuses existing connection from pm2Service.
    await pm2Connect();
    const bus = await pm2LaunchBus();

    /**
     * Handle a raw PM2 bus packet.
     *
     * @param {object} packet
     */
    function handlePacket(packet) {
      const appName = packet.process?.name;
      if (!appName) return;

      const rawData = String(packet.data ?? '');
      const at = typeof packet.at === 'number' && packet.at > 0 ? packet.at : Date.now();

      // PM2 may buffer several lines in one packet; split defensively.
      const lines = rawData.split(/\r?\n/).filter((l) => l.length > 0);

      for (const text of lines) {
        // --- Persist when the process is being monitored ---
        try {
          const row = getByPm2Name(appName);
          if (row) {
            const ts = extractTimestamp(text);
            const loggedAt = ts ? new Date(ts.replace(' ', 'T')).getTime() || at : at;
            const logLevel = detectLogLevel(text);
            insertLogEntry(row.id, {
              loggedAt,
              logLevel,
              log: JSON.stringify({ lines: [text], raw: text }),
            });
          }
        } catch {
          // Never let a storage error affect the live stream.
        }

        // --- Notify WebSocket subscribers ---
        emitter.emit('log', { appName, text });
      }
    }

    bus.on('log:out', handlePacket);
    bus.on('log:err', handlePacket);

    bus.on('error', (err) => {
      logger.warn(`[LOG_BUS] Bus error: ${err?.message ?? err}`);
    });

    logger.info('[LOG_BUS] Started');
  } catch (err) {
    logger.warn(`[LOG_BUS] Failed to start: ${err.message}`);
    started = false; // allow a retry on next call
  }
}

/**
 * Subscribe to live log events for a specific PM2 process.
 *
 * @param {string} appName - PM2 process name.
 * @param {(event: {appName: string, text: string}) => void} handler
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeToLogs(appName, handler) {
  /** @param {{ appName: string, text: string }} event */
  const filter = (event) => {
    if (event.appName === appName) handler(event);
  };
  emitter.on('log', filter);
  return () => emitter.off('log', filter);
}

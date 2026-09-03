/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Runtime log level service.
 *
 * Node has no log level concept reachable from outside a process: console has
 * no levels, `util.debuglog` caches `NODE_DEBUG` on first use, and there is no
 * API to mutate another process's environment. Every logger can change its
 * level at runtime, but only from the inside. So the target process has to
 * cooperate: it listens for a `hawkeye:log-level` message, sets its logger's
 * level, and answers with a `hawkeye:log-level:ack` packet carrying the level
 * it actually ended up with. See the README for the listener.
 *
 * The acknowledged level is held in memory only. It is deliberately not
 * persisted: after a Hawkeye restart the real level is unknown, and reporting
 * 'unknown' is the honest answer.
 */

import { sendDataToProcess } from './pm2Service.js';

/** Levels Hawkeye will send, ordered from most to least verbose. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/** Topic of the message Hawkeye sends to a process. */
export const REQUEST_TOPIC = 'hawkeye:log-level';

/**
 * Type of the answer a cooperating process sends back.
 *
 * PM2 strips `topic` from anything a process sends to the daemon and emits the
 * packet on a bus event named after its `type`, so this doubles as the bus
 * event name. Verified against pm2 6.0.14.
 */
export const ACK_EVENT = 'hawkeye:log-level:ack';

/** How long to wait for an acknowledgement before giving up, in ms. */
const ACK_TIMEOUT_MS = 1500;

/**
 * Canonicalise a requested log level.
 *
 * @param {unknown} value
 * @returns {string|null} The canonical level, or null when unsupported.
 */
export function normalizeLevel(value) {
  if (typeof value !== 'string') return null;
  const level = value.trim().toLowerCase();
  return LOG_LEVELS.includes(level) ? level : null;
}

/**
 * Build a log level channel over a transport.
 *
 * The transport is injected rather than imported so the async lifecycle can be
 * tested without a PM2 daemon.
 *
 * @param {(pmId: string|number, packet: object) => Promise<void>} send
 * @param {{ ackTimeoutMs?: number }} [options]
 * @returns {{
 *   getState: (pmId: string|number, pmUptime: number) => object|null,
 *   handleAck: (packet: object) => void,
 *   setLevel: (pmId: string|number, pmUptime: number, level: string) => Promise<object>,
 *   queryLevel: (pmId: string|number, pmUptime: number) => Promise<object>,
 * }}
 */
export function createLogLevelChannel(send, options = {}) {
  const ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;

  /** @type {Map<string, { level: string, ackAt: number, pmUptime: number }>} */
  const state = new Map();

  /**
   * One in-flight request per process, keyed by pm_id.
   *
   * Keying on the process rather than on a request id is what keeps the
   * application contract at ten lines: the listener does not have to echo
   * anything back. The cost is that a second request for the same process
   * cancels the first, which is what a user clicking two levels in a row
   * means anyway.
   *
   * @type {Map<string, { resolve: Function, timer: NodeJS.Timeout, pmUptime: number }>}
   */
  const pending = new Map();

  /**
   * Read the last acknowledged level for a process.
   *
   * The entry records the `pm_uptime` it was acknowledged for. A restart gives
   * the process a new `pm_uptime`, which makes the entry stale and drops it.
   * That is the whole restart-reset mechanism: no timer, no restart event, and
   * correct across a PM2 daemon restart too.
   *
   * @param {string|number} pmId
   * @param {number} pmUptime
   * @returns {{ level: string, ackAt: number, pmUptime: number }|null}
   */
  function getState(pmId, pmUptime) {
    const key = String(pmId);
    const entry = state.get(key);
    if (!entry) return null;
    if (entry.pmUptime !== pmUptime) {
      state.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Settle a pending request and stop its timeout.
   *
   * @param {string} key
   * @param {object} answer
   * @returns {void}
   */
  function settle(key, answer) {
    const request = pending.get(key);
    if (!request) return;
    pending.delete(key);
    clearTimeout(request.timer);
    request.resolve(answer);
  }

  /**
   * Handle an acknowledgement that arrived on the PM2 bus.
   *
   * Packets whose level Hawkeye does not know are dropped rather than stored,
   * so a misbehaving listener cannot put a bogus level on the dashboard. The
   * pending request then times out and the UI reports no answer, which is the
   * truthful outcome.
   *
   * @param {object} packet - Raw acknowledgement packet from the PM2 bus.
   * @returns {void}
   */
  function handleAck(packet) {
    const pmId = packet?.process?.pm_id;
    const level = normalizeLevel(packet?.data?.level);
    if (pmId === undefined || pmId === null || !level) return;

    const key = String(pmId);
    const request = pending.get(key);
    if (!request) return;

    const ackAt = Date.now();
    state.set(key, { level, ackAt, pmUptime: request.pmUptime });
    settle(key, { ok: true, level, ackAt });
  }

  /**
   * Send a log level message and wait for the process to answer.
   *
   * @param {string|number} pmId
   * @param {number} pmUptime
   * @param {string|null} level - null asks the process to report only.
   * @returns {Promise<object>}
   */
  async function request(pmId, pmUptime, level) {
    const key = String(pmId);
    settle(key, { ok: false, reason: 'superseded' });

    // The pending entry is registered synchronously here, inside the Promise
    // executor, so it exists before the first await below. An acknowledgement
    // that arrives while the send is still in flight is therefore never lost.
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        resolve({ ok: false, reason: 'no-ack' });
      }, ackTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(key, { resolve, timer, pmUptime });
    });

    const packet = {
      type: 'process:msg',
      topic: REQUEST_TOPIC,
      data: level ? { level } : {},
    };

    try {
      await send(pmId, packet);
    } catch (err) {
      const failed = pending.get(key);
      if (failed) {
        pending.delete(key);
        clearTimeout(failed.timer);
      }
      throw err;
    }

    return answer;
  }

  return {
    getState,
    handleAck,
    /**
     * Set the log level of a running process.
     *
     * @param {string|number} pmId
     * @param {number} pmUptime
     * @param {string} level - Must already be canonical, see normalizeLevel.
     * @returns {Promise<object>}
     */
    setLevel: (pmId, pmUptime, level) => request(pmId, pmUptime, level),
    /**
     * Ask a running process which level it is on, changing nothing.
     *
     * @param {string|number} pmId
     * @param {number} pmUptime
     * @returns {Promise<object>}
     */
    queryLevel: (pmId, pmUptime) => request(pmId, pmUptime, null),
  };
}

/** The channel the application uses, bound to the PM2 transport. */
const channel = createLogLevelChannel((pmId, packet) => sendDataToProcess(pmId, packet));

export const { setLevel, queryLevel, handleAck, getState } = channel;

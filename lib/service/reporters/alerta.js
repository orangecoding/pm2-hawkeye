/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * alerta reporter.
 *
 * Sends alert payloads to an alerta server (POST /api/notify), which forwards them as Home
 * Assistant pushes to the configured targets. Every PM2 process becomes its own alerta topic
 * (`hawkeye-<process name>`), so alerta's inbox lists each app separately.
 */

/**
 * @typedef {Object} AlertPayload
 * @property {string} log_level
 * @property {string} log
 * @property {string} time
 * @property {string} process_name
 */

/**
 * @typedef {Object} AlertaConfig
 * @property {string} url - alerta's base URL, e.g. https://alerta.example.com
 * @property {string} apiKey
 * @property {string} targets - comma-separated target names as configured in alerta
 * @property {string} priority - passive | active | time-sensitive | critical
 */

// alerta's own limits for these fields.
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TITLE_LENGTH = 256;
const MAX_TOPIC_LENGTH = 64;

// Marks Hawkeye's topics in an alerta inbox shared with other senders. alerta allows no ':' here.
const TOPIC_PREFIX = 'hawkeye-';

/**
 * Turn a PM2 process name into an alerta topic, which allows only [A-Za-z0-9_-]{1,64}. The name
 * is prefixed with `hawkeye-` and cut so that prefix and name together fit the 64 characters.
 *
 * @param {string} processName
 * @returns {string}
 */
export function toAlertaTopic(processName) {
  const name = String(processName)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TOPIC_LENGTH - TOPIC_PREFIX.length);
  return TOPIC_PREFIX + (name || 'pm2');
}

/**
 * @param {string} targets - comma-separated
 * @returns {string[]}
 */
export function parseTargets(targets) {
  return [
    ...new Set(
      String(targets ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * POST one push to alerta. alerta answers errors as { error: { code, message } }; that message
 * (e.g. "Unknown target: oma (known: chriz, katha)") is what ends up in the thrown error.
 *
 * @param {AlertaConfig} config
 * @param {AlertPayload} payload
 * @returns {Promise<number>} the HTTP status of the accepted push
 */
async function deliver(config, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${config.url.trim().replace(/\/+$/, '')}/api/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        targets: parseTargets(config.targets),
        topic: toAlertaTopic(payload.process_name),
        title: `[${payload.log_level.toUpperCase()}] ${payload.process_name}`.slice(0, MAX_TITLE_LENGTH),
        message: `${payload.time}\n${payload.log}`.slice(0, MAX_MESSAGE_LENGTH),
        priority: config.priority || 'active',
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = body?.error?.message ? `: ${body.error.message}` : '';
      throw new Error(`alerta responded with HTTP ${response.status}${detail}`);
    }
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST an alert payload to alerta.
 *
 * @param {AlertaConfig} config
 * @param {AlertPayload} payload
 * @returns {Promise<void>}
 */
export async function sendAlerta(config, payload) {
  await deliver(config, payload);
}

/**
 * Send a sample test push through alerta and return a result object.
 *
 * @param {AlertaConfig} config
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function testAlerta(config) {
  try {
    const status = await deliver(config, {
      log_level: 'error',
      process_name: 'test-process',
      log: 'Error: this is a test alert from pm2-hawkeye',
      time: new Date().toISOString(),
    });
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

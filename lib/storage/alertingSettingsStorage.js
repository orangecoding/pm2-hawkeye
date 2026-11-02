/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for alerting configuration.
 *
 * All alerting config is stored in the `alerting_settings` key-value table.
 * General application settings remain in the `.env` file.
 */

import { getDb } from './db.js';

/**
 * Retrieve a single alerting setting by key.
 *
 * @param {string} key
 * @returns {string | null}
 */
export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM alerting_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Retrieve all alerting settings as a plain record.
 *
 * @returns {Record<string, string>}
 */
export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM alerting_settings').all();
  /** @type {Record<string, string>} */
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Upsert a single alerting setting.
 *
 * @param {string} key
 * @param {string} value
 */
export function setSetting(key, value) {
  getDb()
    .prepare(
      'INSERT INTO alerting_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, value, Date.now());
}

/**
 * Atomically upsert multiple alerting settings inside a single transaction.
 *
 * @param {Record<string, string>} map - Key-value pairs to upsert.
 */
export function setSettings(map) {
  const stmt = getDb().prepare(
    'INSERT INTO alerting_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  getDb().transaction(() => {
    const now = Date.now();
    for (const [key, value] of Object.entries(map)) {
      stmt.run(key, value, now);
    }
  })();
}

/**
 * Retrieve a JSON-parsed alerting setting.
 *
 * Returns `def` if the key is absent or if JSON parsing fails.
 *
 * @template T
 * @param {string} key
 * @param {T} def - Default value returned on miss or parse failure.
 * @returns {T}
 */
export function getSettingJson(key, def) {
  const raw = getSetting(key);
  if (raw === null) return def;
  try {
    return JSON.parse(raw);
  } catch {
    return def;
  }
}

/**
 * @typedef {Object} WebhookConfig
 * @property {boolean} enabled
 * @property {string} url
 * @property {{ key: string, value: string }[]} headers
 * @property {{ key: string, value: string }[]} body
 */

/**
 * @typedef {Object} NtfyConfig
 * @property {boolean} enabled
 * @property {string} serverUrl
 * @property {string} topic
 * @property {string} priority
 * @property {string} token
 */

/**
 * @typedef {Object} AlertaConfig
 * @property {boolean} enabled
 * @property {string} url
 * @property {string} apiKey
 * @property {string} targets - comma-separated
 * @property {string} priority
 */

/**
 * @typedef {Object} AlertingConfig
 * @property {'every' | 'throttle'} mode
 * @property {number} throttleMinutes
 * @property {string[]} logLevelThreshold
 * @property {WebhookConfig} webhook
 * @property {NtfyConfig} ntfy
 * @property {AlertaConfig} alerta
 */

/**
 * Build a fully-typed alerting config object with safe defaults for any
 * missing keys.
 *
 * @returns {AlertingConfig}
 */
export function getAlertingConfig() {
  const mode = getSetting('alert.mode') ?? 'every';
  const throttleMinutes = parseInt(getSetting('alert.throttleMinutes') ?? '60', 10);
  const logLevelThreshold = getSettingJson('alert.logLevelThreshold', ['error']);

  const webhookEnabled = getSetting('reporter.webhook.enabled') === '1';
  const webhookUrl = getSetting('reporter.webhook.url') ?? '';
  const webhookHeaders = getSettingJson('reporter.webhook.headers', []);
  const webhookBody = getSettingJson('reporter.webhook.body', []);

  const ntfyEnabled = getSetting('reporter.ntfy.enabled') === '1';
  const ntfyServerUrl = getSetting('reporter.ntfy.serverUrl') ?? 'https://ntfy.sh';
  const ntfyTopic = getSetting('reporter.ntfy.topic') ?? '';
  const ntfyPriority = getSetting('reporter.ntfy.priority') ?? 'default';
  const ntfyToken = getSetting('reporter.ntfy.token') ?? '';

  const alertaEnabled = getSetting('reporter.alerta.enabled') === '1';
  const alertaUrl = getSetting('reporter.alerta.url') ?? '';
  const alertaApiKey = getSetting('reporter.alerta.apiKey') ?? '';
  const alertaTargets = getSetting('reporter.alerta.targets') ?? '';
  const alertaPriority = getSetting('reporter.alerta.priority') ?? 'active';

  return {
    mode: mode === 'throttle' ? 'throttle' : 'every',
    throttleMinutes: Number.isFinite(throttleMinutes) ? throttleMinutes : 60,
    logLevelThreshold: Array.isArray(logLevelThreshold) ? logLevelThreshold : ['error'],
    webhook: {
      enabled: webhookEnabled,
      url: webhookUrl,
      headers: Array.isArray(webhookHeaders) ? webhookHeaders : [],
      body: Array.isArray(webhookBody) ? webhookBody : [],
    },
    ntfy: {
      enabled: ntfyEnabled,
      serverUrl: ntfyServerUrl,
      topic: ntfyTopic,
      priority: ntfyPriority,
      token: ntfyToken,
    },
    alerta: {
      enabled: alertaEnabled,
      url: alertaUrl,
      apiKey: alertaApiKey,
      targets: alertaTargets,
      priority: alertaPriority,
    },
  };
}

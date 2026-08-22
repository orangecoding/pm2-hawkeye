/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Alerting service.
 *
 * Evaluates incoming log events against the current alerting configuration and
 * dispatches to enabled reporters.  An in-memory throttle map prevents alert
 * flooding when mode is set to 'throttle'.
 */

import { getAlertingConfig } from '../storage/alertingSettingsStorage.js';
import { getAlertsEnabled } from '../storage/monitoringStorage.js';
import { sendWebhook } from './reporters/webhook.js';
import { sendNtfy } from './reporters/ntfy.js';
import logger from './logger.js';

/** @type {Map<string, number>} pm2Name -> last alert timestamp (ms) */
const lastAlertAt = new Map();

/**
 * @typedef {Object} AlertPayload
 * @property {string} log_level
 * @property {string} log
 * @property {string} time
 * @property {string} process_name
 */

/**
 * @typedef {Object} Reporter
 * @property {(config: object, payload: AlertPayload) => Promise<void>} send
 * @property {object} config
 * @property {string} name
 */

/**
 * Build the list of reporters that are enabled in the current configuration.
 *
 * @param {object} config - Result of getAlertingConfig().
 * @returns {Reporter[]}
 */
function buildReporters(config) {
  return [
    config.webhook.enabled ? { name: 'webhook', send: sendWebhook, config: config.webhook } : null,
    config.ntfy.enabled ? { name: 'ntfy', send: sendNtfy, config: config.ntfy } : null,
  ].filter(Boolean);
}

/**
 * Send a payload to every reporter concurrently, logging individual failures
 * so one broken reporter never blocks the others.
 *
 * @param {Reporter[]} reporters
 * @param {AlertPayload} payload
 * @param {string} pm2Name - Used for log context only.
 * @returns {Promise<void>}
 */
async function dispatchAll(reporters, payload, pm2Name) {
  await Promise.allSettled(
    reporters.map(async (reporter) => {
      try {
        await reporter.send(reporter.config, payload);
      } catch (err) {
        logger.warn(`[ALERTING] Reporter "${reporter.name}" failed for ${pm2Name}: ${err.message}`);
      }
    }),
  );
}

/**
 * Evaluate a log event and dispatch to enabled reporters if conditions are met.
 *
 * Steps:
 *  1. Load fresh config from DB.
 *  2. Return early if no reporters are enabled.
 *  3. Return early if alerts are disabled for this process.
 *  4. Return early if the log level is not in the threshold set.
 *  5. Apply throttle if configured.
 *  6. Build payload and dispatch to all enabled reporters concurrently.
 *
 * The optional `_reporters` parameter replaces the default reporters, enabling
 * clean unit testing without module-level mocking.
 *
 * @param {string} pm2Name - PM2 process name.
 * @param {string | null | undefined} logLevel - Detected log level.
 * @param {string} logText - Raw log line text.
 * @param {Reporter[] | null} [_reporters] - Override reporters for testing.
 * @returns {Promise<void>}
 */
export async function evaluateAndDispatch(pm2Name, logLevel, logText, _reporters = null) {
  const config = getAlertingConfig();

  const reporters = _reporters ?? buildReporters(config);

  if (reporters.length === 0) return;

  if (!getAlertsEnabled(pm2Name)) return;

  const effectiveLevel = logLevel ?? 'info';
  if (!config.logLevelThreshold.includes(effectiveLevel)) return;

  if (config.mode === 'throttle') {
    const last = lastAlertAt.get(pm2Name);
    if (last !== undefined) {
      const windowMs = config.throttleMinutes * 60 * 1000;
      if (Date.now() - last < windowMs) return;
    }
  }

  lastAlertAt.set(pm2Name, Date.now());

  /** @type {AlertPayload} */
  const payload = {
    log_level: effectiveLevel,
    log: logText,
    time: new Date().toISOString(),
    process_name: pm2Name,
  };

  await dispatchAll(reporters, payload, pm2Name);
}

/**
 * Send a notification about the outcome of an unattended deployment.
 *
 * Unlike log alerts this deliberately ignores the log-level threshold, the
 * throttle window, and the per-process alerts toggle: those gate log lines, and
 * a deploy result is not a log line.  Only the reporters enabled in the
 * alerting settings decide whether anything is sent at all.
 *
 * @param {string} pm2Name - PM2 process name the deployment belongs to.
 * @param {'info' | 'error'} level - Outcome level.
 * @param {string} message - Human-readable outcome text.
 * @param {Reporter[] | null} [_reporters] - Override reporters for testing.
 * @returns {Promise<void>}
 */
export async function dispatchDeployNotification(pm2Name, level, message, _reporters = null) {
  const reporters = _reporters ?? buildReporters(getAlertingConfig());
  if (reporters.length === 0) return;

  /** @type {AlertPayload} */
  const payload = {
    log_level: level,
    log: message,
    time: new Date().toISOString(),
    process_name: pm2Name,
  };

  await dispatchAll(reporters, payload, pm2Name);
}

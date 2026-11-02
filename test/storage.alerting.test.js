/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for alerting storage modules.
 *
 * All tests operate on the in-memory SQLite database initialised in setup.mjs.
 */

import { strict as assert } from 'node:assert';
import {
  getSetting,
  getAllSettings,
  setSetting,
  setSettings,
  getSettingJson,
  getAlertingConfig,
} from '../lib/storage/alertingSettingsStorage.js';
import {
  addMonitored,
  getAlertsEnabled,
  setAlertsEnabled,
  getAllAlertPrefs,
} from '../lib/storage/monitoringStorage.js';
import { getDb } from '../lib/storage/db.js';

/** Remove all rows from alerting and monitoring tables between tests. */
function cleanDb() {
  const db = getDb();
  db.prepare('DELETE FROM alerting_settings').run();
  db.prepare('DELETE FROM log_entries').run();
  db.prepare('DELETE FROM metrics_history').run();
  db.prepare('DELETE FROM monitored_processes').run();
}

describe('alertingSettingsStorage', () => {
  beforeEach(cleanDb);

  it('getSetting returns null for absent key', () => {
    assert.strictEqual(getSetting('does.not.exist'), null);
  });

  it('setSetting upserts a value; getSetting returns the updated value', () => {
    setSetting('alert.mode', 'throttle');
    assert.strictEqual(getSetting('alert.mode'), 'throttle');
    setSetting('alert.mode', 'every');
    assert.strictEqual(getSetting('alert.mode'), 'every');
  });

  it('setSettings writes multiple keys atomically', () => {
    setSettings({ 'alert.mode': 'throttle', 'alert.throttleMinutes': '30' });
    assert.strictEqual(getSetting('alert.mode'), 'throttle');
    assert.strictEqual(getSetting('alert.throttleMinutes'), '30');
  });

  it('getAllSettings returns all stored entries', () => {
    setSettings({ 'reporter.webhook.enabled': '1', 'reporter.ntfy.enabled': '0' });
    const result = getAllSettings();
    assert.strictEqual(result['reporter.webhook.enabled'], '1');
    assert.strictEqual(result['reporter.ntfy.enabled'], '0');
  });

  it('getSettingJson returns parsed value for valid JSON', () => {
    setSetting('alert.logLevelThreshold', '["error","warn"]');
    const result = getSettingJson('alert.logLevelThreshold', ['error']);
    assert.deepEqual(result, ['error', 'warn']);
  });

  it('getSettingJson returns default for absent key', () => {
    const result = getSettingJson('does.not.exist', ['error']);
    assert.deepEqual(result, ['error']);
  });

  it('getSettingJson returns default for malformed JSON', () => {
    setSetting('alert.logLevelThreshold', 'not-valid-json{');
    const result = getSettingJson('alert.logLevelThreshold', ['error']);
    assert.deepEqual(result, ['error']);
  });

  it('getAlertingConfig returns safe defaults when DB is empty', () => {
    const cfg = getAlertingConfig();
    assert.strictEqual(cfg.mode, 'every');
    assert.strictEqual(cfg.throttleMinutes, 60);
    assert.deepEqual(cfg.logLevelThreshold, ['error']);
    assert.strictEqual(cfg.webhook.enabled, false);
    assert.strictEqual(cfg.ntfy.enabled, false);
    assert.deepEqual(cfg.alerta, { enabled: false, url: '', apiKey: '', targets: '', priority: 'active' });
  });

  it('getAlertingConfig parses multi-value threshold', () => {
    setSetting('alert.logLevelThreshold', '["error","warn"]');
    const cfg = getAlertingConfig();
    assert.deepEqual(cfg.logLevelThreshold, ['error', 'warn']);
  });

  it('getAlertingConfig maps reporter flags correctly', () => {
    setSetting('reporter.webhook.enabled', '1');
    setSetting('reporter.webhook.url', 'https://example.com');
    setSetting('reporter.ntfy.enabled', '0');
    const cfg = getAlertingConfig();
    assert.strictEqual(cfg.webhook.enabled, true);
    assert.strictEqual(cfg.webhook.url, 'https://example.com');
    assert.strictEqual(cfg.ntfy.enabled, false);
  });
});

describe('monitoringStorage alert prefs', () => {
  beforeEach(cleanDb);

  it('getAlertsEnabled returns true for unknown pm2_name', () => {
    assert.strictEqual(getAlertsEnabled('no-such-process'), true);
  });

  it('setAlertsEnabled(false) on existing process causes getAlertsEnabled to return false', () => {
    addMonitored('my-app');
    setAlertsEnabled('my-app', false);
    assert.strictEqual(getAlertsEnabled('my-app'), false);
  });

  it('setAlertsEnabled(true) re-enables alerts; getAlertsEnabled returns true', () => {
    addMonitored('my-app');
    setAlertsEnabled('my-app', false);
    setAlertsEnabled('my-app', true);
    assert.strictEqual(getAlertsEnabled('my-app'), true);
  });

  it('getAllAlertPrefs returns all monitored processes with alerts_enabled values', () => {
    addMonitored('app-one');
    addMonitored('app-two');
    setAlertsEnabled('app-two', false);

    const prefs = getAllAlertPrefs();
    const one = prefs.find((r) => r.pm2_name === 'app-one');
    const two = prefs.find((r) => r.pm2_name === 'app-two');

    assert.ok(one, 'app-one should be in prefs');
    assert.ok(two, 'app-two should be in prefs');
    assert.notEqual(one.alerts_enabled, 0, 'app-one alerts should be enabled');
    assert.strictEqual(two.alerts_enabled, 0, 'app-two alerts should be disabled');
  });

  it('new monitored process defaults to alerts_enabled = 1', () => {
    addMonitored('fresh-app');
    assert.strictEqual(getAlertsEnabled('fresh-app'), true);
  });
});

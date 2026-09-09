/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState } from 'react';
import { fetchWithCsrf } from '../../services/api.js';
import { CheckCircle, Plus, WarningCircle, X } from '../Icon.jsx';

/**
 * Available template variables for header values and body values.
 * Shown in the UI as a reference for users building their webhook config.
 */
const TEMPLATE_VARS = [
  { name: '{logLevel}', description: 'Detected log level, e.g. error' },
  { name: '{log_message}', description: 'The full raw log line' },
  { name: '{process_name}', description: 'The PM2 process name' },
];

const PREVIEW_PAYLOAD = {
  log_level: 'error',
  log: 'Error: 42 is not a number.',
  process_name: 'my-app',
};

/**
 * Substitute template variables with raw sample values.
 *
 * @param {string} template
 * @returns {string}
 */
function previewSubstituteRaw(template) {
  return template
    .replace(/\{logLevel\}/g, PREVIEW_PAYLOAD.log_level)
    .replace(/\{log_message\}/g, PREVIEW_PAYLOAD.log)
    .replace(/\{process_name\}/g, PREVIEW_PAYLOAD.process_name);
}

/**
 * Substitute template variables with JSON-encoded sample values (includes
 * surrounding quotes and escaping).  Used as a second-pass fallback so that
 * unquoted variables inside JSON structures produce valid JSON.
 *
 * @param {string} template
 * @returns {string}
 */
function previewSubstituteJsonEncoded(template) {
  return template
    .replace(/\{logLevel\}/g, JSON.stringify(PREVIEW_PAYLOAD.log_level))
    .replace(/\{log_message\}/g, JSON.stringify(PREVIEW_PAYLOAD.log))
    .replace(/\{process_name\}/g, JSON.stringify(PREVIEW_PAYLOAD.process_name));
}

/**
 * Resolve a single body param value using the same two-pass strategy as the
 * backend: raw substitution first, JSON-encoded substitution as fallback.
 *
 * @param {string} template
 * @returns {unknown}
 */
function resolveBodyValue(template) {
  const raw = previewSubstituteRaw(template);
  try {
    return JSON.parse(raw);
  } catch {
    const encoded = previewSubstituteJsonEncoded(template);
    try {
      return JSON.parse(encoded);
    } catch {
      return raw;
    }
  }
}

/**
 * Build a live curl command preview from the current webhook configuration.
 *
 * @param {string} url
 * @param {{ key: string, value: string }[]} headers
 * @param {{ key: string, value: string }[]} bodyParams
 * @returns {string}
 */
function buildCurlPreview(url, headers, bodyParams) {
  const headerLines = headers
    .filter((h) => h.key && h.key.trim())
    .map((h) => `  -H "${h.key.trim()}: ${previewSubstituteRaw(h.value ?? '')}" \\`)
    .join('\n');

  const bodyObj = {};
  for (const p of bodyParams) {
    if (p.key && p.key.trim()) {
      bodyObj[p.key.trim()] = resolveBodyValue(p.value ?? '');
    }
  }
  const bodyStr = JSON.stringify(bodyObj, null, 2);

  const parts = [`curl -X POST "${url || '<url>'}" \\`, `  -H "Content-Type: application/json" \\`];
  if (headerLines) parts.push(headerLines + ' \\');
  parts.push(`  -d '${bodyStr}'`);

  return parts.join('\n');
}

/**
 * Editable list of key/value pairs (webhook headers or body params).
 *
 * @param {{
 *   label: string,
 *   hint?: string,
 *   rows: { key: string, value: string }[],
 *   keyPlaceholder: string,
 *   valuePlaceholder: string,
 *   onAdd: () => void,
 *   onUpdate: (index: number, field: string, value: string) => void,
 *   onRemove: (index: number) => void,
 * }} props
 */
function KeyValueList({ label, hint, rows, keyPlaceholder, valuePlaceholder, onAdd, onUpdate, onRemove }) {
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <p className="hint">{hint}</p>}
      {rows.map((row, i) => (
        <div className="kv-row" key={i}>
          <input
            className="input"
            placeholder={keyPlaceholder}
            aria-label={`${label} name ${i + 1}`}
            value={row.key}
            onChange={(e) => onUpdate(i, 'key', e.target.value)}
          />
          <input
            className="input"
            placeholder={valuePlaceholder}
            aria-label={`${label} value ${i + 1}`}
            value={row.value}
            onChange={(e) => onUpdate(i, 'value', e.target.value)}
          />
          <button
            type="button"
            className="btn btn--icon"
            aria-label={`Remove ${label} ${i + 1}`}
            onClick={() => onRemove(i)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn--sm" onClick={onAdd}>
        <Plus size={12} weight="bold" />
        Add
      </button>
    </div>
  );
}

/**
 * Alerting settings page.
 *
 * Configures when alerts fire and which reporters receive them.
 * Both webhook header values and body values support template variables
 * ({logLevel}, {log_message}, {process_name}) that are substituted at
 * dispatch time with the actual values from the triggering log line.
 *
 * @param {{
 *   settings: Record<string, string>,
 *   onChange: (updated: Record<string, string>) => void,
 *   onSave: () => Promise<void>,
 *   saving: boolean,
 *   saveError: string | null,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<void>,
 * }} props
 */
export default function AlertingSettings({ settings, onChange, onSave, saving, saveError, csrfToken, onCsrfRefresh }) {
  // Parse current values with defaults.
  const mode = settings['alert.mode'] ?? 'every';
  const throttleMinutes = settings['alert.throttleMinutes'] ?? '60';
  let logLevelThreshold = ['error'];
  try {
    const parsed = JSON.parse(settings['alert.logLevelThreshold'] ?? '["error"]');
    if (Array.isArray(parsed)) logLevelThreshold = parsed;
  } catch {
    // Use default.
  }

  const webhookEnabled = settings['reporter.webhook.enabled'] === '1';
  const webhookUrl = settings['reporter.webhook.url'] ?? '';
  let webhookHeaders = [];
  try {
    const parsed = JSON.parse(settings['reporter.webhook.headers'] ?? '[]');
    if (Array.isArray(parsed)) webhookHeaders = parsed;
  } catch {
    // Use default.
  }
  let webhookBody = [];
  try {
    const parsed = JSON.parse(settings['reporter.webhook.body'] ?? '[]');
    if (Array.isArray(parsed)) webhookBody = parsed;
  } catch {
    // Use default.
  }

  const ntfyEnabled = settings['reporter.ntfy.enabled'] === '1';
  const ntfyServerUrl = settings['reporter.ntfy.serverUrl'] ?? 'https://ntfy.sh';
  const ntfyTopic = settings['reporter.ntfy.topic'] ?? '';
  const ntfyPriority = settings['reporter.ntfy.priority'] ?? 'default';
  const ntfyToken = settings['reporter.ntfy.token'] ?? '';

  const [showNtfyToken, setShowNtfyToken] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState(null);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [ntfyTestResult, setNtfyTestResult] = useState(null);
  const [ntfyTesting, setNtfyTesting] = useState(false);

  /**
   * @param {string} key
   * @param {string} value
   */
  function set(key, value) {
    onChange({ ...settings, [key]: value });
  }

  function toggleLevel(level) {
    const next = logLevelThreshold.includes(level)
      ? logLevelThreshold.filter((l) => l !== level)
      : [...logLevelThreshold, level];
    set('alert.logLevelThreshold', JSON.stringify(next));
  }

  // Header helpers
  function addWebhookHeader() {
    set('reporter.webhook.headers', JSON.stringify([...webhookHeaders, { key: '', value: '' }]));
  }
  function updateWebhookHeader(index, field, value) {
    const next = webhookHeaders.map((h, i) => (i === index ? { ...h, [field]: value } : h));
    set('reporter.webhook.headers', JSON.stringify(next));
  }
  function removeWebhookHeader(index) {
    set('reporter.webhook.headers', JSON.stringify(webhookHeaders.filter((_, i) => i !== index)));
  }

  // Body helpers
  function addWebhookBodyParam() {
    set('reporter.webhook.body', JSON.stringify([...webhookBody, { key: '', value: '' }]));
  }
  function updateWebhookBodyParam(index, field, value) {
    const next = webhookBody.map((p, i) => (i === index ? { ...p, [field]: value } : p));
    set('reporter.webhook.body', JSON.stringify(next));
  }
  function removeWebhookBodyParam(index) {
    set('reporter.webhook.body', JSON.stringify(webhookBody.filter((_, i) => i !== index)));
  }

  async function sendWebhookTest() {
    if (!csrfToken) return;
    setWebhookTesting(true);
    setWebhookTestResult(null);
    try {
      const result = await fetchWithCsrf('/api/alerting/test/webhook', {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, headers: webhookHeaders, body: webhookBody }),
      });
      setWebhookTestResult(result);
    } catch (err) {
      setWebhookTestResult({ ok: false, error: err.message });
    } finally {
      setWebhookTesting(false);
    }
  }

  async function sendNtfyTest() {
    if (!csrfToken) return;
    setNtfyTesting(true);
    setNtfyTestResult(null);
    try {
      const result = await fetchWithCsrf('/api/alerting/test/ntfy', {
        onCsrfRefresh,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: ntfyServerUrl, topic: ntfyTopic, priority: ntfyPriority, token: ntfyToken }),
      });
      setNtfyTestResult(result);
    } catch (err) {
      setNtfyTestResult({ ok: false, error: err.message });
    } finally {
      setNtfyTesting(false);
    }
  }

  /**
   * Render the result of a reporter test.
   *
   * @param {{ ok: boolean, status?: number, error?: string }|null} result
   */
  const testResult = (result) =>
    result && (
      <span className="action-result" data-ok={result.ok}>
        {result.ok ? <CheckCircle size={13} weight="fill" /> : <WarningCircle size={13} weight="fill" />}
        <span>
          {result.ok ? `Delivered, HTTP ${result.status}` : `Failed: ${result.error ?? `HTTP ${result.status}`}`}
        </span>
      </span>
    );

  return (
    <div className="settings-page">
      <p className="hint">
        These rules apply to every process that has monitoring and alerts turned on. Alerts are switched on per process
        in its Manage tab.
      </p>

      {saveError && <div className="settings-notice settings-notice--error">{saveError}</div>}

      <section className="settings-group">
        <h3 className="settings-group-title">When to alert</h3>
        <div className="settings-group-fields">
          <div className="choice-list">
            <label className="choice">
              <input
                type="radio"
                name="alert-mode"
                value="every"
                checked={mode === 'every'}
                onChange={() => set('alert.mode', 'every')}
              />
              <span>
                <strong>Every match</strong>
                <span className="hint">One notification per matching log line.</span>
              </span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="alert-mode"
                value="throttle"
                checked={mode === 'throttle'}
                onChange={() => set('alert.mode', 'throttle')}
              />
              <span>
                <strong>Once, then wait</strong>
                <span className="hint">Notify once, then stay quiet for a set period.</span>
              </span>
            </label>
          </div>

          {mode === 'throttle' && (
            <div className="field">
              <label htmlFor="throttle-minutes">Quiet period</label>
              <div className="input-suffix">
                <input
                  id="throttle-minutes"
                  className="input"
                  type="number"
                  min="1"
                  value={throttleMinutes}
                  onChange={(e) => set('alert.throttleMinutes', e.target.value)}
                />
                <span>minutes</span>
              </div>
            </div>
          )}

          <div className="field">
            <label>Trigger on these levels</label>
            <div className="checkbox-row">
              {['error', 'warn', 'info', 'debug'].map((level) => (
                <label className="checkbox" key={level}>
                  <input
                    type="checkbox"
                    checked={logLevelThreshold.includes(level)}
                    onChange={() => toggleLevel(level)}
                  />
                  <span>{level}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Webhook reporter */}
      <section className="settings-group">
        <div className="reporter-head">
          <h3 className="settings-group-title">Webhook</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={webhookEnabled}
              onChange={(e) => set('reporter.webhook.enabled', e.target.checked ? '1' : '0')}
            />
            <span className="toggle-track" />
            <span className="toggle-label">{webhookEnabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {webhookEnabled && (
          <div className="settings-group-fields">
            <div className="field">
              <label htmlFor="wh-url">URL</label>
              <input
                id="wh-url"
                className="input"
                type="url"
                value={webhookUrl}
                placeholder="https://hooks.example.com/alert"
                onChange={(e) => set('reporter.webhook.url', e.target.value)}
              />
            </div>

            <KeyValueList
              label="Headers"
              rows={webhookHeaders}
              keyPlaceholder="Header name"
              valuePlaceholder="Value"
              onAdd={addWebhookHeader}
              onUpdate={updateWebhookHeader}
              onRemove={removeWebhookHeader}
            />

            <KeyValueList
              label="Body"
              hint="Plain strings are sent as-is. Valid JSON is embedded directly instead of being quoted."
              rows={webhookBody}
              keyPlaceholder="Key"
              valuePlaceholder="Value"
              onAdd={addWebhookBodyParam}
              onUpdate={updateWebhookBodyParam}
              onRemove={removeWebhookBodyParam}
            />

            <div className="field">
              <label>Variables you can use</label>
              <dl className="template-vars">
                {TEMPLATE_VARS.map(({ name, description }) => (
                  <React.Fragment key={name}>
                    <dt>
                      <code>{name}</code>
                    </dt>
                    <dd>{description}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>

            <div className="field">
              <label>Request preview</label>
              <pre className="code-preview">{buildCurlPreview(webhookUrl, webhookHeaders, webhookBody)}</pre>
            </div>

            <div className="test-row">
              <button type="button" className="btn" onClick={sendWebhookTest} disabled={webhookTesting || !webhookUrl}>
                {webhookTesting ? 'Sending' : 'Send a test'}
              </button>
              {testResult(webhookTestResult)}
            </div>
          </div>
        )}
      </section>

      {/* ntfy reporter */}
      <section className="settings-group">
        <div className="reporter-head">
          <h3 className="settings-group-title">ntfy</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={ntfyEnabled}
              onChange={(e) => set('reporter.ntfy.enabled', e.target.checked ? '1' : '0')}
            />
            <span className="toggle-track" />
            <span className="toggle-label">{ntfyEnabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>

        {ntfyEnabled && (
          <div className="settings-group-fields">
            <div className="field">
              <label htmlFor="ntfy-server">Server URL</label>
              <input
                id="ntfy-server"
                className="input"
                type="url"
                value={ntfyServerUrl}
                onChange={(e) => set('reporter.ntfy.serverUrl', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ntfy-topic">Topic</label>
              <input
                id="ntfy-topic"
                className="input"
                value={ntfyTopic}
                placeholder="my-alerts"
                onChange={(e) => set('reporter.ntfy.topic', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ntfy-priority">Priority</label>
              <select
                id="ntfy-priority"
                className="select"
                value={ntfyPriority}
                onChange={(e) => set('reporter.ntfy.priority', e.target.value)}
              >
                <option value="min">min</option>
                <option value="low">low</option>
                <option value="default">default</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ntfy-token">Auth token</label>
              <div className="input-suffix">
                <input
                  id="ntfy-token"
                  className="input"
                  type={showNtfyToken ? 'text' : 'password'}
                  value={ntfyToken}
                  placeholder="Optional"
                  onChange={(e) => set('reporter.ntfy.token', e.target.value)}
                  autoComplete="off"
                />
                <button type="button" className="btn btn--sm" onClick={() => setShowNtfyToken((v) => !v)}>
                  {showNtfyToken ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div className="test-row">
              <button type="button" className="btn" onClick={sendNtfyTest} disabled={ntfyTesting || !ntfyTopic}>
                {ntfyTesting ? 'Sending' : 'Send a test'}
              </button>
              {testResult(ntfyTestResult)}
            </div>
          </div>
        )}
      </section>

      <div className="settings-actions">
        <button className="btn btn--primary" type="button" onClick={onSave} disabled={saving}>
          {saving ? 'Saving' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

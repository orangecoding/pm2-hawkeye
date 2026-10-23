/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Webhook reporter.
 *
 * Sends alert payloads as HTTP POST requests with a JSON body assembled from
 * user-configured key/value body params.  Both header values and body values
 * support variable substitution:
 *
 *   {logLevel}      - the detected log level (e.g. 'error', 'warn')
 *   {log_message}   - the raw log line text
 *   {process_name}  - the PM2 process name
 *
 * A 5-second timeout is enforced via AbortController.
 */

/**
 * @typedef {Object} AlertPayload
 * @property {string} log_level
 * @property {string} log
 * @property {string} time
 * @property {string} process_name
 */

/**
 * @typedef {Object} WebhookConfig
 * @property {string} url
 * @property {{ key: string, value: string }[]} headers
 * @property {{ key: string, value: string }[]} body
 */

/**
 * Template variables supported in webhook header and body values, mapped to
 * the alert payload field they read.
 *
 * @type {Record<string, (payload: AlertPayload) => string>}
 */
const TEMPLATE_VARS = {
  '{logLevel}': (payload) => payload.log_level,
  '{log_message}': (payload) => payload.log,
  '{process_name}': (payload) => payload.process_name,
};

const TEMPLATE_VAR_PATTERN = /\{logLevel\}|\{log_message\}|\{process_name\}/g;

/**
 * Read the value of a template variable as a string.
 *
 * @param {string} token - Variable including braces, e.g. `{log_message}`.
 * @param {AlertPayload} payload
 * @returns {string}
 */
function varValue(token, payload) {
  return String(TEMPLATE_VARS[token](payload) ?? '');
}

/**
 * Replace template variables in a string with raw (unescaped) values from the
 * alert payload.
 *
 * A replacer function is used so that `$&`, `$1` and similar sequences in a
 * log message are inserted literally instead of being read as replacement
 * patterns.
 *
 * @param {string} template
 * @param {AlertPayload} payload
 * @returns {string}
 */
function substituteVars(template, payload) {
  return template.replace(TEMPLATE_VAR_PATTERN, (token) => varValue(token, payload));
}

/**
 * Replace template variables so that the result stays valid JSON.
 *
 * The template is scanned once while tracking whether the current position is
 * inside a JSON string literal:
 *
 * - inside a string, the value is escaped without surrounding quotes:
 *   `{"msg": "{log_message}"}` becomes `{"msg": "say \"hi\""}`
 * - outside a string, the value becomes a complete JSON string:
 *   `{"msg": {log_message}}` becomes `{"msg": "say \"hi\""}`
 *
 * @param {string} template
 * @param {AlertPayload} payload
 * @returns {string}
 */
function substituteVarsJson(template, payload) {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < template.length) {
    const token = Object.keys(TEMPLATE_VARS).find((name) => template.startsWith(name, i));
    if (token) {
      const encoded = JSON.stringify(varValue(token, payload));
      out += inString ? encoded.slice(1, -1) : encoded;
      i += token.length;
      continue;
    }
    const ch = template[i];
    if (inString && ch === '\\') {
      // Copy an escape sequence as a whole so an escaped quote does not end the string.
      out += template.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') inString = !inString;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Build the request headers object from config, applying variable substitution
 * to header values. Line breaks from substituted values are replaced by spaces.
 *
 * @param {{ key: string, value: string }[]} headerConfig
 * @param {AlertPayload} payload
 * @returns {Record<string, string>}
 */
function buildHeaders(headerConfig, payload) {
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (Array.isArray(headerConfig)) {
    for (const h of headerConfig) {
      if (h.key && h.key.trim()) {
        // Line breaks are not allowed in header values and would make fetch throw.
        headers[h.key.trim()] = substituteVars(h.value ?? '', payload).replace(/[\r\n]+/g, ' ');
      }
    }
  }
  return headers;
}

/**
 * Build the JSON body object from user-configured key/value body params.
 *
 * Each value is first substituted with {@link substituteVarsJson} and parsed
 * as JSON, which allows plain numbers, booleans, arrays and nested objects,
 * with variables placed inside or outside of quotes. When the result is not
 * valid JSON, the value is kept as a plain string with raw variable values.
 *
 * @param {{ key: string, value: string }[]} bodyConfig
 * @param {AlertPayload} payload
 * @returns {Record<string, unknown>}
 */
export function buildBody(bodyConfig, payload) {
  /** @type {Record<string, unknown>} */
  const body = {};
  if (Array.isArray(bodyConfig)) {
    for (const p of bodyConfig) {
      if (p.key && p.key.trim()) {
        const template = p.value ?? '';
        try {
          body[p.key.trim()] = JSON.parse(substituteVarsJson(template, payload));
        } catch {
          body[p.key.trim()] = substituteVars(template, payload);
        }
      }
    }
  }
  return body;
}

/**
 * POST an alert payload to a webhook URL.
 *
 * The request body is assembled from `config.body` key/value pairs with
 * variable substitution applied.  Header values also support substitution.
 *
 * @param {WebhookConfig} config
 * @param {AlertPayload} payload
 * @returns {Promise<void>}
 */
export async function sendWebhook(config, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: buildHeaders(config.headers, payload),
      body: JSON.stringify(buildBody(config.body, payload)),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Webhook responded with HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a sample test payload to a webhook and return a result object.
 *
 * Uses a synthetic payload so the test can be triggered from the settings UI
 * without requiring a real log event.
 *
 * @param {WebhookConfig} config
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function testWebhook(config) {
  /** @type {AlertPayload} */
  const samplePayload = {
    log_level: 'error',
    process_name: 'test-process',
    log: 'Error: this is a test alert from pm2-hawkeye',
    time: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: buildHeaders(config.headers, samplePayload),
        body: JSON.stringify(buildBody(config.body, samplePayload)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

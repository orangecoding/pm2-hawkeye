/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Storage helpers for the MCP server settings.
 *
 * The settings live in the same key-value table as the alerting settings:
 *   mcp.enabled  '1' or '0'
 *   mcp.key      the access key, in plain text so Settings can show and copy it
 *   mcp.tools    JSON object of tool name -> boolean, only for tools whose
 *                state differs from their default, so a tool added later
 *                starts with its own default
 */

import crypto from 'node:crypto';
import { getSetting, setSetting, setSettings, getSettingJson } from './alertingSettingsStorage.js';

/** Prefix of every MCP key, so a leaked one is recognisable in logs and scanners. */
const KEY_PREFIX = 'hk_';

/**
 * @typedef {Object} McpSettings
 * @property {boolean} enabled
 * @property {string | null} key - Null until the server was turned on once.
 * @property {Record<string, boolean>} toolOverrides - Tools whose state differs from their default.
 */

/**
 * Create a new random access key: the prefix plus 32 random bytes, base64url.
 *
 * @returns {string}
 */
function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/**
 * Read the MCP settings with defaults for missing keys.
 *
 * @returns {McpSettings}
 */
export function getMcpSettings() {
  const overrides = getSettingJson('mcp.tools', {});
  return {
    enabled: getSetting('mcp.enabled') === '1',
    key: getSetting('mcp.key') || null,
    toolOverrides: overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {},
  };
}

/**
 * Turn the MCP server on or off. Turning it on for the first time creates
 * the access key; an existing key is kept.
 *
 * @param {boolean} enabled
 */
export function setMcpEnabled(enabled) {
  const updates = { 'mcp.enabled': enabled ? '1' : '0' };
  if (enabled && !getSetting('mcp.key')) {
    updates['mcp.key'] = generateKey();
  }
  setSettings(updates);
}

/**
 * Store the tool overrides, replacing the previous ones.
 *
 * @param {Record<string, boolean>} overrides - Tools whose state differs from their default.
 */
export function setToolOverrides(overrides) {
  setSetting('mcp.tools', JSON.stringify(overrides));
}

/**
 * Replace the access key. The old key stops working with the next request.
 *
 * @returns {string} The new key.
 */
export function rotateMcpKey() {
  const key = generateKey();
  setSetting('mcp.key', key);
  return key;
}

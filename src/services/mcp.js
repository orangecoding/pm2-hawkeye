/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Helpers for the MCP server settings page: key masking, the Claude Code
 * snippets and the grouping of tools by what they may do.
 */

/** Name the server gets in Claude Code. */
export const MCP_SERVER_NAME = 'pm2-hawkeye';

/** Environment variable the `.mcp.json` snippet reads the key from. */
export const MCP_KEY_ENV = 'HAWKEYE_MCP_KEY';

/**
 * The tool groups in the order the page shows them.
 *
 * @type {{ access: 'read' | 'write' | 'destructive', label: string, description: string, tag: { label: string, tone: string } | null }[]}
 */
export const TOOL_GROUPS = [
  {
    access: 'read',
    label: 'Read',
    description: 'Look at processes, logs, metrics and deployments. Never changes anything.',
    tag: null,
  },
  {
    access: 'write',
    label: 'Write',
    description: 'Start, stop and restart processes, deploy apps and change their settings.',
    tag: { label: 'Changes state', tone: 'warning' },
  },
  {
    access: 'destructive',
    label: 'Destructive',
    description: 'Delete processes, deploy directories and deployment records.',
    tag: { label: 'Deletes data', tone: 'critical' },
  },
];

/**
 * Mask a key for display: the prefix and the last four characters stay, so
 * two keys can still be told apart.
 *
 * @param {string} key
 * @returns {string}
 */
export function maskKey(key) {
  if (!key) return '';
  return `${key.slice(0, 3)}${'•'.repeat(24)}${key.slice(-4)}`;
}

/**
 * The `claude mcp add` command that registers Hawkeye in Claude Code for
 * every project of the user.
 *
 * @param {string} url - The MCP endpoint.
 * @param {string} key - The key to put in the header (masked for display, full for copying).
 * @returns {string}
 */
export function buildCliSnippet(url, key) {
  return [
    `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} \\`,
    `  ${url} \\`,
    `  --header "Authorization: Bearer ${key}"`,
  ].join('\n');
}

/**
 * A `.mcp.json` entry for a project. The key comes from an environment
 * variable, so the file can be committed without it.
 *
 * @param {string} url - The MCP endpoint.
 * @returns {string}
 */
export function buildJsonSnippet(url) {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer \${${MCP_KEY_ENV}}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * The shell line that sets the key for the `.mcp.json` variant.
 *
 * @param {string} key
 * @returns {string}
 */
export function buildExportLine(key) {
  return `export ${MCP_KEY_ENV}=${key}`;
}

/**
 * Group tools by access level, in the order of `TOOL_GROUPS`. Groups without
 * tools are left out.
 *
 * @param {{ access: string, enabled: boolean }[]} tools
 * @returns {{ group: typeof TOOL_GROUPS[number], tools: object[], enabledCount: number }[]}
 */
export function groupTools(tools) {
  return TOOL_GROUPS.map((group) => {
    const members = tools.filter((tool) => tool.access === group.access);
    return { group, tools: members, enabledCount: members.filter((tool) => tool.enabled).length };
  }).filter((entry) => entry.tools.length > 0);
}

/**
 * True when the page was opened over plain HTTP from another machine, so a
 * client would send the key unencrypted over the network.
 *
 * @param {{ protocol: string, hostname: string }} location
 * @returns {boolean}
 */
export function isPlainHttpRemote(location) {
  if (location.protocol !== 'http:') return false;
  return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
}

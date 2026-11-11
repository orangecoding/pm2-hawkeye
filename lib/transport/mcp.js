/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * MCP server endpoint (Streamable HTTP, stateless).
 *
 * `POST /mcp` takes JSON-RPC messages from MCP clients such as Claude Code.
 * Clients sign in with `Authorization: Bearer <key>`, the key from Settings.
 * While the server is off the endpoint answers 404, so it does not even reveal
 * that it exists.
 *
 * Every request gets its own McpServer with only the tools that are turned on,
 * so a tool switched off in Settings is gone from `tools/list` and cannot be
 * called, starting with the next request.
 */

import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import config from '../config.js';
import { checkUnauthWindow, delay } from '../security/auth.js';
import { getClientIdentity, getRateLimitIdentity, sanitizeForLog } from '../security/security.js';
import { getMcpSettings } from '../storage/mcpSettingsStorage.js';
import logger from '../service/logger.js';
import { TOOLS, isToolEnabled } from './mcpTools.js';

/** Short orientation for the agent, sent with the initialize response. */
const INSTRUCTIONS =
  'Hawkeye manages the PM2 processes of one server. Address a process by its pm_id or name (list_processes). ' +
  'Logs and metric history are stored only for monitored processes. Deploys run in the background: ' +
  'after create_deployment or redeploy, poll get_deployment_status. Tools that are switched off in ' +
  "Hawkeye's settings do not appear here; ask the user to turn them on if you need one.";

const router = express.Router();

/**
 * Compare two keys in constant time. Hashing first gives both buffers the
 * same length, which `timingSafeEqual` requires.
 *
 * @param {string} given
 * @param {string} expected
 * @returns {boolean}
 */
function keysMatch(given, expected) {
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Why a request was refused, for the log line and for the client.
 *
 * @type {Record<'missing' | 'malformed' | 'invalid', { log: string, message: string }>}
 */
const KEY_PROBLEMS = {
  missing: {
    log: 'without a key',
    message: 'MCP key missing. Send it as "Authorization: Bearer <key>".',
  },
  malformed: {
    log: 'with a malformed Authorization header',
    message: 'Malformed Authorization header. Expected "Bearer <key>".',
  },
  invalid: {
    log: 'with an invalid key',
    message: 'Invalid MCP key. It may have been rotated; copy the current one from Settings - MCP server.',
  },
};

/**
 * Check the bearer key of a request against the current key.
 *
 * @param {import('express').Request} req
 * @param {string} expected - The current key.
 * @returns {null | 'missing' | 'malformed' | 'invalid'} Null when the key is valid.
 */
function keyProblem(req, expected) {
  const header = req.get('authorization');
  if (!header) return 'missing';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return 'malformed';
  return keysMatch(match[1], expected) ? null : 'invalid';
}

/**
 * Let a request through only while the MCP server is on and the request
 * carries the current key.
 *
 * Every refused request is logged as an error with the reason and the
 * client identity, never with the key it sent. Refusals also count against
 * the same per-client window as unauthenticated dashboard requests: once a
 * client is over it, it is slowed down and answered with 429, and only the
 * moment it crosses the limit is logged, so a client that keeps guessing
 * cannot flood the log.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireMcpKey(req, res, next) {
  const settings = getMcpSettings();
  if (!settings.enabled || !settings.key) {
    return res.status(404).json({ error: 'Not found' });
  }

  const problem = keyProblem(req, settings.key);
  if (!problem) {
    req.mcpSettings = settings;
    return next();
  }

  const identity = getClientIdentity(req);
  const { limited, tripped, retryAfterMs } = checkUnauthWindow(getRateLimitIdentity(req), Date.now());
  if (limited) {
    if (tripped) {
      logger.error(`[MCP] Rate-limited client after too many requests without a valid key: ${identity}`);
    }
    await delay(config.UNAUTH_PENALTY_MS);
    res.setHeader('Retry-After', String(Math.max(Math.ceil(retryAfterMs / 1000), 1)));
    return res.status(429).json({ error: 'Too many requests' });
  }

  logger.error(`[MCP] Rejected ${req.method} /mcp ${KEY_PROBLEMS[problem].log} from identity: ${identity}`);
  res.setHeader('WWW-Authenticate', 'Bearer realm="pm2-hawkeye"');
  return res.status(401).json({ error: KEY_PROBLEMS[problem].message });
}

/**
 * Wrap a tool handler: audit the call, run it and turn its result or error
 * into MCP tool content. Failures become `isError` results with the message,
 * so the agent can read what went wrong.
 *
 * @param {import('./mcpTools.js').ToolDefinition} tool
 * @param {{ name: string, identity: string }} actor
 * @returns {(args: object) => Promise<object>}
 */
function toolHandler(tool, actor) {
  return async (args = {}) => {
    const target = args.process ?? args.deployment ?? args.appName;
    const line = `[MCP] ${tool.name}${target ? ` on ${sanitizeForLog(String(target), 128)}` : ''} from identity: ${actor.identity}`;
    if (tool.access === 'read') {
      logger.debug(line);
    } else {
      logger.info(line);
    }

    try {
      const result = await tool.run(args, { actor });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (tool.access !== 'read') {
        logger.warn(`[MCP] ${tool.name} failed: ${message}`);
      }
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  };
}

/**
 * Build an MCP server with the tools that are turned on.
 *
 * @param {Record<string, boolean>} toolOverrides - Stored tool states.
 * @param {{ name: string, identity: string }} actor - The calling client, for the audit log.
 * @returns {McpServer}
 */
export function createMcpServer(toolOverrides, actor) {
  const server = new McpServer({ name: 'pm2-hawkeye', version: config.APP_VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    if (!isToolEnabled(tool, toolOverrides)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === 'read',
          destructiveHint: tool.access === 'destructive',
          openWorldHint: false,
        },
      },
      toolHandler(tool, actor),
    );
  }
  return server;
}

router.post('/mcp', requireMcpKey, async (req, res) => {
  const actor = { name: 'MCP', identity: getClientIdentity(req) };
  const server = createMcpServer(req.mcpSettings.toolOverrides, actor);
  // Stateless: no session id, one transport per request, plain JSON answers.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error(`[MCP] Request failed: ${error.stack || error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// Stateless mode has no server-to-client stream and no session to end.
router.all('/mcp', requireMcpKey, (req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});

export default router;

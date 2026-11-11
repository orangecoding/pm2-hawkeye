/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Express Router for PM2-Hawkeye.
 */

import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import config from '../config.js';
import {
  setSessionCookie,
  clearSessionCookie,
  getClientIdentity,
  getRateLimitIdentity,
  sanitizeForLog,
} from '../security/security.js';
import { createSession, getAuthenticatedSession, destroySession, consumeCsrfToken } from '../security/session.js';
import {
  verifyCredentials,
  checkLoginWindow,
  getPenalty,
  registerFailedAttempt,
  clearFailedAttempts,
  ensureMinimumResponseTime,
  checkUnauthWindow,
  delay,
} from '../security/auth.js';
import * as pm2 from '../service/pm2Service.js';
import * as logLevel from '../service/logLevelService.js';
import {
  startDeployment,
  editDeployment,
  startRedeploy,
  confirmDeployment,
  removeDeployment,
} from '../service/deploymentOperations.js';
import {
  resolvePm2Name,
  removeProcess,
  setMonitoring,
  getMetricsHistory,
  getStoredLogPage,
  MAX_LOG_PAGE_SIZE,
} from '../service/processOperations.js';
import { getAllDeployments } from '../storage/deploymentStorage.js';
import { getUpdateInfo } from '../service/updateChecker.js';
import { getByPm2Name, setAlertsEnabled } from '../storage/monitoringStorage.js';
import { getHostMetricsWindow } from '../storage/hostMetricsStorage.js';
import { getLastHostReading } from '../service/hostMetricsCollector.js';
import { getAllSettings, setSettings } from '../storage/alertingSettingsStorage.js';
import { getMcpSettings, setMcpEnabled, setToolOverrides, rotateMcpKey } from '../storage/mcpSettingsStorage.js';
import { listToolStates, applyToolChanges } from './mcpTools.js';
import { testWebhook } from '../service/reporters/webhook.js';
import { testNtfy } from '../service/reporters/ntfy.js';
import { testAlerta } from '../service/reporters/alerta.js';
import logger from '../service/logger.js';
import { buildProcessList } from './ws.js';

const router = express.Router();

// Auth Middleware ─────────────────────────────────────────────────────────

/**
 * Require an authenticated session. Tracks unauthenticated access attempts
 * per client identity and rate-limits abusive clients with a delay + 429.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireAuth(req, res, next) {
  const session = getAuthenticatedSession(req);
  if (!session) {
    const identity = getClientIdentity(req);
    const rateLimitIdentity = getRateLimitIdentity(req);
    const { limited, tripped, retryAfterMs } = checkUnauthWindow(rateLimitIdentity, Date.now());

    if (limited) {
      // Log only the moment a client crosses the rate limit, not every blocked
      // request - otherwise a single scanner floods the logs.
      if (tripped) {
        logger.warn(`[AUTH_BLOCKED] Rate-limited unauthenticated client (too many requests): ${identity}`);
      }
      await delay(config.UNAUTH_PENALTY_MS);
      const retryAfterSeconds = Math.max(Math.ceil(retryAfterMs / 1000), 1);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).send('Too Many Requests');
    }

    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }
  req.session = session;
  next();
}

/**
 * Require a valid CSRF token on a state-changing request. Runs after
 * `requireAuth`, so `req.session` is set. The token is single use: a match
 * rotates it (see `consumeCsrfToken`).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireCsrf(req, res, next) {
  if (!consumeCsrfToken(req, req.session)) {
    logger.warn(
      `[SECURITY] CSRF token mismatch for user: ${req.session.username} on ${req.method} ${sanitizeForLog(req.path)} from identity: ${getClientIdentity(req)}`,
    );
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }
  next();
}

// Public Routes ───────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (getAuthenticatedSession(req)) {
    return res.redirect('/');
  }
  res.sendFile('login.html', { root: config.PUBLIC_DIR, headers: { 'Cache-Control': 'no-store' } });
});

router.post('/api/auth/login', async (req, res) => {
  const startedAt = Date.now();
  const identity = getClientIdentity(req);
  const rateLimitIdentity = getRateLimitIdentity(req);
  const now = Date.now();
  const windowCheck = checkLoginWindow(rateLimitIdentity, now);

  let statusCode;
  let payload;
  let retryAfterSeconds = null;
  let sessionToken = null;

  if (!windowCheck.allowed) {
    // Already rate-limited / locked out. Respond with 429 but stay silent: the
    // event that caused the block was logged once when it was applied, so we do
    // not log every subsequent blocked attempt.
    statusCode = 429;
    retryAfterSeconds = Math.max(Math.ceil(windowCheck.retryAfterMs / 1000), 1);
    payload = { error: 'Too many login attempts. Try again later.', retryAfterSeconds };
  } else {
    const penaltyMs = getPenalty(rateLimitIdentity, now);

    if (penaltyMs > 0) {
      // Locked out from a previous burst of failures - silent 429 (see above).
      statusCode = 429;
      retryAfterSeconds = Math.max(Math.ceil(penaltyMs / 1000), 1);
      payload = { error: 'Too many login attempts. Try again later.', retryAfterSeconds };
    } else {
      const { username, password } = req.body;
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        statusCode = 400;
        payload = { error: 'Username and password are required.' };
      } else if (!verifyCredentials(username, password)) {
        const lockoutMs = registerFailedAttempt(rateLimitIdentity, Date.now());
        statusCode = 401;
        payload = { error: 'Invalid credentials.' };
        if (lockoutMs > 0) {
          // Third strike: log the lockout once, then go silent for its duration.
          payload.retryAfterSeconds = Math.max(Math.ceil(lockoutMs / 1000), 1);
          logger.warn(
            `[AUTH_LOCKED] Too many failed logins - locked out for ${payload.retryAfterSeconds}s: ${identity}`,
          );
        } else {
          logger.warn(
            `[AUTH_FAILURE] Invalid credentials for user: ${sanitizeForLog(username, 100)} from identity: ${identity}`,
          );
        }
      } else {
        clearFailedAttempts(rateLimitIdentity);
        destroySession(req);
        const newSession = createSession(config.AUTH_USERNAME);
        sessionToken = newSession.token;
        statusCode = 200;
        logger.info(
          `[AUTH_SUCCESS] Login successful for user: ${sanitizeForLog(username, 100)} from identity: ${identity}`,
        );
        payload = { ok: true };
      }
    }
  }

  await ensureMinimumResponseTime(startedAt, config.AUTH_MIN_RESPONSE_MS);

  res.setHeader('Cache-Control', 'no-store');
  if (retryAfterSeconds !== null) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }
  if (sessionToken) {
    setSessionCookie(res, req, sessionToken);
  }

  res.status(statusCode).json(payload);
});

// Input validation ────────────────────────────────────────────────────────

/**
 * Validate that a process ID param is a pm_id or a plausible PM2 name.
 * Names may contain spaces, dots, `@`, `:` and `+` (PM2 accepts them, and an
 * orphaned process is addressed by its name); the frontend URL-encodes them.
 */
function validateProcessId(req, res, next) {
  const id = req.params.id;
  if (!/^[\w .@:+-]{1,128}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid process identifier.' });
  }
  next();
}

/**
 * Describe the signed-in user of a request for the audit log of a shared
 * operation (see `lib/service/processOperations.js`).
 *
 * @param {import('express').Request} req - Request after `requireAuth`.
 * @returns {{ name: string, identity: string }}
 */
function sessionActor(req) {
  return { name: `User: ${req.session.username}`, identity: getClientIdentity(req) };
}

/**
 * Send the failure of a shared operation as a JSON error with its status.
 *
 * @param {import('express').Response} res
 * @param {{ status: number, error: string }} result
 */
function sendOperationError(res, result) {
  res.status(result.status).json({ error: result.error });
}

// Authenticated Routes ────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  res.sendFile('index.html', { root: config.PUBLIC_DIR, headers: { 'Cache-Control': 'no-store' } });
});

router.get('/api/auth/session', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    authenticated: true,
    username: req.session.username,
    csrfToken: req.session.csrfToken,
    expiresAt: req.session.expiresAt,
    version: config.APP_VERSION,
    config: {
      host: config.HOST,
      port: config.PORT,
      authUsername: config.AUTH_USERNAME,
      sessionTtlMs: config.SESSION_TTL_MS,
      cookieSecure: config.COOKIE_SECURE_MODE,
      trustProxy: config.TRUST_PROXY,
      maxLogBytesPerFile: config.MAX_LOG_BYTES_PER_FILE,
      metricsRetentionMs: config.METRICS_RETENTION_MS,
      logsRetentionMs: config.LOGS_RETENTION_MS,
      sqliteDbPath: config.SQLITE_DB_PATH,
      // Absolute path; the deploy form previews the clone target under it.
      deployBaseDir: config.DEPLOY_BASE_DIR,
    },
  });
});

router.get('/api/update', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ update: getUpdateInfo() });
});

router.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
  logger.info(
    `[AUTH_SUCCESS] Logout successful for user: ${req.session.username} from identity: ${getClientIdentity(req)}`,
  );
  destroySession(req);
  clearSessionCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

/**
 * GET /api/processes
 * The same annotated list the WebSocket pushes every 3 seconds (monitoring
 * state, alert preference, orphans), so the first render matches the stream.
 */
router.get('/api/processes', requireAuth, async (req, res) => {
  try {
    res.json(await buildProcessList());
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/api/processes/:id', requireAuth, validateProcessId, async (req, res) => {
  try {
    const proc = await pm2.findProcess(req.params.id);
    const details = proc ? await pm2.loadProcessDetails(proc.pm_id) : null;
    if (!details) {
      return res.status(404).json({ error: 'Process not found' });
    }
    res.json(details);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/processes/:id/actions', requireAuth, validateProcessId, async (req, res) => {
  try {
    const proc = await pm2.findProcess(req.params.id);
    const actions = proc ? await pm2.getProcessActions(proc.pm_id) : [];
    res.json({ processId: req.params.id, actions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/processes/:id/actions/trigger', requireAuth, validateProcessId, requireCsrf, async (req, res) => {
  try {
    const { actionName, params } = req.body;
    if (!actionName || typeof actionName !== 'string') {
      return res.status(400).json({ error: 'actionName is required' });
    }
    const proc = await pm2.findProcess(req.params.id);
    if (!proc) {
      return res.status(404).json({ error: 'Process not found' });
    }
    logger.info(
      `[ACTION] User: ${req.session.username} is triggering action: ${sanitizeForLog(actionName)} on process: ${proc.name} from identity: ${getClientIdentity(req)}`,
    );
    const output = await pm2.triggerProcessAction(proc.pm_id, actionName, params);
    res.json({ ok: true, processId: req.params.id, actionName, output });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/processes/:id/log-level', requireAuth, validateProcessId, async (req, res) => {
  try {
    const target = await pm2.findOnlineProcess(req.params.id);
    if (!target.ok) {
      return res.status(target.status).json({ error: target.error });
    }
    const answer = await logLevel.queryLevel(target.pmId);
    res.json({
      supported: answer.ok === true,
      level: answer.ok ? answer.level : null,
      ackAt: answer.ok ? answer.ackAt : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/processes/:id/log-level', requireAuth, validateProcessId, requireCsrf, async (req, res) => {
  try {
    const level = logLevel.normalizeLevel(req.body?.level);
    if (!level) {
      return res.status(400).json({ error: `level must be one of: ${logLevel.LOG_LEVELS.join(', ')}` });
    }

    const target = await pm2.findOnlineProcess(req.params.id);
    if (!target.ok) {
      return res.status(target.status).json({ error: target.error });
    }

    logger.info(
      `[LOG_LEVEL] User: ${req.session.username} is setting log level ${level} on process: ${target.name} from identity: ${getClientIdentity(req)}`,
    );

    const answer = await logLevel.setLevel(target.pmId, level);
    res.json({
      supported: answer.ok === true,
      level: answer.ok ? answer.level : null,
      requested: level,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Build a route handler that runs a PM2 lifecycle command on the process
 * `:id` refers to and answers with its fresh details, or 404 when no such
 * process is running.
 *
 * @param {string} verb - Present participle for the audit log, e.g. 'restarting'.
 * @param {(pmId: number) => Promise<void>} command - pm2Service function to run.
 * @returns {import('express').RequestHandler}
 */
function processCommand(verb, command) {
  return async (req, res) => {
    try {
      const proc = await pm2.findProcess(req.params.id);
      if (!proc) {
        return res.status(404).json({ error: 'Process not found' });
      }
      logger.info(
        `[ACTION] User: ${req.session.username} is ${verb} process: ${proc.name} (pm_id ${proc.pm_id}) from identity: ${getClientIdentity(req)}`,
      );
      await command(proc.pm_id);
      const details = await pm2.loadProcessDetails(proc.pm_id);
      res.json({ ok: true, processId: req.params.id, details });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
}

router.post(
  '/api/processes/:id/restart',
  requireAuth,
  validateProcessId,
  requireCsrf,
  processCommand('restarting', pm2.restartProcess),
);
router.post(
  '/api/processes/:id/stop',
  requireAuth,
  validateProcessId,
  requireCsrf,
  processCommand('stopping', pm2.stopProcess),
);
router.post(
  '/api/processes/:id/start',
  requireAuth,
  validateProcessId,
  requireCsrf,
  processCommand('starting', pm2.startStoppedProcess),
);

/**
 * Delete a process from PM2 and optionally purge its deployment data.
 *
 * Query params:
 *   deleteDeploy=true  Also delete the deployment DB record and its directory
 *                      on disk (the cloned repo under DEPLOY_BASE_DIR). Every
 *                      instance with the same name is deleted then, since the
 *                      other cluster workers would run from a removed directory.
 *
 * The monitoring record (keyed by name) is removed only once no instance with
 * that name is left, so deleting one cluster worker keeps the app monitored.
 *
 * @route DELETE /api/processes/:id
 */
router.delete('/api/processes/:id', requireAuth, validateProcessId, requireCsrf, async (req, res) => {
  try {
    const result = await removeProcess(req.params.id, {
      deleteDeploy: req.query.deleteDeploy === 'true',
      actor: sessionActor(req),
    });
    if (!result.ok) {
      return sendOperationError(res, result);
    }
    res.json({ ok: true, processId: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Monitoring routes ────────────────────────────────────────────────────────

router.get('/api/processes/:id/monitoring', requireAuth, validateProcessId, async (req, res) => {
  try {
    const pm2Name = await resolvePm2Name(req.params.id);
    const row = getByPm2Name(pm2Name);
    res.json({
      pm2Name,
      isMonitored: !!row,
      isOrphan: row ? !!row.is_orphan : false,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Toggle monitoring for a process.
 * Accepts pm2Name in the request body to support process names containing
 * characters that are not safe in URL path segments (spaces, dots, etc.).
 *
 * @route POST /api/monitoring
 * @body {{ pm2Name: string, monitored: boolean }}
 */
router.post('/api/monitoring', requireAuth, requireCsrf, async (req, res) => {
  try {
    const { pm2Name, monitored } = req.body;
    if (!pm2Name || typeof pm2Name !== 'string') {
      return res.status(400).json({ error: '"pm2Name" must be a non-empty string.' });
    }
    if (typeof monitored !== 'boolean') {
      return res.status(400).json({ error: '"monitored" must be a boolean.' });
    }
    setMonitoring(pm2Name, monitored);
    logger.info(`[MONITORING] User: ${req.session.username} set monitoring=${monitored} for process: ${pm2Name}`);
    res.json({ ok: true, pm2Name, isMonitored: monitored });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/processes/:id/metrics
 * Return the stored history of a monitored process: CPU/memory `samples` and,
 * under `custom`, one series per application metric reported through tx2 or
 * @pm2/io. Both are empty when the process is not monitored.
 */
router.get('/api/processes/:id/metrics', requireAuth, validateProcessId, async (req, res) => {
  try {
    res.json(await getMetricsHistory(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/host-metrics
 * Return the full retention window of host-level CPU, RAM, and disk samples,
 * averaged into fixed-width buckets and ordered oldest-first, plus the latest
 * full reading (`current`) which carries absolute used/total bytes for RAM and
 * disk (not stored in the percentage-only history table).
 */
router.get('/api/host-metrics', requireAuth, (req, res) => {
  try {
    const samples = getHostMetricsWindow();
    const current = getLastHostReading();
    res.json({ samples, current });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Validate and normalize stored-log pagination parameters.
 *
 * @param {Record<string, unknown>} query
 * @returns {{ ok: true, limit: number, before?: number, beforeId?: number } | { ok: false, error: string }}
 */
export function parseStoredLogQuery(query) {
  const parsePositiveInteger = (value) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };

  const limit = query.limit === undefined ? 200 : parsePositiveInteger(query.limit);
  if (limit === null || limit > MAX_LOG_PAGE_SIZE) {
    return { ok: false, error: `limit must be a whole number between 1 and ${MAX_LOG_PAGE_SIZE}` };
  }

  const before = query.before === undefined ? undefined : parsePositiveInteger(query.before);
  if (query.before !== undefined && before === null) {
    return { ok: false, error: 'before must be a positive integer timestamp' };
  }

  const beforeId = query.beforeId === undefined ? undefined : parsePositiveInteger(query.beforeId);
  if (query.beforeId !== undefined && beforeId === null) {
    return { ok: false, error: 'beforeId must be a positive integer' };
  }
  if (beforeId !== undefined && before === undefined) {
    return { ok: false, error: 'beforeId requires before' };
  }

  return { ok: true, limit, before, beforeId };
}

router.get('/api/processes/:id/logs/stored', requireAuth, validateProcessId, async (req, res) => {
  try {
    const page = parseStoredLogQuery(req.query);
    if (!page.ok) {
      return res.status(400).json({ error: page.error });
    }
    const { pm2Name, entries, nextCursor } = await getStoredLogPage(req.params.id, page);
    res.json({ pm2Name, entries, nextCursor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Alerting routes ─────────────────────────────────────────────────────────

/** Known alerting settings keys - any other key is rejected with 400. */
const KNOWN_ALERTING_KEYS = new Set([
  'alert.mode',
  'alert.throttleMinutes',
  'alert.logLevelThreshold',
  'reporter.webhook.enabled',
  'reporter.webhook.url',
  'reporter.webhook.headers',
  'reporter.webhook.body',
  'reporter.ntfy.enabled',
  'reporter.ntfy.serverUrl',
  'reporter.ntfy.topic',
  'reporter.ntfy.priority',
  'reporter.ntfy.token',
  'reporter.alerta.enabled',
  'reporter.alerta.url',
  'reporter.alerta.apiKey',
  'reporter.alerta.endpoints',
  'reporter.alerta.priority',
]);

/**
 * Keys that existed once. A browser tab or a UI bundle from before a rename still sends them, so a
 * save drops them instead of failing. reporter.alerta.targets became reporter.alerta.endpoints
 * with alerta 2; the old value held phone names, which are no endpoint names, so it is not carried
 * over.
 */
const RETIRED_ALERTING_KEYS = new Set(['reporter.alerta.targets']);

/**
 * GET /api/alerting/settings
 * Returns the stored alerting settings as a flat key-value record. Only known keys: the UI posts
 * the whole record back, and a stale row would make that save fail.
 */
router.get('/api/alerting/settings', requireAuth, (req, res) => {
  try {
    const settings = Object.fromEntries(
      Object.entries(getAllSettings()).filter(([key]) => KNOWN_ALERTING_KEYS.has(key)),
    );
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerting/settings
 * Validates and bulk-saves alerting settings.
 * Drops retired keys, rejects unknown keys with 400.
 *
 * @body {{ settings: Record<string, string> }}
 */
router.post('/api/alerting/settings', requireAuth, requireCsrf, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: '"settings" must be a plain object.' });
  }
  const current = Object.fromEntries(Object.entries(settings).filter(([k]) => !RETIRED_ALERTING_KEYS.has(k)));
  const unknownKeys = Object.keys(current).filter((k) => !KNOWN_ALERTING_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return res.status(400).json({ error: `Unknown settings keys: ${unknownKeys.join(', ')}` });
  }
  try {
    setSettings(current);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerting/test/webhook
 * Sends a test payload to a webhook URL (uses current form values, not saved config).
 *
 * @body {{ url: string, headers: {key: string, value: string}[], body: {key: string, value: string}[] }}
 */
router.post('/api/alerting/test/webhook', requireAuth, requireCsrf, async (req, res) => {
  const { url, headers, body } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  const result = await testWebhook({ url, headers: headers ?? [], body: body ?? [] });
  res.json(result);
});

/**
 * POST /api/alerting/test/ntfy
 * Sends a test notification to a ntfy server (uses current form values, not saved config).
 *
 * @body {{ serverUrl: string, topic: string, priority: string, token?: string }}
 */
router.post('/api/alerting/test/ntfy', requireAuth, requireCsrf, async (req, res) => {
  const { serverUrl, topic, priority, token } = req.body;
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ ok: false, error: 'topic is required' });
  }
  const result = await testNtfy({
    serverUrl: serverUrl || 'https://ntfy.sh',
    topic,
    priority: priority || 'default',
    token: token || '',
  });
  res.json(result);
});

/**
 * POST /api/alerting/test/alerta
 * Sends a test push through alerta (uses current form values, not saved config).
 *
 * @body {{ url: string, apiKey: string, endpoints: string, priority?: string }}
 */
router.post('/api/alerting/test/alerta', requireAuth, requireCsrf, async (req, res) => {
  const { url, apiKey, endpoints, priority } = req.body;
  for (const [name, value] of Object.entries({ url, apiKey, endpoints })) {
    if (!value || typeof value !== 'string') {
      return res.status(400).json({ ok: false, error: `${name} is required` });
    }
  }
  const result = await testAlerta({ url, apiKey, endpoints, priority: priority || 'active' });
  res.json(result);
});

/**
 * POST /api/notification-prefs
 * Toggle alert notifications for a monitored process.
 *
 * @body {{ pm2Name: string, alertsEnabled: boolean }}
 */
router.post('/api/notification-prefs', requireAuth, requireCsrf, (req, res) => {
  const { pm2Name, alertsEnabled } = req.body;
  if (!pm2Name || typeof pm2Name !== 'string') {
    return res.status(400).json({ error: '"pm2Name" must be a non-empty string.' });
  }
  if (typeof alertsEnabled !== 'boolean') {
    return res.status(400).json({ error: '"alertsEnabled" must be a boolean.' });
  }
  try {
    setAlertsEnabled(pm2Name, alertsEnabled);
    res.json({ ok: true, pm2Name, alertsEnabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// General settings routes ──────────────────────────────────────────────────

/**
 * Keys whose values must never be exposed to the client.
 * AUTH_PASSWORD_SALT and AUTH_PASSWORD_HASH are security-sensitive and are
 * changed only via the `authPassword` field on the POST endpoint.
 */
const HIDDEN_ENV_KEYS = new Set(['AUTH_PASSWORD_SALT', 'AUTH_PASSWORD_HASH']);

/**
 * Parse a .env file into a key/value record, skipping comments, blank lines,
 * and any keys in `HIDDEN_ENV_KEYS`.
 *
 * @param {string} content - Raw .env file content.
 * @returns {Record<string, string>}
 */
function parseEnvFile(content) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !HIDDEN_ENV_KEYS.has(match[1])) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

/**
 * GET /api/settings/general
 * Reads the .env file from disk and returns all non-sensitive KEY=VALUE pairs.
 * Returns an empty object when the file does not exist.
 */
router.get('/api/settings/general', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const envPath = config.ENV_FILE_PATH;
    let content = '';
    try {
      content = fs.readFileSync(envPath, 'utf8');
    } catch {
      // .env does not exist - return empty settings.
    }
    res.json({ settings: parseEnvFile(content) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/settings/general
 * Writes updated general settings back to the .env file on disk.
 *
 * Accepts raw env key names (HOST, PORT, ...) directly.
 * Preserves comments and unrelated lines.
 *
 * Special case: if `authPassword` key is present and non-empty, derives a new
 * salt+hash via scryptSync and writes AUTH_PASSWORD_SALT + AUTH_PASSWORD_HASH
 * instead of storing the plaintext password.
 *
 * @body {{ settings: Record<string, string> }}
 */
router.post('/api/settings/general', requireAuth, requireCsrf, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: '"settings" must be a plain object.' });
  }

  // Values are written verbatim as KEY=VALUE lines. A line break in a value
  // would inject arbitrary additional env entries (e.g. overwriting
  // AUTH_PASSWORD_HASH), so reject any value containing CR or LF.
  const lineBreakKeys = Object.entries(settings)
    .filter(([key]) => key !== 'authPassword')
    .filter(([, value]) => value != null && /[\r\n]/.test(String(value)))
    .map(([key]) => key);
  if (lineBreakKeys.length > 0) {
    return res.status(400).json({ error: `Values must not contain line breaks: ${lineBreakKeys.join(', ')}` });
  }

  try {
    const envPath = config.ENV_FILE_PATH;

    // Read existing .env or start empty.
    let envContent = '';
    try {
      envContent = fs.readFileSync(envPath, 'utf8');
    } catch {
      // .env may not exist yet - will be created.
    }

    const lines = envContent.split('\n');

    /** @type {Map<string, string>} envKey -> new value */
    const updates = new Map();

    // Handle password change: derive new salt+hash, never store plaintext.
    // The password is hashed exactly as typed: the login form does not trim
    // either, so trimming here would lock out a password with outer spaces.
    // A blank or whitespace-only value means "keep the current password".
    if (typeof settings.authPassword === 'string' && settings.authPassword.trim()) {
      const newSalt = crypto.randomBytes(16);
      const newHash = crypto.scryptSync(settings.authPassword, newSalt, 64);
      updates.set('AUTH_PASSWORD_SALT', newSalt.toString('hex'));
      updates.set('AUTH_PASSWORD_HASH', newHash.toString('hex'));
    }

    // All other keys are written directly as-is (raw env key names).
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'authPassword') continue;
      if (value === undefined || value === null) continue;
      // Only accept valid env key format and skip hidden keys.
      if (/^[A-Z_][A-Z0-9_]*$/.test(key) && !HIDDEN_ENV_KEYS.has(key)) {
        updates.set(key, String(value));
      }
    }

    // Replace matching KEY=VALUE lines; track which keys were already in the file.
    const found = new Set();
    const updated = lines.map((line) => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) {
        const key = match[1];
        if (updates.has(key)) {
          found.add(key);
          return `${key}=${updates.get(key)}`;
        }
      }
      return line;
    });

    // Append keys that were not already present in the file.
    for (const [key, value] of updates) {
      if (!found.has(key)) {
        updated.push(`${key}=${value}`);
      }
    }

    fs.writeFileSync(envPath, updated.join('\n'), 'utf8');
    logger.info(`[SETTINGS] General settings updated by user: ${req.session.username}`);
    res.json({ ok: true, restartRequired: true });
  } catch (error) {
    logger.warn(`[SETTINGS] Failed to write .env: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// MCP server routes ──────────────────────────────────────────────────────

/**
 * What the MCP settings page shows: the server switch, the access key and
 * every tool with its current state.
 *
 * @returns {{ enabled: boolean, key: string | null, tools: object[] }}
 */
function mcpSettingsPayload() {
  const settings = getMcpSettings();
  return { enabled: settings.enabled, key: settings.key, tools: listToolStates(settings.toolOverrides) };
}

/**
 * GET /api/mcp/settings
 * The MCP server settings, including the access key in plain text.
 */
router.get('/api/mcp/settings', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(mcpSettingsPayload());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mcp/settings
 * Turn the MCP server on or off and change single tools. Both fields are
 * optional; turning the server on the first time creates the access key.
 * Answers with the full settings, like the GET.
 *
 * @body {{ enabled?: boolean, tools?: Record<string, boolean> }}
 */
router.post('/api/mcp/settings', requireAuth, requireCsrf, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { enabled, tools } = req.body;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" must be a boolean.' });
  }
  if (tools !== undefined && (tools === null || typeof tools !== 'object' || Array.isArray(tools))) {
    return res.status(400).json({ error: '"tools" must be a plain object.' });
  }
  try {
    if (tools !== undefined) {
      const result = applyToolChanges(getMcpSettings().toolOverrides, tools);
      if (!result.ok) {
        return res.status(400).json({ error: result.error });
      }
      setToolOverrides(result.overrides);
    }
    if (enabled !== undefined) {
      setMcpEnabled(enabled);
    }
    const changes = [
      enabled !== undefined ? `server ${enabled ? 'on' : 'off'}` : null,
      tools !== undefined
        ? Object.entries(tools)
            .map(([name, on]) => `${name} ${on ? 'on' : 'off'}`)
            .join(', ')
        : null,
    ].filter(Boolean);
    logger.info(`[MCP] User: ${req.session.username} changed MCP settings: ${changes.join('; ') || 'nothing'}`);
    res.json(mcpSettingsPayload());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/mcp/key/rotate
 * Replace the access key. Clients with the old key are refused from the next
 * request on. Answers with the full settings, including the new key.
 */
router.post('/api/mcp/key/rotate', requireAuth, requireCsrf, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    rotateMcpKey();
    logger.info(
      `[MCP] User: ${req.session.username} rotated the MCP access key from identity: ${getClientIdentity(req)}`,
    );
    res.json(mcpSettingsPayload());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deployment routes ───────────────────────────────────────────────────────

/** Validate that a deployment ID is a UUID-shaped string. */
function validateDeploymentId(req, res, next) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(req.params.deploymentId)) {
    return res.status(400).json({ error: 'Invalid deployment ID.' });
  }
  next();
}

/**
 * GET /api/deployments
 * Return all deployment records.
 */
router.get('/api/deployments', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ deployments: getAllDeployments() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/deployments
 * Create a new deployment record and kick off the async deploy sequence.
 * Returns 202 immediately; progress is streamed via WebSocket.
 */
router.post('/api/deployments', requireAuth, requireCsrf, (req, res) => {
  try {
    const result = startDeployment(req.body);
    if (!result.ok) {
      return sendOperationError(res, result);
    }
    res.status(202).json({ ok: true, deploymentId: result.deploymentId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/deployments/:deploymentId
 * Update an existing deployment record.
 * Does not trigger a redeploy; changes take effect on the next redeploy, which
 * also follows a changed repository URL or branch.
 */
router.put('/api/deployments/:deploymentId', requireAuth, validateDeploymentId, requireCsrf, (req, res) => {
  try {
    const result = editDeployment(req.params.deploymentId, req.body);
    if (!result.ok) {
      return sendOperationError(res, result);
    }
    res.json({ ok: true, deployment: result.deployment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/deployments/:deploymentId/redeploy
 * Pull latest changes and restart an existing deployment.
 * Returns 202 immediately; progress is streamed via WebSocket.
 */
router.post('/api/deployments/:deploymentId/redeploy', requireAuth, validateDeploymentId, requireCsrf, (req, res) => {
  const result = startRedeploy(req.params.deploymentId);
  if (!result.ok) {
    return sendOperationError(res, result);
  }
  res.status(202).json({ ok: true, deploymentId: result.deploymentId });
});

/**
 * POST /api/deployments/:deploymentId/confirm
 * Resolve a pending deployment confirmation.
 * Body: { confirmed: boolean }: true to discard local changes and continue, false to cancel.
 * Answers 409 when nothing is waiting (the 60 s window already closed).
 */
router.post('/api/deployments/:deploymentId/confirm', requireAuth, validateDeploymentId, requireCsrf, (req, res) => {
  const { confirmed } = req.body;
  if (typeof confirmed !== 'boolean') {
    return res.status(400).json({ error: 'confirmed (boolean) is required' });
  }
  const result = confirmDeployment(req.params.deploymentId, confirmed);
  if (!result.ok) {
    return sendOperationError(res, result);
  }
  res.json({ ok: true });
});

/**
 * DELETE /api/deployments/:deploymentId
 * Remove the deployment record from the database.
 * Does not stop the running PM2 process.
 */
router.delete('/api/deployments/:deploymentId', requireAuth, validateDeploymentId, requireCsrf, (req, res) => {
  try {
    const result = removeDeployment(req.params.deploymentId);
    if (!result.ok) {
      return sendOperationError(res, result);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Express Router for PM2-Hawkeye.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
  validateAppName,
  validateRepoUrl,
  validateBranch,
  resolveDeployPath,
  runDeploy,
  resolveConfirmation,
} from '../service/deployRunner.js';
import {
  createDeployment,
  updateDeployment,
  getDeploymentByName,
  getDeploymentById,
  getAllDeployments,
  deleteDeployment,
  DEFAULT_WATCH_INTERVAL_MINUTES,
} from '../storage/deploymentStorage.js';
import { getUpdateInfo } from '../service/updateChecker.js';
import {
  isMonitored,
  addMonitored,
  removeMonitored,
  getByPm2Name,
  setAlertsEnabled,
} from '../storage/monitoringStorage.js';
import { getMetrics, getCustomMetrics } from '../storage/metricsStorage.js';
import { getHostMetricsWindow } from '../storage/hostMetricsStorage.js';
import { getLastHostReading } from '../service/hostMetricsCollector.js';
import { getLogEntries } from '../storage/logStorage.js';
import { backfillLogs } from '../service/logBackfill.js';
import { getAllSettings, setSettings } from '../storage/alertingSettingsStorage.js';
import { testWebhook } from '../service/reporters/webhook.js';
import { testNtfy } from '../service/reporters/ntfy.js';
import logger from '../service/logger.js';
import { buildProcessList } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const APP_VERSION = packageJson.version;

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
 * Find the PM2 process a route's `:id` refers to.
 *
 * A pm_id match wins over a name match, so a numeric id always addresses that
 * one instance. Routes act on the returned `pm_id` rather than passing the raw
 * parameter to PM2, which would read `all` as every process and an unknown
 * word as a namespace.
 *
 * @param {string} id - pm_id or name from the URL.
 * @returns {Promise<object | null>} Raw PM2 descriptor, or null if not running.
 */
async function findProcess(id) {
  const processes = await pm2.loadProcessList();
  return (
    processes.find((entry) => String(entry.pm_id) === String(id)) ??
    processes.find((entry) => entry.name === id) ??
    null
  );
}

/**
 * Resolve a process id or name to the fields the log level service needs.
 *
 * The service keys its state on `pm_uptime`, so the caller has to load the
 * process anyway. Doing it here also lets both routes answer 404 and 409
 * before a message is sent to anything.
 *
 * @param {string} id - Process id or name from the URL.
 * @returns {Promise<{ok: true, pmId: number, name: string}|{ok: false, status: number, error: string}>}
 */
async function findOnlineProcess(id) {
  const proc = await findProcess(id);
  if (!proc) {
    return { ok: false, status: 404, error: 'Process not found' };
  }
  if (proc.pm2_env?.status !== 'online') {
    return { ok: false, status: 409, error: 'Process is not online' };
  }
  return {
    ok: true,
    pmId: proc.pm_id,
    name: proc.name,
  };
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
    version: APP_VERSION,
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
    const proc = await findProcess(req.params.id);
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
    const proc = await findProcess(req.params.id);
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
    const proc = await findProcess(req.params.id);
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
    const target = await findOnlineProcess(req.params.id);
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

    const target = await findOnlineProcess(req.params.id);
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
      const proc = await findProcess(req.params.id);
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
    const proc = await findProcess(req.params.id);
    if (!proc) {
      return res.status(404).json({ error: 'Process not found' });
    }
    const pm2Name = proc.name;
    const deleteDeploy = req.query.deleteDeploy === 'true';
    const deployment = deleteDeploy ? getDeploymentByName(pm2Name) : null;
    if (deployment?.deploying) {
      return res.status(409).json({ error: 'Cannot delete a deployment that is currently in progress.' });
    }

    const targets = deleteDeploy
      ? (await pm2.loadProcessList()).filter((p) => p.name === pm2Name).map((p) => p.pm_id)
      : [proc.pm_id];

    logger.info(
      `[ACTION] User: ${req.session.username} is deleting process: ${pm2Name} (pm_id ${targets.join(', ')}) from identity: ${getClientIdentity(req)}`,
    );
    for (const pmId of targets) {
      await pm2.deleteProcess(pmId);
    }

    const stillRunning = (await pm2.loadProcessList()).some((p) => p.name === pm2Name);
    if (!stillRunning) {
      removeMonitored(pm2Name);
    }

    if (deployment) {
      try {
        await fs.promises.rm(deployment.deploy_path, { recursive: true, force: true });
        logger.info(`[ACTION] Deleted deploy directory: ${deployment.deploy_path}`);
      } catch (rmErr) {
        logger.warn(`[ACTION] Could not delete deploy directory ${deployment.deploy_path}: ${rmErr.message}`);
      }
      deleteDeployment(deployment.id);
      logger.info(`[ACTION] Deleted deployment record for: ${pm2Name}`);
    }

    res.json({ ok: true, processId: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Monitoring routes ────────────────────────────────────────────────────────

/**
 * Resolve a process `:id` param to its PM2 name.
 * Returns null if the process is not found in PM2 (may still be an orphan).
 *
 * @param {string} id - PM2 process name or numeric ID string.
 * @returns {Promise<string | null>}
 */
async function resolvePm2Name(id) {
  return (await findProcess(id))?.name ?? null;
}

router.get('/api/processes/:id/monitoring', requireAuth, validateProcessId, async (req, res) => {
  try {
    const pm2Name = (await resolvePm2Name(req.params.id).catch(() => null)) ?? req.params.id;
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
    if (monitored) {
      if (!isMonitored(pm2Name)) {
        const newRow = addMonitored(pm2Name);
        // Backfill all existing log lines asynchronously - fire-and-forget.
        backfillLogs(pm2Name, newRow.id);
      }
    } else {
      removeMonitored(pm2Name);
    }
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
    const pm2Name = (await resolvePm2Name(req.params.id).catch(() => null)) ?? req.params.id;
    const row = getByPm2Name(pm2Name);
    if (!row) {
      return res.json({ pm2Name, samples: [], custom: [] });
    }
    res.json({ pm2Name, samples: getMetrics(row.id), custom: getCustomMetrics(row.id) });
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

/** Maximum number of stored log entries returned by one request. */
const MAX_STORED_LOG_LIMIT = 500;

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
  if (limit === null || limit > MAX_STORED_LOG_LIMIT) {
    return { ok: false, error: `limit must be a whole number between 1 and ${MAX_STORED_LOG_LIMIT}` };
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
    const pm2Name = (await resolvePm2Name(req.params.id).catch(() => null)) ?? req.params.id;
    const row = getByPm2Name(pm2Name);
    if (!row) {
      return res.json({ pm2Name, entries: [], nextCursor: null });
    }
    const fetched = getLogEntries(row.id, { ...page, limit: page.limit + 1 });
    const hasMore = fetched.length > page.limit;
    const entries = hasMore ? fetched.slice(0, page.limit) : fetched;
    const last = entries.at(-1);
    const nextCursor = hasMore && last ? { before: last.logged_at, beforeId: last.id } : null;
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
]);

/**
 * GET /api/alerting/settings
 * Returns all stored alerting settings as a flat key-value record.
 */
router.get('/api/alerting/settings', requireAuth, (req, res) => {
  try {
    const settings = getAllSettings();
    res.json({ settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerting/settings
 * Validates and bulk-saves alerting settings.
 * Rejects unknown keys with 400.
 *
 * @body {{ settings: Record<string, string> }}
 */
router.post('/api/alerting/settings', requireAuth, requireCsrf, (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: '"settings" must be a plain object.' });
  }
  const unknownKeys = Object.keys(settings).filter((k) => !KNOWN_ALERTING_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return res.status(400).json({ error: `Unknown settings keys: ${unknownKeys.join(', ')}` });
  }
  try {
    setSettings(settings);
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

// Deployment routes ───────────────────────────────────────────────────────

/** Validate that a deployment ID is a UUID-shaped string. */
function validateDeploymentId(req, res, next) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(req.params.deploymentId)) {
    return res.status(400).json({ error: 'Invalid deployment ID.' });
  }
  next();
}

/** Upper bound for the branch-watch poll interval (24 hours, in minutes). */
const MAX_WATCH_INTERVAL_MINUTES = 1440;

/**
 * Normalise the branch-watching fields of a deployment request body.
 *
 * @param {object} body - Parsed request body.
 * @returns {{ ok: true, watchEnabled: boolean, watchIntervalMinutes: number } | { ok: false, error: string }}
 */
function parseWatchFields(body) {
  const minutes = Number(body.watchIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WATCH_INTERVAL_MINUTES) {
    return {
      ok: false,
      error: `Invalid watch interval. Use a whole number of minutes between 1 and ${MAX_WATCH_INTERVAL_MINUTES}.`,
    };
  }
  return { ok: true, watchEnabled: body.watchEnabled === true, watchIntervalMinutes: minutes };
}

/** True for a non-null object that is not an array. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate and normalise the editable fields of a deployment request body,
 * shared by create (POST) and update (PUT).
 *
 * Every field that later reaches git, a shell or PM2 is type-checked here,
 * at the trust boundary: the branch in particular is passed to
 * `git fetch origin <branch>` as an argument, so a value starting with `-`
 * would be read as an option.
 *
 * @param {object} body - Parsed request body.
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
function parseDeploymentBody(body) {
  const {
    repoUrl,
    branch = 'main',
    startScript = 'index.js',
    installCmd = 'npm install',
    buildCmd = '',
    preSetupScript = '',
    postSetupScript = '',
    envVars = {},
    pm2Options = {},
  } = body;

  if (!validateRepoUrl(repoUrl)) {
    return {
      ok: false,
      error:
        'Invalid repo URL. Accepted: HTTPS GitHub/GitLab URLs or SSH git URLs (e.g. git@github.com:user/repo.git).',
    };
  }
  if (!validateBranch(branch)) {
    return { ok: false, error: 'Invalid branch name.' };
  }
  if (typeof startScript !== 'string' || !startScript.trim()) {
    return { ok: false, error: 'Start script must be a non-empty string.' };
  }
  if (typeof installCmd !== 'string' || !installCmd.trim()) {
    return { ok: false, error: 'Install command must be a non-empty string.' };
  }
  for (const [label, value] of [
    ['Build command', buildCmd],
    ['Pre-setup script', preSetupScript],
    ['Post-setup script', postSetupScript],
  ]) {
    if (value !== null && typeof value !== 'string') {
      return { ok: false, error: `${label} must be a string.` };
    }
  }
  if (!isPlainObject(envVars) || !Object.values(envVars).every((v) => typeof v === 'string')) {
    return { ok: false, error: 'Environment variables must be an object of strings.' };
  }
  if (!isPlainObject(pm2Options)) {
    return { ok: false, error: 'PM2 options must be an object.' };
  }

  const watch = parseWatchFields(body);
  if (!watch.ok) {
    return { ok: false, error: watch.error };
  }

  return {
    ok: true,
    fields: {
      repoUrl,
      branch,
      startScript: startScript.trim(),
      installCmd: installCmd.trim(),
      buildCmd: buildCmd || null,
      preSetupScript: preSetupScript || null,
      postSetupScript: postSetupScript || null,
      envVars,
      pm2Options,
      watchEnabled: watch.watchEnabled,
      watchIntervalMinutes: watch.watchIntervalMinutes,
      discardLocalChanges: body.discardLocalChanges === true,
    },
  };
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
router.post('/api/deployments', requireAuth, requireCsrf, async (req, res) => {
  const { appName } = req.body;
  if (!validateAppName(appName)) {
    return res.status(400).json({
      error:
        'Invalid app name. Use alphanumeric characters, dashes, and underscores (max 64 chars), not only digits and not "all".',
    });
  }

  const parsed = parseDeploymentBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  let deployPath;
  try {
    deployPath = resolveDeployPath(appName);
  } catch {
    return res.status(400).json({ error: 'Deploy path would escape the base directory.' });
  }

  const existing = getDeploymentByName(appName);
  if (existing) {
    return res
      .status(409)
      .json({ error: `A deployment named "${appName}" already exists. Use the redeploy endpoint to update it.` });
  }

  let record;
  try {
    record = createDeployment({ pm2Name: appName, deployPath, ...parsed.fields });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Fetch the full record (with JSON fields parsed) for runDeploy.
  const fullRecord = getDeploymentById(record.id);

  // Fire-and-forget - progress streams via WebSocket.
  runDeploy(fullRecord, { isRedeploy: false }).catch(() => {});

  logger.info(`[DEPLOY] Started deployment for "${appName}" from ${parsed.fields.repoUrl}`);
  res.status(202).json({ ok: true, deploymentId: record.id });
});

/**
 * PUT /api/deployments/:deploymentId
 * Update an existing deployment record.
 * Does not trigger a redeploy; changes take effect on the next redeploy, which
 * also follows a changed repository URL or branch.
 */
router.put('/api/deployments/:deploymentId', requireAuth, validateDeploymentId, requireCsrf, (req, res) => {
  const deployment = getDeploymentById(req.params.deploymentId);
  if (!deployment) {
    return res.status(404).json({ error: 'Deployment not found.' });
  }
  if (deployment.deploying) {
    return res.status(409).json({ error: 'Cannot edit a deployment that is currently in progress.' });
  }

  const parsed = parseDeploymentBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  try {
    updateDeployment(req.params.deploymentId, parsed.fields);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  logger.info(`[DEPLOY] Updated deployment record for "${deployment.pm2_name}"`);
  res.json({ ok: true, deployment: getDeploymentById(req.params.deploymentId) });
});

/**
 * POST /api/deployments/:deploymentId/redeploy
 * Pull latest changes and restart an existing deployment.
 * Returns 202 immediately; progress is streamed via WebSocket.
 */
router.post(
  '/api/deployments/:deploymentId/redeploy',
  requireAuth,
  validateDeploymentId,
  requireCsrf,
  async (req, res) => {
    const deployment = getDeploymentById(req.params.deploymentId);
    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found.' });
    }
    if (deployment.deploying) {
      return res.status(409).json({ error: 'A deployment is already in progress for this app.' });
    }

    runDeploy(deployment, { isRedeploy: true }).catch(() => {});

    logger.info(`[DEPLOY] Started redeploy for "${deployment.pm2_name}"`);
    res.status(202).json({ ok: true, deploymentId: deployment.id });
  },
);

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

  if (!resolveConfirmation(req.params.deploymentId, confirmed)) {
    return res.status(409).json({ error: 'No confirmation is pending for this deployment. It may have timed out.' });
  }
  logger.info(
    `[DEPLOY] Confirmation ${confirmed ? 'accepted' : 'rejected'} for deployment "${req.params.deploymentId}"`,
  );
  res.json({ ok: true });
});

/**
 * DELETE /api/deployments/:deploymentId
 * Remove the deployment record from the database.
 * Does not stop the running PM2 process.
 */
router.delete('/api/deployments/:deploymentId', requireAuth, validateDeploymentId, requireCsrf, (req, res) => {
  const deployment = getDeploymentById(req.params.deploymentId);
  if (!deployment) {
    return res.status(404).json({ error: 'Deployment not found.' });
  }
  if (deployment.deploying) {
    return res.status(409).json({ error: 'Cannot delete a deployment that is currently in progress.' });
  }

  try {
    deleteDeployment(req.params.deploymentId);
    logger.info(`[DEPLOY] Deleted deployment record for "${deployment.pm2_name}"`);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

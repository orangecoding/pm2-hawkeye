/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Express Router for PM2 Manager.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { setSessionCookie, clearSessionCookie, getClientIdentity } from '../security/security.js';
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
import { getUpdateInfo } from '../service/updateChecker.js';
import { isMonitored, addMonitored, removeMonitored, getByPm2Name, getAllMonitored } from '../storage/monitoringStorage.js';
import { getMetrics } from '../storage/metricsStorage.js';
import { getLogEntries } from '../storage/logStorage.js';
import { backfillLogs } from '../service/logBackfill.js';
import logger from '../service/logger.js';

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
    const { limited, retryAfterMs } = checkUnauthWindow(identity, Date.now());
    logger.warn(`[AUTH_UNAUTHORIZED] Access denied to ${req.method} ${req.path} from identity: ${identity}`);

    if (limited) {
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
  const now = Date.now();
  const windowCheck = checkLoginWindow(identity, now);

  let statusCode;
  let payload;
  let retryAfterSeconds = null;
  let sessionToken = null;

  if (!windowCheck.allowed) {
    statusCode = 429;
    retryAfterSeconds = Math.max(Math.ceil(windowCheck.retryAfterMs / 1000), 1);
    payload = { error: 'Too many login attempts. Try again later.', retryAfterSeconds };
    logger.warn(`[AUTH_FAILURE] Rate-limit (window) exceeded for identity: ${identity}`);
  } else {
    const penaltyMs = getPenalty(identity, now);

    if (penaltyMs > 0) {
      statusCode = 429;
      retryAfterSeconds = Math.max(Math.ceil(penaltyMs / 1000), 1);
      payload = { error: 'Too many login attempts. Try again later.', retryAfterSeconds };
      logger.warn(`[AUTH_FAILURE] Rate-limit (penalty) exceeded for identity: ${identity}`);
    } else {
      const { username, password } = req.body;
      if (!username || !password) {
        statusCode = 400;
        payload = { error: 'Username and password are required.' };
        logger.warn(`[AUTH_FAILURE] Missing credentials from identity: ${identity}`);
      } else if (!verifyCredentials(username, password)) {
        const lockoutMs = registerFailedAttempt(identity, Date.now());
        statusCode = 401;
        payload = { error: 'Invalid credentials.' };
        if (lockoutMs > 0) {
          payload.retryAfterSeconds = Math.max(Math.ceil(lockoutMs / 1000), 1);
        }
        logger.warn(`[AUTH_FAILURE] Invalid credentials for user: ${username} from identity: ${identity}`);
      } else {
        clearFailedAttempts(identity);
        destroySession(req);
        const newSession = createSession(config.AUTH_USERNAME);
        sessionToken = newSession.token;
        statusCode = 200;
        logger.info(`[AUTH_SUCCESS] Login successful for user: ${username} from identity: ${identity}`);
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

/** Validate that a process ID param is a safe integer or simple name. */
function validateProcessId(req, res, next) {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid process identifier.' });
  }
  next();
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
    metricsRetentionMs: config.METRICS_RETENTION_MS,
    logsRetentionMs: config.LOGS_RETENTION_MS,
  });
});

router.get('/api/update', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ update: getUpdateInfo() });
});

router.post('/api/auth/logout', requireAuth, (req, res) => {
  if (!consumeCsrfToken(req, req.session)) {
    logger.warn(
      `[SECURITY] CSRF token mismatch for user: ${req.session.username} from identity: ${getClientIdentity(req)}`,
    );
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }
  logger.info(
    `[AUTH_SUCCESS] Logout successful for user: ${req.session.username} from identity: ${getClientIdentity(req)}`,
  );
  destroySession(req);
  clearSessionCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

router.get('/api/processes', requireAuth, async (req, res) => {
  try {
    const processes = await pm2.loadProcessList();
    const normalised = processes.map(pm2.normalizeProcessSummary);

    // Annotate each process with monitoring state so the initial REST response
    // matches what the WebSocket stream sends.  Without this, isMonitored is
    // undefined on first render, causing a visible flash where stored logs
    // briefly disappear while the frontend waits for the first WS tick.
    let monitoredRows = [];
    try {
      monitoredRows = getAllMonitored();
    } catch {
      // DB may not be ready - degrade gracefully.
    }
    const monitoredMap = new Map(monitoredRows.map((r) => [r.pm2_name, r]));

    const items = normalised
      .map((item) => ({ ...item, isMonitored: !!monitoredMap.get(item.name), isOrphan: false }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));

    res.json({
      host: config.HOST,
      port: config.PORT,
      processCount: items.length,
      generatedAt: Date.now(),
      items,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/api/processes/:id', requireAuth, validateProcessId, async (req, res) => {
  try {
    const details = await pm2.loadProcessDetails(req.params.id);
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
    const actions = await pm2.getProcessActions(req.params.id);
    res.json({ processId: req.params.id, actions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/processes/:id/actions/trigger', requireAuth, validateProcessId, async (req, res) => {
  try {
    if (!consumeCsrfToken(req, req.session)) {
      logger.warn(
        `[SECURITY] CSRF token mismatch for user: ${req.session.username} during action trigger on process ${req.params.id} from identity: ${getClientIdentity(req)}`,
      );
      return res.status(403).json({ error: 'CSRF token mismatch' });
    }
    const { actionName } = req.body;
    if (!actionName || typeof actionName !== 'string') {
      return res.status(400).json({ error: 'actionName is required' });
    }
    logger.info(
      `[ACTION] User: ${req.session.username} is triggering action: ${actionName} on process: ${req.params.id} from identity: ${getClientIdentity(req)}`,
    );
    const { params } = req.body;
    const output = await pm2.triggerProcessAction(req.params.id, actionName, params);
    res.json({ ok: true, processId: req.params.id, actionName, output });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/processes/:id/restart', requireAuth, validateProcessId, async (req, res) => {
  try {
    if (!consumeCsrfToken(req, req.session)) {
      logger.warn(
        `[SECURITY] CSRF token mismatch for user: ${req.session.username} during restart of process ${req.params.id} from identity: ${getClientIdentity(req)}`,
      );
      return res.status(403).json({ error: 'CSRF token mismatch' });
    }
    logger.info(
      `[ACTION] User: ${req.session.username} is restarting process: ${req.params.id} from identity: ${getClientIdentity(req)}`,
    );
    await pm2.restartProcess(req.params.id);
    const details = await pm2.loadProcessDetails(req.params.id);
    res.json({ ok: true, processId: req.params.id, details });
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
  const processes = await pm2.loadProcessList();
  const proc = processes.find((p) => p.name === id || String(p.pm_id) === id);
  return proc?.name ?? null;
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
router.post('/api/monitoring', requireAuth, async (req, res) => {
  try {
    if (!consumeCsrfToken(req, req.session)) {
      logger.warn(
        `[SECURITY] CSRF token mismatch for user: ${req.session.username} during monitoring toggle for process ${req.body.pm2Name} from identity: ${getClientIdentity(req)}`,
      );
      return res.status(403).json({ error: 'CSRF token mismatch' });
    }
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

router.get('/api/processes/:id/metrics', requireAuth, validateProcessId, async (req, res) => {
  try {
    const pm2Name = (await resolvePm2Name(req.params.id).catch(() => null)) ?? req.params.id;
    const row = getByPm2Name(pm2Name);
    if (!row) {
      return res.json({ pm2Name, samples: [] });
    }
    const samples = getMetrics(row.id);
    res.json({ pm2Name, samples });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/processes/:id/logs/stored', requireAuth, validateProcessId, async (req, res) => {
  try {
    const pm2Name = (await resolvePm2Name(req.params.id).catch(() => null)) ?? req.params.id;
    const row = getByPm2Name(pm2Name);
    if (!row) {
      return res.json({ pm2Name, entries: [] });
    }
    const limitParam = req.query.limit ? parseInt(req.query.limit, 10) : 200;
    const beforeParam = req.query.before ? parseInt(req.query.before, 10) : undefined;
    const entries = getLogEntries(row.id, { limit: limitParam, before: beforeParam });
    res.json({ pm2Name, entries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

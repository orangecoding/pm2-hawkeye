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
} from '../security/auth.js';
import * as pm2 from '../service/pm2Service.js';
import logger from "../service/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const APP_VERSION = packageJson.version;

const router = express.Router();

// Auth Middleware ─────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const session = getAuthenticatedSession(req);
  if (!session) {
    const identity = getClientIdentity(req);
    logger.warn(`[AUTH_UNAUTHORIZED] Access denied to ${req.method} ${req.path} from identity: ${identity}`);
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
  if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
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
  });
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
    const items = processes
      .map(pm2.normalizeProcessSummary)
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

export default router;

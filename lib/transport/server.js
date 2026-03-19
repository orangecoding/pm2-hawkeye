/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Application entry point.
 */

import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import config from '../config.js';
import router from './router.js';
import { attachWebSocketServer } from './ws.js';
import { securityMiddleware } from '../security/security.js';
import { purgeExpiredSessions } from '../security/session.js';
import { purgeExpiredEntries } from '../security/auth.js';
import { startUpdateChecker } from '../service/updateChecker.js';
import { startMetricsScheduler } from '../service/metricsScheduler.js';
import { startLogBus } from '../service/logBus.js';
import { startupBackfillAllMonitored } from '../service/logBackfill.js';
import { initDb } from '../storage/db.js';
import logger from '../service/logger.js';

// Initialise SQLite database and run migrations before starting the server.
// Skipped in test mode: test/setup.mjs initialises an in-memory database first.
if (process.env.NODE_ENV !== 'test') {
  await initDb(config.SQLITE_DB_PATH);
}

const app = express();

// Housekeeping
setInterval(() => {
  purgeExpiredSessions();
  purgeExpiredEntries();
}, 60 * 1000).unref();

// Update checker, metrics scheduler, log bus and startup backfill (skipped in test env)
if (process.env.NODE_ENV !== 'test') {
  await startupBackfillAllMonitored();
  startLogBus();
  startUpdateChecker();
  startMetricsScheduler();
}

// Express configuration
if (config.TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// Hide Express fingerprint
app.disable('x-powered-by');

// Middleware
app.use(securityMiddleware);
app.use(cookieParser());
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// Routes
app.use(router);

// Static assets (public ones)
app.use(
  express.static(config.PUBLIC_DIR, {
    index: false,
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }),
);

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);
attachWebSocketServer(server);

// Start server (skipped when imported by the test suite)
if (process.env.NODE_ENV !== 'test') {
  server.listen(config.PORT, config.HOST, () => {
    logger.info(`PM2-Hawkeye listening on http://${config.HOST}:${config.PORT}`);
  });
}

export default app; // For testing

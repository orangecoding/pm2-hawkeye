/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Application entry point.
 */

// Must stay the first import: aborts startup on unsupported runtimes (for
// example Bun, where the native SQLite addon segfaults) before any native
// module is loaded.
import '../runtimeGuard.js';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import config from '../config.js';
import router from './router.js';
import { attachWebSocketServer } from './ws.js';
import { startRuntime } from './startup.js';
import { securityMiddleware } from '../security/security.js';
import { purgeExpiredSessions } from '../security/session.js';
import { purgeExpiredEntries } from '../security/auth.js';
import { startUpdateChecker } from '../service/updateChecker.js';
import { startMetricsScheduler } from '../service/metricsScheduler.js';
import { startBranchWatcher } from '../service/branchWatcher.js';
import { startLogBus } from '../service/logBus.js';
import { startupBackfillAllMonitored } from '../service/logBackfill.js';
import { checkPm2Requirement } from '../service/pm2Requirement.js';
import { initDb } from '../storage/db.js';
import { resetAllDeployingFlags } from '../storage/deploymentStorage.js';
import logger from '../service/logger.js';

// Abort unless PM2 >= 7 is installed and running, then initialise SQLite and
// run migrations before starting the server. Skipped in test mode: there is no
// PM2 daemon, and test/setup.mjs initialises an in-memory database first.
if (process.env.NODE_ENV !== 'test') {
  const pm2Problem = await checkPm2Requirement();
  if (pm2Problem) {
    logger.error(`[PM2] ${pm2Problem}`);
    process.exit(1);
  }

  await initDb(config.SQLITE_DB_PATH);
  const stuck = resetAllDeployingFlags();
  if (stuck > 0) {
    logger.warn(`[DEPLOY] Reset ${stuck} deployment(s) that were stuck in progress after a restart.`);
  }
}

const app = express();

// Housekeeping
setInterval(() => {
  purgeExpiredSessions();
  purgeExpiredEntries();
}, 60 * 1000).unref();

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
// Express 5 leaves req.body undefined when a request has no JSON body;
// handlers destructure it, so give them an empty object instead.
app.use((req, res, next) => {
  req.body ??= {};
  next();
});

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

// Final error handler. Without it Express answers body-parser failures (bad
// JSON, oversized body) and any thrown error with an HTML stack trace that
// includes absolute server paths, even to unauthenticated callers.
// eslint-disable-next-line no-unused-vars -- Express detects error handlers by arity.
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) {
    logger.error(`[HTTP] ${req.method} ${req.path} failed: ${err.stack || err.message}`);
  }
  // body-parser marks its own messages ("request entity too large") as safe to show.
  const message = status >= 500 ? 'Internal server error' : err.expose ? err.message : 'Bad request';
  res.status(status).json({ error: message });
});

// Create HTTP server and attach WebSocket server
const server = http.createServer(app);
attachWebSocketServer(server);

// Start server (skipped when imported by the test suite)
if (process.env.NODE_ENV !== 'test') {
  await startRuntime({
    startLogBus,
    startServices: () => {
      startUpdateChecker();
      startMetricsScheduler();
      startBranchWatcher();
    },
    listen: (onListening) => {
      server.listen(config.PORT, config.HOST, () => {
        logger.info(`PM2-Hawkeye listening on http://${config.HOST}:${config.PORT}`);
        onListening();
      });
    },
    backfill: startupBackfillAllMonitored,
    onBackfillError: (error) => {
      logger.warn(`[BACKFILL] Startup backfill failed: ${error.message}`);
    },
    onLogBusError: (error) => {
      logger.warn(`[LOG_BUS] Could not connect to the PM2 log bus, retrying in 5 s: ${error.message}`);
    },
  });
}

export default app; // For testing

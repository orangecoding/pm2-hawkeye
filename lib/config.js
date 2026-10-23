/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Centralised application configuration.
 *
 * Every tunable is read from environment variables (or a .env file located in
 * the project root, see ENV_FILE_PATH) and validated once at startup. The .env
 * values never enter `process.env`.  Importing this module from
 * any other file gives a single frozen configuration object.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The .env file read at startup and rewritten by the General settings page.
 * `HAWKEYE_ENV_FILE` points it elsewhere; the test suite uses that so it
 * never touches the real file.
 */
const ENV_FILE_PATH = process.env.HAWKEYE_ENV_FILE
  ? path.resolve(process.env.HAWKEYE_ENV_FILE)
  : path.resolve(__dirname, '..', '.env');

/**
 * Settings from the .env file, overlaid by the real environment (which wins,
 * as with plain dotenv).
 *
 * The file is parsed into this private object instead of being loaded into
 * `process.env`: PM2's client merges the caller's `process.env` into every app
 * it starts, so loading it there handed Hawkeye's PORT, password hash and
 * other settings to each deployed application and its build scripts.
 */
const fileEnv = {};
dotenv.config({ path: ENV_FILE_PATH, processEnv: fileEnv, quiet: true });
const env = { ...fileEnv, ...process.env };

/** Parse an integer from an env var with a fallback default. */
function envInt(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  // A non-numeric value (e.g. PORT=abc) would otherwise yield NaN and silently
  // misconfigure the app; fall back to the documented default instead.
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Read an env var as a string with a fallback default. */
function envStr(name, fallback) {
  return env[name] || fallback;
}

// ── Derived values ──────────────────────────────────────────────────────────

const AUTH_USERNAME = envStr('AUTH_USERNAME', 'admin');
const AUTH_PASSWORD_SALT_INPUT = envStr('AUTH_PASSWORD_SALT', 'NOT_SET');
const AUTH_PASSWORD_HASH_HEX = envStr('AUTH_PASSWORD_HASH', 'NOT_SET');

/** Pre-computed SHA-256 digest of the normalised username. */
const EXPECTED_USERNAME_DIGEST = crypto
  .createHash('sha256')
  .update(AUTH_USERNAME.trim().toLowerCase(), 'utf8')
  .digest();

/** Salt buffer used for scrypt password verification. */
const AUTH_PASSWORD_SALT =
  /^[0-9a-f]+$/i.test(AUTH_PASSWORD_SALT_INPUT) && AUTH_PASSWORD_SALT_INPUT.length % 2 === 0
    ? Buffer.from(AUTH_PASSWORD_SALT_INPUT, 'hex')
    : Buffer.from(AUTH_PASSWORD_SALT_INPUT, 'utf8');

/** Expected 64-byte scrypt hash of the password. */
const EXPECTED_PASSWORD_HASH = Buffer.from(AUTH_PASSWORD_HASH_HEX, 'hex');

if (EXPECTED_PASSWORD_HASH.length !== 64) {
  throw new Error('AUTH_PASSWORD_HASH must decode to 64 bytes.');
}

const SESSION_TTL_MS = envInt('SESSION_TTL_MS', 8 * 60 * 60 * 1000);
if (SESSION_TTL_MS <= 0) {
  throw new Error('SESSION_TTL_MS must be greater than 0.');
}

// Exported configuration ──────────────────────────────────────────────────

export default Object.freeze({
  HOST: envStr('HOST', '0.0.0.0'),
  PORT: envInt('PORT', 3030),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  ENV_FILE_PATH,

  // Auth
  AUTH_USERNAME,
  EXPECTED_USERNAME_DIGEST,
  AUTH_PASSWORD_SALT,
  EXPECTED_PASSWORD_HASH,

  // Session
  SESSION_COOKIE_NAME: 'pm2_manager_session',
  SESSION_TTL_MS,

  // Rate-limiting / timing
  AUTH_MIN_RESPONSE_MS: envInt('AUTH_MIN_RESPONSE_MS', 900),
  LOGIN_WINDOW_MS: envInt('LOGIN_WINDOW_MS', 10 * 60 * 1000),
  LOGIN_MAX_REQUESTS: envInt('LOGIN_MAX_REQUESTS', 12),
  LOGIN_FAILURE_WINDOW_MS: envInt('LOGIN_FAILURE_WINDOW_MS', 30 * 60 * 1000),
  LOGIN_MAX_LOCKOUT_MS: envInt('LOGIN_MAX_LOCKOUT_MS', 12 * 60 * 60 * 1000),

  // Cookies / proxy
  COOKIE_SECURE_MODE: envStr('COOKIE_SECURE', 'auto'),
  TRUST_PROXY: env.TRUST_PROXY === '1',

  // Unauthenticated access rate-limiting
  UNAUTH_WINDOW_MS: envInt('UNAUTH_WINDOW_MS', 60 * 1000),
  UNAUTH_MAX_REQUESTS: envInt('UNAUTH_MAX_REQUESTS', 10),
  UNAUTH_PENALTY_MS: envInt('UNAUTH_PENALTY_MS', 5000),

  // PM2 logs
  MAX_LOG_BYTES_PER_FILE: envInt('MAX_LOG_BYTES_PER_FILE', 5 * 1024 * 1024),

  // Monitoring retention
  METRICS_RETENTION_MS: envInt('METRICS_RETENTION_MS', 24 * 60 * 60 * 1000),
  LOGS_RETENTION_MS: envInt('LOGS_RETENTION_MS', 14 * 24 * 60 * 60 * 1000),

  // Deployments: base directory where app repos are cloned.
  DEPLOY_BASE_DIR: path.resolve(path.join(__dirname, '..'), envStr('DEPLOY_BASE_DIR', 'apps')),

  // SQLite database: if SQLITE_DB_PATH is a directory (no .db extension),
  // the filename pm2-hawkeye.db is appended automatically. A relative path is
  // resolved against the project root, like DEPLOY_BASE_DIR, so the database
  // does not move when the server is started from another working directory.
  SQLITE_DB_PATH: (() => {
    const raw = path.resolve(path.join(__dirname, '..'), envStr('SQLITE_DB_PATH', 'data'));
    return raw.endsWith('.db') ? raw : path.join(raw, 'pm2-hawkeye.db');
  })(),

  // MIME types used when serving static assets.
  MIME_TYPES: Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }),
});

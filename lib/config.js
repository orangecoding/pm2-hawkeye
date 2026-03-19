/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Centralised application configuration.
 *
 * Every tunable is read from environment variables (or a .env file located in
 * the project root) and validated once at startup.  Importing this module from
 * any other file gives a single frozen configuration object.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/** Parse an integer from an env var with a fallback default. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return Number.parseInt(raw, 10);
}

/** Read an env var as a string with a fallback default. */
function envStr(name, fallback) {
  return process.env[name] || fallback;
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
  LOGIN_BASE_LOCKOUT_MS: envInt('LOGIN_BASE_LOCKOUT_MS', 30 * 1000),
  LOGIN_MAX_LOCKOUT_MS: envInt('LOGIN_MAX_LOCKOUT_MS', 12 * 60 * 60 * 1000),

  // Cookies / proxy
  COOKIE_SECURE_MODE: envStr('COOKIE_SECURE', 'auto'),
  TRUST_PROXY: process.env.TRUST_PROXY === '1',

  // Unauthenticated access rate-limiting
  UNAUTH_WINDOW_MS: envInt('UNAUTH_WINDOW_MS', 60 * 1000),
  UNAUTH_MAX_REQUESTS: envInt('UNAUTH_MAX_REQUESTS', 10),
  UNAUTH_PENALTY_MS: envInt('UNAUTH_PENALTY_MS', 5000),

  // PM2 logs
  MAX_LOG_BYTES_PER_FILE: envInt('MAX_LOG_BYTES_PER_FILE', 5 * 1024 * 1024),

  // Monitoring retention
  METRICS_RETENTION_MS: envInt('METRICS_RETENTION_MS', 24 * 60 * 60 * 1000),
  LOGS_RETENTION_MS: envInt('LOGS_RETENTION_MS', 14 * 24 * 60 * 60 * 1000),

  // SQLite database
  SQLITE_DB_PATH: envStr('SQLITE_DB_PATH', path.join(__dirname, '..', 'data', 'pm2-manager.db')),

  // MIME types used when serving static assets.
  MIME_TYPES: Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }),
});

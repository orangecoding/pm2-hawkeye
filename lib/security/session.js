/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * session.js  In-memory session store with CSRF token management.
 *
 * Each session is keyed by a SHA-256 hash of a random token that lives only in
 * the client's HttpOnly cookie.  A per-session CSRF token is rotated on every
 * login and verified before any state-changing request.
 */

import crypto from 'node:crypto';
import config from '../config.js';

/** @type {Map<string, {username: string, csrfToken: string, createdAt: number, expiresAt: number}>} */
const sessions = new Map();

// Helpers ─────────────────────────────────────────────────────────────────

/** Derive a storage key from the raw session token (never store the token itself). */
function getSessionKey(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new session for the given username.
 *
 * @param {string} username
 * @returns {{ token: string, session: object }}
 */
export function createSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionKey = getSessionKey(token);
  const now = Date.now();
  const session = {
    username,
    csrfToken: crypto.randomBytes(32).toString('base64url'),
    createdAt: now,
    expiresAt: now + config.SESSION_TTL_MS,
  };

  sessions.set(sessionKey, session);
  return { token, session };
}

/**
 * Look up a valid (non-expired) session from the request cookies.
 *
 * @param {import('express').Request} req
 * @returns {object|null} The session object, or null if absent / expired.
 */
export function getAuthenticatedSession(req) {
  const token = req.cookies[config.SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const sessionKey = getSessionKey(token);
  const session = sessions.get(sessionKey);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionKey);
    return null;
  }

  return session;
}

/**
 * Destroy the session associated with the current request cookie.
 *
 * @param {import('express').Request} req
 */
export function destroySession(req) {
  const token = req.cookies[config.SESSION_COOKIE_NAME];
  if (!token) {
    return;
  }
  sessions.delete(getSessionKey(token));
}

/**
 * Validate and consume the CSRF token sent in the X-CSRF-Token header.
 * Uses timing-safe comparison to prevent side-channel leaks.
 *
 * @param {import('express').Request} req
 * @param {object} session
 * @returns {boolean}
 */
export function consumeCsrfToken(req, session) {
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || header.length === 0) {
    return false;
  }

  const provided = Buffer.from(header, 'utf8');
  const expected = Buffer.from(session.csrfToken, 'utf8');

  if (provided.length !== expected.length) {
    return false;
  }

  const valid = crypto.timingSafeEqual(provided, expected);

  // Rotate the CSRF token after every successful consumption so that each
  // state-changing request uses a unique token (one-time-use pattern).
  if (valid) {
    session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }

  return valid;
}

/**
 * Remove expired sessions from the in-memory store.
 * Called periodically by the cleanup timer.
 */
export function purgeExpiredSessions() {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (value.expiresAt <= now) {
      sessions.delete(key);
    }
  }
}

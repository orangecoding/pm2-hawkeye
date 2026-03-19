/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Credential verification and brute-force protection.
 *
 * Combines constant-time credential checks (scrypt + SHA-256) with a two-tier
 * rate-limiting strategy:
 *
 *   1. **Sliding window** – caps total login attempts per client identity
 *      within a configurable time window.
 *   2. **Exponential back-off** – after repeated failures the client is locked
 *      out for progressively longer periods (up to a configurable maximum).
 *
 * Both layers use the composite identity string (IP + User-Agent) so that
 * legitimate users behind the same NAT aren't penalised for each other.
 */

import crypto from 'node:crypto';
import config from '../config.js';

// In-memory rate-limit state ──────────────────────────────────────────────

/** @type {Map<string, { count: number, windowEndsAt: number }>} */
const loginRateWindow = new Map();

/** @type {Map<string, { count: number, windowEndsAt: number }>} */
const unauthRateWindow = new Map();

/** @type {Map<string, { failures: number, lastFailureAt: number, lockedUntil: number }>} */
const loginPenaltyState = new Map();

// Timing helpers ──────────────────────────────────────────────────────────

/** Resolve after `ms` milliseconds. */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ensure a handler never responds faster than `minimumMs` to prevent
 * timing-based user-enumeration attacks.
 */
export async function ensureMinimumResponseTime(startedAt, minimumMs) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < minimumMs) {
    await delay(minimumMs - elapsed);
  }
}

// Credential verification ─────────────────────────────────────────────────

/**
 * Verify a username / password pair against the pre-computed digests stored in
 * config.  Both comparisons use `crypto.timingSafeEqual` to prevent
 * timing side-channels.
 *
 * @param {string} username
 * @param {string} password
 * @returns {boolean}
 */
export function verifyCredentials(username, password) {
  const usernameDigest = crypto
    .createHash('sha256')
    .update(
      String(username || '')
        .trim()
        .toLowerCase(),
      'utf8',
    )
    .digest();

  const passwordHash = crypto.scryptSync(String(password || ''), config.AUTH_PASSWORD_SALT, 64);

  return (
    crypto.timingSafeEqual(usernameDigest, config.EXPECTED_USERNAME_DIGEST) &&
    crypto.timingSafeEqual(passwordHash, config.EXPECTED_PASSWORD_HASH)
  );
}

// Sliding-window rate limiter ─────────────────────────────────────────────

/**
 * Check whether the client is allowed to attempt a login right now.
 *
 * @param {string} identity - Composite client identity.
 * @param {number} now      - Current timestamp (ms).
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
export function checkLoginWindow(identity, now) {
  const entry = loginRateWindow.get(identity);

  if (!entry || entry.windowEndsAt <= now) {
    loginRateWindow.set(identity, {
      count: 1,
      windowEndsAt: now + config.LOGIN_WINDOW_MS,
    });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (entry.count >= config.LOGIN_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterMs: Math.max(entry.windowEndsAt - now, 0),
    };
  }

  entry.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

// Exponential lockout ─────────────────────────────────────────────────────

/**
 * Return the remaining lockout time (ms) for a client, or 0 if unlocked.
 *
 * @param {string} identity
 * @param {number} now
 * @returns {number}
 */
export function getPenalty(identity, now) {
  const entry = loginPenaltyState.get(identity);
  if (!entry) {
    return 0;
  }
  if (entry.lockedUntil <= now) {
    loginPenaltyState.delete(identity);
    return 0;
  }
  return entry.lockedUntil - now;
}

/**
 * Record a failed login attempt and calculate the new lockout duration.
 * Lockout kicks in after 3 consecutive failures and doubles each time.
 *
 * @param {string} identity
 * @param {number} now
 * @returns {number} The lockout period applied (ms), or 0 if none.
 */
export function registerFailedAttempt(identity, now) {
  const entry = loginPenaltyState.get(identity);
  const failures = entry && now - entry.lastFailureAt <= config.LOGIN_FAILURE_WINDOW_MS ? entry.failures + 1 : 1;
  const lockoutMs =
    failures < 3 ? 0 : Math.min(config.LOGIN_BASE_LOCKOUT_MS * Math.pow(2, failures - 3), config.LOGIN_MAX_LOCKOUT_MS);

  loginPenaltyState.set(identity, {
    failures,
    lastFailureAt: now,
    lockedUntil: now + lockoutMs,
  });

  return lockoutMs;
}

/** Clear penalty state after a successful login. */
export function clearFailedAttempts(identity) {
  loginPenaltyState.delete(identity);
}

// Unauthenticated access rate limiter ─────────────────────────────────────

/**
 * Record an unauthenticated access attempt and check if the client has exceeded
 * the allowed request count within the configured window.
 *
 * Returns `{ limited: true }` once the client surpasses `UNAUTH_MAX_REQUESTS`
 * in the window so the caller can slow-path the response (delay + 429).
 *
 * @param {string} identity - Composite client identity.
 * @param {number} now      - Current timestamp (ms).
 * @returns {{ limited: boolean, retryAfterMs: number }}
 */
export function checkUnauthWindow(identity, now) {
  const entry = unauthRateWindow.get(identity);

  if (!entry || entry.windowEndsAt <= now) {
    unauthRateWindow.set(identity, { count: 1, windowEndsAt: now + config.UNAUTH_WINDOW_MS });
    return { limited: false, retryAfterMs: 0 };
  }

  entry.count += 1;

  if (entry.count > config.UNAUTH_MAX_REQUESTS) {
    return { limited: true, retryAfterMs: Math.max(entry.windowEndsAt - now, 0) };
  }

  return { limited: false, retryAfterMs: 0 };
}

// Periodic cleanup ────────────────────────────────────────────────────────

/** Purge stale rate-limit and penalty entries (called by the global timer). */
export function purgeExpiredEntries() {
  const now = Date.now();
  for (const [key, value] of loginRateWindow.entries()) {
    if (value.windowEndsAt <= now) {
      loginRateWindow.delete(key);
    }
  }
  for (const [key, value] of loginPenaltyState.entries()) {
    if (value.lockedUntil <= now) {
      loginPenaltyState.delete(key);
    }
  }
  for (const [key, value] of unauthRateWindow.entries()) {
    if (value.windowEndsAt <= now) {
      unauthRateWindow.delete(key);
    }
  }
}

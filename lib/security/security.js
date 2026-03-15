/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * HTTP security headers and cookie utilities.
 *
 * Applies defense-in-depth headers (CSP, HSTS, X-Frame-Options, etc.) and
 * provides helpers for creating and clearing session cookies with correct
 * Secure / SameSite / HttpOnly attributes.
 */

import config from '../config.js';

// Proxy / TLS detection ───────────────────────────────────────────────────

/**
 * Extract the first value from the X-Forwarded-Proto header.
 *
 * @param {import('express').Request} req
 * @returns {string} Protocol string (e.g. "https") or empty string.
 */
function parseForwardedProto(req) {
  const header = req.headers['x-forwarded-proto'];
  if (!header) {
    return '';
  }
  return (Array.isArray(header) ? header[0] : header).split(',')[0].trim().toLowerCase();
}

/**
 * Determine whether the current request arrived over a secure channel.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSecureRequest(req) {
  if (req.secure) {
    return true;
  }
  if (config.TRUST_PROXY && parseForwardedProto(req) === 'https') {
    return true;
  }
  return false;
}

// Security headers ────────────────────────────────────────────────────────

/**
 * Express middleware to set baseline security headers on every response.
 * HSTS is only emitted when the request was received over TLS.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function securityMiddleware(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
}

// Cookie helpers ──────────────────────────────────────────────────────────

/**
 * Decide whether the Secure flag should be set on cookies.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function shouldUseSecureCookies(req) {
  if (config.COOKIE_SECURE_MODE === 'always') {
    return true;
  }
  if (config.COOKIE_SECURE_MODE === 'never') {
    return false;
  }
  return isSecureRequest(req);
}

/**
 * Write the session cookie onto the response using Express res.cookie.
 *
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 * @param {string} token - Opaque session token.
 */
export function setSessionCookie(res, req, token) {
  res.cookie(config.SESSION_COOKIE_NAME, token, {
    maxAge: config.SESSION_TTL_MS,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: shouldUseSecureCookies(req),
  });
}

/**
 * Clear the session cookie.
 *
 * @param {import('express').Response} res
 */
export function clearSessionCookie(res) {
  res.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
}

// Client identity ─────────────────────────────────────────────────────────

/**
 * Best-effort client IP extraction.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  return req.ip || 'unknown';
}

/**
 * Build a composite identity string for rate-limiting (IP + User-Agent).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getClientIdentity(req) {
  return `${getClientIp(req)}|${req.headers['user-agent'] || 'unknown-agent'}`;
}

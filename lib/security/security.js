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

import net from 'node:net';
import config from '../config.js';

// Proxy / TLS detection ───────────────────────────────────────────────────

/**
 * Determine whether the current request arrived over a secure channel.
 *
 * With `TRUST_PROXY=1`, server.js sets Express's `trust proxy`, so
 * `req.secure` already honours the first `X-Forwarded-Proto` value.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSecureRequest(req) {
  return Boolean(req.secure);
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
 * Reduce an IPv6 address to its /64 network prefix.
 *
 * A single IPv6 client usually controls a whole /64, so keying limits on the
 * full address would hand it 2^64 fresh identities. IPv4-mapped addresses
 * (`::ffff:192.0.2.1`) are returned as plain IPv4.
 *
 * @param {string} ip - A valid IPv6 address.
 * @returns {string}
 */
function ipv6Prefix64(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];

  const address = ip.split('%')[0]; // drop a zone index such as %eth0
  const [head, tail = ''] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = address.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const groups = address.includes('::') ? [...headParts, ...Array(missing).fill('0'), ...tailParts] : headParts;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * Return the stable, client-controlled-header-free identity used by rate limits:
 * the IPv4 address, or the /64 prefix of an IPv6 address.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getRateLimitIdentity(req) {
  const ip = getClientIp(req);
  return net.isIPv6(ip) ? ipv6Prefix64(ip) : ip;
}

/**
 * Make client-supplied text safe for a single log line: drop control
 * characters (including newlines, which would let a caller forge extra log
 * entries) and cap the length.
 *
 * @param {unknown} value
 * @param {number} [maxLength=200]
 * @returns {string}
 */
export function sanitizeForLog(value, maxLength = 200) {
  return String(value ?? '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && (code < 127 || code > 159);
    })
    .join('')
    .slice(0, maxLength);
}

/**
 * Build a bounded composite identity string for security audit logs.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getClientIdentity(req) {
  return `${getClientIp(req)}|${sanitizeForLog(req.headers['user-agent'] || 'unknown-agent')}`;
}

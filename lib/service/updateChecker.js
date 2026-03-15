/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Update checker service.
 *
 * Polls the GitHub Releases API every 3 hours using croner and caches the
 * result in memory. The cached payload is served to the UI on demand via
 * GET /api/update so the browser never has to hit GitHub directly.
 *
 * Comparison is semver-aware: only a strictly higher upstream version triggers
 * an update notification. Pre-release tags are ignored.
 */

import { Cron } from 'croner';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import logger from './logger.js';

// ── Constants ────────────────────────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com/repos/orangecoding/pm2-manager/releases/latest';
const CHECK_INTERVAL = '0 */3 * * *'; // every 3 hours at the top of the hour

// ── Local version ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require(path.join(__dirname, '..', '..', 'package.json'));

// ── Semver helpers ───────────────────────────────────────────────────────────

/**
 * Parse a semver string such as `1.2.3` or `v1.2.3` into `[major, minor, patch]`.
 *
 * @param {string} v
 * @returns {number[]|null} Tuple of three numbers, or null if unparseable.
 */
function parseSemver(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Return true when `candidate` is strictly greater than `current`.
 *
 * @param {string} current
 * @param {string} candidate
 * @returns {boolean}
 */
function isNewer(current, candidate) {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} UpdateInfo
 * @property {string}      currentVersion  - Running version.
 * @property {string}      latestVersion   - Latest published release tag.
 * @property {string}      releaseUrl      - HTML URL of the release on GitHub.
 * @property {string}      releaseName     - Release title.
 * @property {string}      releaseNotes    - Markdown body of the release.
 * @property {string}      publishedAt     - ISO 8601 publish date.
 */

/** @type {UpdateInfo|null} */
let cachedUpdate = null;

/** @returns {UpdateInfo|null} */
export function getUpdateInfo() {
  return cachedUpdate;
}

// ── Fetch & compare ──────────────────────────────────────────────────────────

/**
 * Fetch the latest release from GitHub and update the in-memory cache.
 * Silently swallows network errors so a transient outage never crashes the app.
 */
async function checkForUpdate() {
  try {
    const response = await fetch(GITHUB_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `pm2-manager/${CURRENT_VERSION}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn(`[UPDATE] GitHub API responded with ${response.status} — skipping.`);
      return;
    }

    const release = await response.json();
    const latestVersion = String(release.tag_name || '').replace(/^v/, '');

    // Ignore pre-releases (alpha, beta, rc, etc.)
    if (release.prerelease) {
      logger.debug(`[UPDATE] Latest release ${latestVersion} is a pre-release — ignoring.`);
      return;
    }

    if (isNewer(CURRENT_VERSION, latestVersion)) {
      cachedUpdate = {
        currentVersion: CURRENT_VERSION,
        latestVersion,
        releaseUrl: release.html_url,
        releaseName: release.name || `v${latestVersion}`,
        releaseNotes: release.body || '',
        publishedAt: release.published_at,
      };
      logger.info(`[UPDATE] New version available: ${latestVersion} (running ${CURRENT_VERSION})`);
    } else {
      cachedUpdate = null;
      logger.debug(`[UPDATE] Running latest version (${CURRENT_VERSION}).`);
    }
  } catch (error) {
    logger.warn(`[UPDATE] Check failed: ${error.message}`);
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Start the background update-check cron job.
 * The first check runs immediately; subsequent checks run every 3 hours.
 * The job is `.unref()`-ed so it never prevents the process from exiting.
 */
export function startUpdateChecker() {
  checkForUpdate();

  const job = new Cron(CHECK_INTERVAL, { name: 'update-checker' }, checkForUpdate);
  // Prevent the timer from keeping the Node process alive on graceful shutdown.
  job.unref?.();

  logger.debug(`[UPDATE] Checker scheduled (${CHECK_INTERVAL}), current version: ${CURRENT_VERSION}`);
}

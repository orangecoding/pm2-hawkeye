/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Mocha setup file - runs before any spec files are loaded.
 *
 * Injects known test credentials so that integration tests can log in with
 * a predictable password without depending on the .env file's actual hash.
 * Because dotenv does not overwrite already-set environment variables, these
 * values take precedence over whatever is in .env.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../lib/storage/db.js';

// Point config at a throwaway .env so tests of the General settings routes
// read and rewrite a temp file, never the developer's real .env.
const tmpEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-hawkeye-test-'));
process.env.HAWKEYE_ENV_FILE = path.join(tmpEnvDir, '.env');
fs.writeFileSync(process.env.HAWKEYE_ENV_FILE, '', 'utf8');

const TEST_PASSWORD = 'admin';
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(TEST_PASSWORD, salt, 64);

process.env.AUTH_USERNAME = 'admin';
process.env.AUTH_PASSWORD_SALT = salt.toString('hex');
process.env.AUTH_PASSWORD_HASH = hash.toString('hex');

// Raise the login rate limit so that the full test suite can run without
// triggering the sliding-window lockout.
process.env.LOGIN_MAX_REQUESTS = '1000';

// Allow integration tests to assign isolated client IPs through
// X-Forwarded-For when exercising the IP-based login lockout.
process.env.TRUST_PROXY = '1';

// Skip the artificial minimum auth response delay so the suite runs fast
// (mirrors the CI workflow's AUTH_MIN_RESPONSE_MS=0).
process.env.AUTH_MIN_RESPONSE_MS = '0';

// Initialise an in-memory SQLite database for the test suite.
await initDb(':memory:');

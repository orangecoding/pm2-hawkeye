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
import { initDb } from '../lib/storage/db.js';

const TEST_PASSWORD = 'admin';
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(TEST_PASSWORD, salt, 64);

process.env.AUTH_USERNAME = 'admin';
process.env.AUTH_PASSWORD_SALT = salt.toString('hex');
process.env.AUTH_PASSWORD_HASH = hash.toString('hex');

// Raise the login rate limit so that the full test suite can run without
// triggering the sliding-window lockout.
process.env.LOGIN_MAX_REQUESTS = '100';

// Initialise an in-memory SQLite database for the test suite.
await initDb(':memory:');

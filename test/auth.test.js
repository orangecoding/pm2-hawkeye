/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import * as auth from '../lib/security/auth.js';
import config from '../lib/config.js';

describe('Authentication Logic (auth.js)', () => {
  describe('verifyCredentials', () => {
    it('should return true for correct credentials', () => {
      // setup.mjs sets AUTH_USERNAME=admin and hash for password 'admin'
      expect(auth.verifyCredentials('admin', 'admin')).to.be.true;
    });

    it('should return true with case-insensitive username', () => {
      expect(auth.verifyCredentials('ADMIN', 'admin')).to.be.true;
    });

    it('should return false for incorrect password', () => {
      expect(auth.verifyCredentials(config.AUTH_USERNAME, 'wrongpassword')).to.be.false;
    });

    it('should return false for incorrect username', () => {
      expect(auth.verifyCredentials('notadmin', 'admin')).to.be.false;
    });

    it('should return false for empty credentials', () => {
      expect(auth.verifyCredentials('', '')).to.be.false;
    });
  });

  describe('delay', () => {
    it('should resolve after at least the given milliseconds', async () => {
      const start = Date.now();
      await auth.delay(20);
      expect(Date.now() - start).to.be.greaterThanOrEqual(18); // small tolerance
    });
  });

  describe('ensureMinimumResponseTime', () => {
    it('should wait if elapsed time is below minimum', async () => {
      const start = Date.now();
      await auth.ensureMinimumResponseTime(start, 30);
      expect(Date.now() - start).to.be.greaterThanOrEqual(28);
    });

    it('should not wait if minimum time already elapsed', async () => {
      const past = Date.now() - 200;
      const start = Date.now();
      await auth.ensureMinimumResponseTime(past, 50);
      expect(Date.now() - start).to.be.lessThan(20);
    });
  });

  describe('Rate Limiting & Lockout', () => {
    const identity = 'test-client';

    beforeEach(() => {
      auth.clearFailedAttempts(identity);
      auth.purgeExpiredEntries();
    });

    it('should allow initial login attempt', () => {
      const result = auth.checkLoginWindow(identity, Date.now());
      expect(result.allowed).to.be.true;
    });

    it('should return penalty of 0 for a clean identity', () => {
      expect(auth.getPenalty(identity, Date.now())).to.equal(0);
    });

    it('should record failed attempts and eventually lock out', () => {
      const now = Date.now();
      auth.registerFailedAttempt(identity, now);
      auth.registerFailedAttempt(identity, now + 100);
      const lockoutMs = auth.registerFailedAttempt(identity, now + 200);
      expect(lockoutMs).to.be.greaterThan(0);
      expect(auth.getPenalty(identity, now + 200)).to.be.greaterThan(0);
    });

    it('should double the lockout on each additional failure', () => {
      const now = Date.now();
      auth.registerFailedAttempt(identity, now);
      auth.registerFailedAttempt(identity, now + 100);
      auth.registerFailedAttempt(identity, now + 200); // 1× base
      const second = auth.registerFailedAttempt(identity, now + 300); // 2× base
      expect(second).to.be.greaterThan(config.LOGIN_BASE_LOCKOUT_MS);
    });

    it('should clear penalty after success', () => {
      const now = Date.now();
      auth.registerFailedAttempt(identity, now);
      auth.registerFailedAttempt(identity, now + 100);
      auth.registerFailedAttempt(identity, now + 200);

      expect(auth.getPenalty(identity, now + 200)).to.be.greaterThan(0);

      auth.clearFailedAttempts(identity);
      expect(auth.getPenalty(identity, now + 200)).to.equal(0);
    });

    it('purgeExpiredEntries should remove stale entries', () => {
      const past = Date.now() - 10000;
      auth.registerFailedAttempt(identity, past);
      auth.purgeExpiredEntries();
      // After purge the identity should have no lockout remaining
      expect(auth.getPenalty(identity, Date.now())).to.equal(0);
    });
  });
});

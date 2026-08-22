/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for the branch watcher decision logic.
 *
 * These tests cover the pure helpers only - no git process is spawned and no
 * deployment is triggered.
 */

import { strict as assert } from 'node:assert';
import { parseLsRemote, isDue, needsDeploy } from '../lib/service/branchWatcher.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('branchWatcher', () => {
  describe('parseLsRemote', () => {
    it('extracts the SHA from valid output', () => {
      assert.equal(parseLsRemote(`${SHA_A}\trefs/heads/main\n`), SHA_A);
    });

    it('lower-cases the SHA', () => {
      assert.equal(parseLsRemote(`${SHA_A.toUpperCase()}\trefs/heads/main\n`), SHA_A);
    });

    it('returns null for empty output (branch does not exist)', () => {
      assert.equal(parseLsRemote(''), null);
      assert.equal(parseLsRemote('\n\n'), null);
    });

    it('returns null for output that is not a SHA', () => {
      assert.equal(parseLsRemote('fatal: repository not found\n'), null);
    });

    it('returns null for null or undefined input', () => {
      assert.equal(parseLsRemote(null), null);
      assert.equal(parseLsRemote(undefined), null);
    });
  });

  describe('isDue', () => {
    it('is due when it has never been checked', () => {
      assert.equal(isDue({ watch_last_checked_at: null, watch_interval_minutes: 5 }, 1_000), true);
    });

    it('is not due before the interval has elapsed', () => {
      const now = 10 * 60_000;
      assert.equal(isDue({ watch_last_checked_at: now - 4 * 60_000, watch_interval_minutes: 5 }, now), false);
    });

    it('is due once the interval has elapsed', () => {
      const now = 10 * 60_000;
      assert.equal(isDue({ watch_last_checked_at: now - 5 * 60_000, watch_interval_minutes: 5 }, now), true);
    });

    it('falls back to the default interval for a nonsensical value', () => {
      const now = 10 * 60_000;
      assert.equal(isDue({ watch_last_checked_at: now - 60_000, watch_interval_minutes: 0 }, now), false);
      assert.equal(isDue({ watch_last_checked_at: now - 5 * 60_000, watch_interval_minutes: 0 }, now), true);
    });
  });

  describe('needsDeploy', () => {
    it('deploys when the remote is ahead of the working copy', () => {
      assert.equal(needsDeploy({ remote: SHA_B, local: SHA_A, lastCommit: SHA_A }), true);
    });

    it('does not deploy when the working copy is already at the remote SHA', () => {
      assert.equal(needsDeploy({ remote: SHA_A, local: SHA_A, lastCommit: null }), false);
    });

    it('does not deploy the same remote SHA twice, even if the local HEAD differs', () => {
      // git pull --rebase can leave HEAD permanently different from the remote
      // SHA; without this guard every poll would redeploy.
      assert.equal(needsDeploy({ remote: SHA_B, local: SHA_A, lastCommit: SHA_B }), false);
    });

    it('deploys when there is no working copy yet', () => {
      assert.equal(needsDeploy({ remote: SHA_A, local: null, lastCommit: null }), true);
    });

    it('does not deploy when the remote SHA is unknown', () => {
      assert.equal(needsDeploy({ remote: null, local: SHA_A, lastCommit: null }), false);
    });
  });
});

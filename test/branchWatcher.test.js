/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for the branch watcher.
 *
 * The decision helpers are tested on their own. `checkDeployment` runs against
 * a local bare repository with a pre-setup script that fails on purpose, so no
 * network and no PM2 are involved.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLsRemote, isDue, needsDeploy, retryDelayMs, checkDeployment } from '../lib/service/branchWatcher.js';
import { createDeployment, deleteDeployment, getDeploymentById } from '../lib/storage/deploymentStorage.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const MINUTE = 60_000;

/**
 * Run git with a fixed identity and without hooks or signing, so the fixture
 * works the same on every machine, whatever its global git config says.
 *
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} Trimmed stdout.
 */
function git(cwd, ...args) {
  const isolated = [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
  ];
  return execFileSync('git', [...isolated, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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

    it('does not deploy a commit it already deployed, even if the local HEAD differs', () => {
      // The working copy can be replaced after a successful deploy; without
      // this guard every poll would redeploy.
      assert.equal(needsDeploy({ remote: SHA_B, local: SHA_A, lastCommit: SHA_B }), false);
    });

    it('deploys when there is no working copy yet', () => {
      assert.equal(needsDeploy({ remote: SHA_A, local: null, lastCommit: null }), true);
    });

    it('does not deploy when the remote SHA is unknown', () => {
      assert.equal(needsDeploy({ remote: null, local: SHA_A, lastCommit: null }), false);
    });

    it('waits for the retry time of a commit whose deploy failed', () => {
      const failure = { commit: SHA_B, retryAt: 2 * MINUTE };
      assert.equal(needsDeploy({ remote: SHA_B, local: SHA_A, lastCommit: SHA_A, failure, now: MINUTE }), false);
    });

    it('retries a failed commit once its retry is due, even when it is checked out already', () => {
      // An install that failed on a registry outage leaves the new commit on
      // disk, so the local HEAD alone must not stop the retry.
      const failure = { commit: SHA_B, retryAt: 2 * MINUTE };
      assert.equal(needsDeploy({ remote: SHA_B, local: SHA_B, lastCommit: SHA_A, failure, now: 2 * MINUTE }), true);
    });

    it('deploys a newer commit at once, whatever failed before', () => {
      const failure = { commit: SHA_A, retryAt: 60 * MINUTE };
      assert.equal(needsDeploy({ remote: SHA_B, local: SHA_A, lastCommit: null, failure, now: MINUTE }), true);
    });
  });

  describe('retryDelayMs', () => {
    it('starts at the poll interval and doubles with every failed attempt', () => {
      assert.equal(retryDelayMs(5, 1), 5 * MINUTE);
      assert.equal(retryDelayMs(5, 2), 10 * MINUTE);
      assert.equal(retryDelayMs(5, 3), 20 * MINUTE);
    });

    it('never waits longer than an hour', () => {
      assert.equal(retryDelayMs(5, 10), 60 * MINUTE);
      assert.equal(retryDelayMs(1, 50), 60 * MINUTE);
    });
  });

  describe('checkDeployment', function () {
    // Every check spawns git and a shell script.
    this.timeout(20_000);

    let dir;
    let deploymentId;
    let attemptsFile;

    /** @returns {number} How often the pre-setup script has run. */
    function attempts() {
      return fs.existsSync(attemptsFile) ? fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').length : 0;
    }

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkeye-watch-'));
      const remote = path.join(dir, 'remote.git');
      const work = path.join(dir, 'work');
      git(dir, 'init', '--bare', remote);
      git(dir, 'init', work);
      fs.writeFileSync(path.join(work, 'index.js'), '');
      git(work, 'add', 'index.js');
      git(work, 'commit', '-m', 'first');
      git(work, 'push', remote, 'HEAD:refs/heads/main');

      attemptsFile = path.join(dir, 'attempts');
      deploymentId = createDeployment({
        pm2Name: 'watch-retry-app',
        repoUrl: remote,
        branch: 'main',
        deployPath: path.join(dir, 'deployed'),
        startScript: 'index.js',
        installCmd: 'skip',
        // Fails before anything is cloned, like a fetch on a flaky network.
        preSetupScript: `echo attempt >> "${attemptsFile}"\nexit 1\n`,
        watchEnabled: true,
        watchIntervalMinutes: 1,
      }).id;
    });

    afterEach(() => {
      deleteDeployment(deploymentId);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('retries a failed auto-deploy with growing pauses and keeps its error visible', async () => {
      await checkDeployment(getDeploymentById(deploymentId));
      assert.equal(attempts(), 1);
      let row = getDeploymentById(deploymentId);
      assert.equal(row.watch_last_commit, null, 'a failed commit is not recorded as deployed');
      assert.match(row.watch_last_error, /exited with code 1/);

      // First retry one interval later.
      await checkDeployment(getDeploymentById(deploymentId), Date.now() + MINUTE + 1_000);
      assert.equal(attempts(), 2);

      // The second retry waits two intervals; the error stays until then.
      await checkDeployment(getDeploymentById(deploymentId), Date.now() + MINUTE + 1_000);
      assert.equal(attempts(), 2);
      row = getDeploymentById(deploymentId);
      assert.match(row.watch_last_error, /exited with code 1/);

      await checkDeployment(getDeploymentById(deploymentId), Date.now() + 2 * MINUTE + 1_000);
      assert.equal(attempts(), 3);
    });
  });
});

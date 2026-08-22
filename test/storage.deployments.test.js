/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for deploymentStorage.
 *
 * All tests operate on the in-memory SQLite database initialised in setup.mjs.
 */

import { strict as assert } from 'node:assert';
import { getDb } from '../lib/storage/db.js';
import {
  createDeployment,
  getDeploymentByName,
  getDeploymentById,
  getAllDeployments,
  setDeploying,
  updateLastDeployed,
  deleteDeployment,
  getWatchedDeployments,
  updateWatchState,
} from '../lib/storage/deploymentStorage.js';

function cleanDb() {
  getDb().prepare('DELETE FROM deployments').run();
}

/** Minimal valid opts for createDeployment. */
function baseOpts(overrides = {}) {
  return {
    pm2Name: 'test-app',
    repoUrl: 'https://github.com/owner/repo',
    branch: 'main',
    deployPath: '/tmp/apps/test-app',
    startScript: 'index.js',
    installCmd: 'npm install',
    buildCmd: null,
    preSetupScript: null,
    postSetupScript: null,
    envVars: {},
    pm2Options: {},
    ...overrides,
  };
}

describe('deploymentStorage', () => {
  beforeEach(cleanDb);

  it('createDeployment inserts a record and returns id + pm2_name', () => {
    const result = createDeployment(baseOpts());
    assert.ok(result.id, 'should have an id');
    assert.equal(result.pm2_name, 'test-app');
    assert.ok(typeof result.created_at === 'number');
  });

  it('getDeploymentByName returns the record', () => {
    createDeployment(baseOpts());
    const row = getDeploymentByName('test-app');
    assert.ok(row, 'should find the record');
    assert.equal(row.pm2_name, 'test-app');
    assert.equal(row.branch, 'main');
  });

  it('getDeploymentByName returns undefined for unknown name', () => {
    assert.equal(getDeploymentByName('no-such-app'), undefined);
  });

  it('getDeploymentById returns the record', () => {
    const { id } = createDeployment(baseOpts());
    const row = getDeploymentById(id);
    assert.ok(row);
    assert.equal(row.id, id);
  });

  it('getAllDeployments returns all records', () => {
    createDeployment(baseOpts({ pm2Name: 'app-a' }));
    createDeployment(baseOpts({ pm2Name: 'app-b' }));
    const all = getAllDeployments();
    assert.equal(all.length, 2);
    const names = all.map((r) => r.pm2_name).sort();
    assert.deepEqual(names, ['app-a', 'app-b']);
  });

  it('JSON fields round-trip correctly', () => {
    createDeployment(
      baseOpts({
        envVars: { NODE_ENV: 'production', PORT: '3000' },
        pm2Options: { instances: 2, exec_mode: 'cluster' },
      }),
    );
    const row = getDeploymentByName('test-app');
    assert.deepEqual(row.env_vars, { NODE_ENV: 'production', PORT: '3000' });
    assert.deepEqual(row.pm2_options, { instances: 2, exec_mode: 'cluster' });
  });

  it('setDeploying toggles the flag', () => {
    const { id } = createDeployment(baseOpts());
    assert.equal(getDeploymentById(id).deploying, 0);
    setDeploying(id, true);
    assert.equal(getDeploymentById(id).deploying, 1);
    setDeploying(id, false);
    assert.equal(getDeploymentById(id).deploying, 0);
  });

  it('updateLastDeployed sets last_deployed_at to now', () => {
    const { id } = createDeployment(baseOpts());
    assert.equal(getDeploymentById(id).last_deployed_at, null);
    const before = Date.now();
    updateLastDeployed(id);
    const after = Date.now();
    const ts = getDeploymentById(id).last_deployed_at;
    assert.ok(ts >= before && ts <= after, 'timestamp should be recent');
  });

  it('deleteDeployment removes the record', () => {
    const { id } = createDeployment(baseOpts());
    deleteDeployment(id);
    assert.equal(getDeploymentById(id), undefined);
  });

  it('rejects duplicate pm2_name (UNIQUE constraint)', () => {
    createDeployment(baseOpts());
    assert.throws(() => createDeployment(baseOpts()), /UNIQUE constraint failed/);
  });
  describe('branch watching', () => {
    it('defaults to watching disabled with a 5 minute interval', () => {
      createDeployment(baseOpts());
      const row = getDeploymentByName('test-app');
      assert.equal(row.watch_enabled, 0);
      assert.equal(row.watch_interval_minutes, 5);
      assert.equal(row.watch_last_checked_at, null);
      assert.equal(row.watch_last_commit, null);
      assert.equal(row.watch_last_error, null);
    });

    it('stores the watch fields passed to createDeployment', () => {
      createDeployment(baseOpts({ watchEnabled: true, watchIntervalMinutes: 15 }));
      const row = getDeploymentByName('test-app');
      assert.equal(row.watch_enabled, 1);
      assert.equal(row.watch_interval_minutes, 15);
    });

    it('getWatchedDeployments returns only watched records', () => {
      createDeployment(baseOpts({ pm2Name: 'watched', watchEnabled: true }));
      createDeployment(baseOpts({ pm2Name: 'unwatched' }));
      const watched = getWatchedDeployments();
      assert.equal(watched.length, 1);
      assert.equal(watched[0].pm2_name, 'watched');
    });

    it('updateWatchState writes check time, commit and error', () => {
      const { id } = createDeployment(baseOpts({ watchEnabled: true }));
      updateWatchState(id, { lastCheckedAt: 1234, lastCommit: 'abc', lastError: 'boom' });
      let row = getDeploymentById(id);
      assert.equal(row.watch_last_checked_at, 1234);
      assert.equal(row.watch_last_commit, 'abc');
      assert.equal(row.watch_last_error, 'boom');

      // A later successful poll clears the error text.
      updateWatchState(id, { lastCheckedAt: 5678, lastCommit: 'abc', lastError: null });
      row = getDeploymentById(id);
      assert.equal(row.watch_last_error, null);
    });
  });
});

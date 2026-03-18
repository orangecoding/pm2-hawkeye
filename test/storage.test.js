/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for storage modules.
 *
 * All tests operate on the in-memory SQLite database initialised in setup.mjs.
 */

import { strict as assert } from 'node:assert';
import {
  getAllMonitored,
  isMonitored,
  addMonitored,
  removeMonitored,
  getByPm2Name,
  reconcileOrphans,
} from '../lib/storage/monitoringStorage.js';
import { insertMetric, getMetrics, purgeOldMetrics } from '../lib/storage/metricsStorage.js';
import { insertLogEntry, getLogEntries, purgeOldLogs } from '../lib/storage/logStorage.js';
import { getDb } from '../lib/storage/db.js';

// Helper to clean tables between tests.
function cleanDb() {
  const db = getDb();
  db.prepare('DELETE FROM log_entries').run();
  db.prepare('DELETE FROM metrics_history').run();
  db.prepare('DELETE FROM monitored_processes').run();
}

describe('monitoringStorage', () => {
  beforeEach(cleanDb);

  it('starts with no monitored processes', () => {
    assert.deepEqual(getAllMonitored(), []);
  });

  it('addMonitored creates a new record', () => {
    const row = addMonitored('my-app');
    assert.ok(row.id, 'should have an id');
    assert.equal(row.pm2_name, 'my-app');
    assert.equal(row.is_orphan, 0);
  });

  it('isMonitored returns true after adding', () => {
    addMonitored('my-app');
    assert.equal(isMonitored('my-app'), true);
    assert.equal(isMonitored('other-app'), false);
  });

  it('removeMonitored removes the record', () => {
    addMonitored('my-app');
    removeMonitored('my-app');
    assert.equal(isMonitored('my-app'), false);
  });

  it('getByPm2Name returns the record', () => {
    addMonitored('my-app');
    const row = getByPm2Name('my-app');
    assert.ok(row);
    assert.equal(row.pm2_name, 'my-app');
  });

  it('getByPm2Name returns undefined for unknown name', () => {
    assert.equal(getByPm2Name('unknown'), undefined);
  });

  it('reconcileOrphans marks missing processes as orphans', () => {
    addMonitored('app-a');
    addMonitored('app-b');
    reconcileOrphans(['app-a']); // app-b is no longer active
    assert.equal(getByPm2Name('app-a').is_orphan, 0);
    assert.equal(getByPm2Name('app-b').is_orphan, 1);
  });

  it('reconcileOrphans un-orphans processes that return', () => {
    addMonitored('app-a');
    reconcileOrphans([]);
    assert.equal(getByPm2Name('app-a').is_orphan, 1);
    reconcileOrphans(['app-a']);
    assert.equal(getByPm2Name('app-a').is_orphan, 0);
  });
});

describe('metricsStorage', () => {
  beforeEach(cleanDb);

  it('insertMetric and getMetrics round-trip', () => {
    const { id } = addMonitored('metrics-app');
    insertMetric(id, 12.5, 1024 * 1024);
    insertMetric(id, 20.0, 2 * 1024 * 1024);

    const samples = getMetrics(id);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].cpu, 12.5);
    assert.equal(samples[1].cpu, 20.0);
    assert.ok(samples[0].sampled_at <= samples[1].sampled_at, 'oldest first');
  });

  it('getMetrics respects the limit parameter', () => {
    const { id } = addMonitored('metrics-app');
    for (let i = 0; i < 10; i++) insertMetric(id, i, i * 1000);
    const samples = getMetrics(id, 3);
    assert.equal(samples.length, 3);
  });

  it('purgeOldMetrics removes records older than the retention window', () => {
    const { id } = addMonitored('metrics-app');
    const db = getDb();
    // Insert a sample with an old timestamp.
    db.prepare('INSERT INTO metrics_history (monitored_process_id, sampled_at, cpu, memory) VALUES (?, ?, ?, ?)').run(
      id,
      Date.now() - 90_000_000,
      5,
      500,
    );
    insertMetric(id, 10, 1000);

    purgeOldMetrics(86_400_000); // 24 h
    const remaining = getMetrics(id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].cpu, 10);
  });
});

describe('logStorage', () => {
  beforeEach(cleanDb);

  it('insertLogEntry and getLogEntries round-trip', () => {
    const { id } = addMonitored('log-app');
    const log = JSON.stringify({ lines: ['hello world'], raw: 'hello world' });
    insertLogEntry(id, { loggedAt: Date.now(), logLevel: 'info', log });

    const entries = getLogEntries(id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].log_level, 'info');
    assert.equal(entries[0].log, log);
  });

  it('getLogEntries respects the limit parameter', () => {
    const { id } = addMonitored('log-app');
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      insertLogEntry(id, {
        loggedAt: now + i,
        logLevel: 'info',
        log: JSON.stringify({ lines: [`line ${i}`], raw: `line ${i}` }),
      });
    }
    const entries = getLogEntries(id, { limit: 3 });
    assert.equal(entries.length, 3);
  });

  it('getLogEntries respects the before parameter', () => {
    const { id } = addMonitored('log-app');
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      insertLogEntry(id, {
        loggedAt: base + i * 1000,
        logLevel: 'info',
        log: JSON.stringify({ lines: [`line ${i}`], raw: `line ${i}` }),
      });
    }
    const entries = getLogEntries(id, { before: base + 3000 });
    // Should only return entries with logged_at < base + 3000
    assert.ok(entries.every((e) => e.logged_at < base + 3000));
  });

  it('purgeOldLogs removes records older than the retention window', () => {
    const { id } = addMonitored('log-app');
    const db = getDb();
    db.prepare(
      'INSERT INTO log_entries (monitored_process_id, logged_at, log_level, log) VALUES (?, ?, ?, ?)',
    ).run(id, Date.now() - 15 * 24 * 60 * 60 * 1000, 'info', '{}');
    insertLogEntry(id, { loggedAt: Date.now(), logLevel: 'info', log: '{}' });

    purgeOldLogs(14 * 24 * 60 * 60 * 1000);
    const remaining = getLogEntries(id);
    assert.equal(remaining.length, 1);
  });
});

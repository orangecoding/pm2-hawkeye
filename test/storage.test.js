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
import {
  insertMetric,
  getMetrics,
  purgeOldMetrics,
  insertCustomMetrics,
  getCustomMetrics,
} from '../lib/storage/metricsStorage.js';
import Database from 'better-sqlite3';
import { insertLogEntry, getLogEntries, purgeOldLogs } from '../lib/storage/logStorage.js';
import { compactDb, getDb } from '../lib/storage/db.js';
import { up as migrateLogEntries } from '../lib/storage/migrations/009.log-entries-plain-text.js';

// Helper to clean tables between tests.
function cleanDb() {
  const db = getDb();
  db.prepare('DELETE FROM log_entries').run();
  db.prepare('DELETE FROM metrics_history').run();
  db.prepare('DELETE FROM custom_metrics_history').run();
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

describe('metricsStorage custom metrics', () => {
  beforeEach(cleanDb);

  it('insertCustomMetrics and getCustomMetrics round-trip, grouped by name', () => {
    const { id } = addMonitored('custom-app');
    insertCustomMetrics(id, [
      { name: 'queue size', value: 3, unit: null },
      { name: 'Heap Usage', value: 40, unit: '%' },
    ]);
    insertCustomMetrics(id, [
      { name: 'queue size', value: 5, unit: null },
      { name: 'Heap Usage', value: 41.5, unit: '%' },
    ]);

    const series = getCustomMetrics(id);
    assert.deepEqual(
      series.map((s) => [s.name, s.unit, s.samples.map((x) => x.value)]),
      [
        ['Heap Usage', '%', [40, 41.5]],
        ['queue size', null, [3, 5]],
      ],
    );
  });

  it('skips a metric whose value and unit did not change', () => {
    const { id } = addMonitored('custom-app');
    insertCustomMetrics(id, [{ name: 'jobs', value: 1, unit: null }]);
    insertCustomMetrics(id, [{ name: 'jobs', value: 1, unit: null }]);
    insertCustomMetrics(id, [{ name: 'jobs', value: 1, unit: 'req' }]);

    const [jobs] = getCustomMetrics(id);
    assert.equal(jobs.samples.length, 2);
    assert.equal(jobs.unit, 'req');
  });

  it('getCustomMetrics limits the samples per metric and keeps the newest', () => {
    const { id } = addMonitored('custom-app');
    for (let i = 0; i < 10; i++) {
      insertCustomMetrics(id, [
        { name: 'a', value: i, unit: null },
        { name: 'b', value: i * 2, unit: null },
      ]);
    }
    const series = getCustomMetrics(id, 3);
    assert.deepEqual(
      series.map((s) => s.samples.map((x) => x.value)),
      [
        [7, 8, 9],
        [14, 16, 18],
      ],
    );
  });

  it('purgeOldMetrics removes old custom samples too', () => {
    const { id } = addMonitored('custom-app');
    getDb()
      .prepare(
        'INSERT INTO custom_metrics_history (monitored_process_id, metric_name, unit, sampled_at, value) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, 'old', null, Date.now() - 90_000_000, 1);
    insertCustomMetrics(id, [{ name: 'fresh', value: 2, unit: null }]);

    purgeOldMetrics(86_400_000);
    assert.deepEqual(
      getCustomMetrics(id).map((s) => s.name),
      ['fresh'],
    );
  });

  it('drops custom samples when the process stops being monitored', () => {
    const { id } = addMonitored('custom-app');
    insertCustomMetrics(id, [{ name: 'jobs', value: 1, unit: null }]);
    removeMonitored('custom-app');
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM custom_metrics_history').get().n;
    assert.equal(count, 0);
  });
});

describe('logStorage', () => {
  beforeEach(cleanDb);

  it('insertLogEntry and getLogEntries round-trip', () => {
    const { id } = addMonitored('log-app');
    const log = 'hello world';
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
        log: `line ${i}`,
      });
    }
    const entries = getLogEntries(id, { limit: 3 });
    assert.equal(entries.length, 3);
  });

  it('getLogEntries keeps only the requested levels', () => {
    const { id } = addMonitored('log-app');
    const now = Date.now();
    ['info', 'error', 'warn', 'error', null].forEach((logLevel, i) => {
      insertLogEntry(id, { loggedAt: now + i, logLevel, log: `line ${i}` });
    });
    const errors = getLogEntries(id, { levels: ['error'] });
    assert.deepEqual(
      errors.map((e) => e.log),
      ['line 3', 'line 1'],
    );
    assert.equal(getLogEntries(id, { levels: ['error', 'warn'] }).length, 3);
    assert.equal(getLogEntries(id, { levels: [] }).length, 5);
  });

  it('getLogEntries respects the before parameter', () => {
    const { id } = addMonitored('log-app');
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      insertLogEntry(id, {
        loggedAt: base + i * 1000,
        logLevel: 'info',
        log: `line ${i}`,
      });
    }
    const entries = getLogEntries(id, { before: base + 3000 });
    // Should only return entries with logged_at < base + 3000
    assert.ok(entries.every((e) => e.logged_at < base + 3000));
  });

  it('paginates entries sharing a timestamp without skipping them', () => {
    const { id } = addMonitored('cursor-app');
    const timestamp = Date.now();
    for (let i = 0; i < 4; i++) {
      insertLogEntry(id, {
        loggedAt: timestamp,
        logLevel: 'info',
        log: `line ${i}`,
      });
    }

    const first = getLogEntries(id, { limit: 2 });
    const second = getLogEntries(id, {
      limit: 2,
      before: first.at(-1).logged_at,
      beforeId: first.at(-1).id,
    });

    assert.deepEqual(
      [...first, ...second].map((entry) => entry.log),
      ['line 3', 'line 2', 'line 1', 'line 0'],
    );
  });

  it('purgeOldLogs removes records older than the retention window', () => {
    const { id } = addMonitored('log-app');
    const db = getDb();
    db.prepare('INSERT INTO log_entries (monitored_process_id, logged_at, log_level, log) VALUES (?, ?, ?, ?)').run(
      id,
      Date.now() - 15 * 24 * 60 * 60 * 1000,
      'info',
      '{}',
    );
    insertLogEntry(id, { loggedAt: Date.now(), logLevel: 'info', log: '{}' });

    purgeOldLogs(14 * 24 * 60 * 60 * 1000);
    const remaining = getLogEntries(id);
    assert.equal(remaining.length, 1);
  });
});

describe('log entry migration to plain text', () => {
  /**
   * A bare log_entries table holding the given `log` values.
   *
   * @param {string[]} logs
   * @returns {import('better-sqlite3').Database}
   */
  function tableWith(logs) {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE log_entries (id INTEGER PRIMARY KEY, log TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO log_entries (log) VALUES (?)');
    for (const log of logs) insert.run(log);
    return db;
  }

  it('keeps only the raw text of JSON entries', () => {
    const db = tableWith([
      JSON.stringify({ lines: ['Error: "boom"', '    at a.js:1:1'], raw: 'Error: "boom"\n    at a.js:1:1' }),
    ]);

    migrateLogEntries(db);

    assert.equal(db.prepare('SELECT log FROM log_entries').get().log, 'Error: "boom"\n    at a.js:1:1');
  });

  it('leaves plain text entries alone, also when they are JSON logged by the app', () => {
    const appJson = JSON.stringify({ level: 'info', msg: 'ready', raw: 'not ours' });
    const db = tableWith(['plain line', appJson]);

    migrateLogEntries(db);

    assert.deepEqual(
      db
        .prepare('SELECT log FROM log_entries ORDER BY id')
        .all()
        .map((row) => row.log),
      ['plain line', appJson],
    );
  });
});

describe('compactDb', () => {
  beforeEach(cleanDb);

  it('runs the database with incremental auto-vacuum', () => {
    assert.equal(getDb().pragma('auto_vacuum', { simple: true }), 2);
  });

  it('gives the pages of purged rows back', () => {
    const { id } = addMonitored('log-app');
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const text = 'x'.repeat(2000);
    for (let i = 0; i < 200; i++) insertLogEntry(id, { loggedAt: old, logLevel: 'info', log: text });

    purgeOldLogs(14 * 24 * 60 * 60 * 1000);
    assert.ok(getDb().pragma('freelist_count', { simple: true }) > 0);

    compactDb();
    assert.equal(getDb().pragma('freelist_count', { simple: true }), 0);
  });
});

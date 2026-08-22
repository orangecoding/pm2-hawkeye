/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for hostMetricsStorage.
 *
 * All tests operate on the in-memory SQLite database initialised in setup.mjs.
 */

import { strict as assert } from 'node:assert';
import {
  insertHostMetric,
  getHostMetrics,
  getHostMetricsWindow,
  purgeOldHostMetrics,
} from '../lib/storage/hostMetricsStorage.js';
import { getDb } from '../lib/storage/db.js';

function cleanHostMetrics() {
  getDb().prepare('DELETE FROM host_metrics_history').run();
}

describe('hostMetricsStorage', () => {
  beforeEach(cleanHostMetrics);

  it('insertHostMetric and getHostMetrics round-trip', () => {
    insertHostMetric(10.5, 55.2, 30.1);
    insertHostMetric(20.0, 60.0, 31.0);

    const samples = getHostMetrics();
    assert.equal(samples.length, 2);
    assert.equal(samples[0].cpu, 10.5);
    assert.equal(samples[0].ram, 55.2);
    assert.equal(samples[0].disk, 30.1);
    assert.equal(samples[1].cpu, 20.0);
    assert.ok(samples[0].sampled_at <= samples[1].sampled_at, 'oldest first');
  });

  it('getHostMetrics respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      insertHostMetric(i, i, i);
    }
    const samples = getHostMetrics(3);
    assert.equal(samples.length, 3);
  });

  it('inserts every call regardless of whether values changed', () => {
    insertHostMetric(10.0, 50.0, 40.0);
    insertHostMetric(10.0, 50.0, 40.0); // identical values - still inserted
    const samples = getHostMetrics();
    assert.equal(samples.length, 2);
  });

  it('inserts when any value changes', () => {
    insertHostMetric(10.0, 50.0, 40.0);
    insertHostMetric(10.0, 51.0, 40.0); // ram changed
    const samples = getHostMetrics();
    assert.equal(samples.length, 2);
  });

  it('skips insert when any argument is null', () => {
    insertHostMetric(null, 50.0, 40.0);
    insertHostMetric(10.0, null, 40.0);
    insertHostMetric(10.0, 50.0, null);
    const samples = getHostMetrics();
    assert.equal(samples.length, 0);
  });

  it('purgeOldHostMetrics removes records older than the retention window', () => {
    const db = getDb();
    db.prepare('INSERT INTO host_metrics_history (sampled_at, cpu, ram, disk) VALUES (?, ?, ?, ?)').run(
      Date.now() - 90_000_000,
      5.0,
      40.0,
      20.0,
    );
    insertHostMetric(15.0, 60.0, 25.0);

    purgeOldHostMetrics(86_400_000); // 24 h
    const remaining = getHostMetrics();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].cpu, 15.0);
  });
  describe('getHostMetricsWindow', () => {
    /** Insert a sample with an explicit timestamp, bypassing Date.now(). */
    function insertAt(sampledAt, cpu, ram, disk) {
      getDb()
        .prepare('INSERT INTO host_metrics_history (sampled_at, cpu, ram, disk) VALUES (?, ?, ?, ?)')
        .run(sampledAt, cpu, ram, disk);
    }

    it('averages samples that fall into the same bucket', () => {
      const now = Date.now();
      const bucket = 5 * 60 * 1000;
      const base = Math.floor(now / bucket) * bucket;
      insertAt(base + 1000, 10, 20, 30);
      insertAt(base + 2000, 30, 40, 50);

      const samples = getHostMetricsWindow(60 * 60 * 1000, bucket);
      assert.equal(samples.length, 1);
      assert.equal(samples[0].sampled_at, base);
      assert.equal(samples[0].cpu, 20);
      assert.equal(samples[0].ram, 30);
      assert.equal(samples[0].disk, 40);
    });

    it('keeps separate buckets apart and orders them oldest-first', () => {
      const bucket = 5 * 60 * 1000;
      const base = Math.floor(Date.now() / bucket) * bucket;
      insertAt(base - bucket + 1000, 10, 10, 10);
      insertAt(base + 1000, 50, 50, 50);

      const samples = getHostMetricsWindow(60 * 60 * 1000, bucket);
      assert.equal(samples.length, 2);
      assert.ok(samples[0].sampled_at < samples[1].sampled_at);
      assert.equal(samples[0].cpu, 10);
      assert.equal(samples[1].cpu, 50);
    });

    it('ignores samples older than the window', () => {
      const bucket = 5 * 60 * 1000;
      insertAt(Date.now() - 4 * 60 * 60 * 1000, 99, 99, 99);
      insertAt(Date.now(), 1, 2, 3);

      const samples = getHostMetricsWindow(60 * 60 * 1000, bucket);
      assert.equal(samples.length, 1);
      assert.equal(samples[0].cpu, 1);
    });
  });
});

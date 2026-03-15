/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import * as pm2 from '../lib/service/pm2Service.js';

describe('PM2 Service Logic (pm2Service.js)', () => {
  // ── extractTimestamp ───────────────────────────────────────────────────────

  describe('extractTimestamp', () => {
    it('should extract ISO 8601 timestamp from pm2 --time prefix', () => {
      const line = '0|fredy_tr | 2026-03-14T16:25:41: Received tracking metrics';
      expect(pm2.extractTimestamp(line)).to.equal('2026-03-14T16:25:41');
    });

    it('should extract space-separated timestamp', () => {
      expect(pm2.extractTimestamp('2026-03-14 16:25:41 some message')).to.equal('2026-03-14 16:25:41');
    });

    it('should find a timestamp that appears mid-line', () => {
      expect(pm2.extractTimestamp('0|yolo | 2026-03-14T17:44:13: Server running')).to.equal('2026-03-14T17:44:13');
    });

    it('should find a timestamp inside brackets', () => {
      expect(pm2.extractTimestamp('[2026-01-01T00:00:00] boot')).to.equal('2026-01-01T00:00:00');
    });

    it('should return empty string when no timestamp is present', () => {
      expect(pm2.extractTimestamp('no timestamp here')).to.equal('');
    });

    it('should return empty string for an empty line', () => {
      expect(pm2.extractTimestamp('')).to.equal('');
    });
  });

  // ── normalizeProcessSummary ────────────────────────────────────────────────

  describe('normalizeProcessSummary', () => {
    it('should correctly map raw PM2 data to summary', () => {
      const raw = {
        pm_id: 1,
        name: 'test-app',
        pid: 1234,
        pm2_env: {
          status: 'online',
          version: '1.0.0',
          restart_time: 5,
          pm_uptime: 1000000,
        },
        monit: { cpu: 10, memory: 204800 },
      };

      const summary = pm2.normalizeProcessSummary(raw);
      expect(summary.id).to.equal(1);
      expect(summary.name).to.equal('test-app');
      expect(summary.status).to.equal('online');
      expect(summary.restarts).to.equal(5);
      expect(summary.cpu).to.equal(10);
      expect(summary.memory).to.equal(204800);
    });

    it('should provide defaults for missing fields', () => {
      const summary = pm2.normalizeProcessSummary({ pm_id: 0 });
      expect(summary.name).to.equal('pm2-0');
      expect(summary.status).to.equal('unknown');
      expect(summary.cpu).to.equal(0);
      expect(summary.memory).to.equal(0);
      expect(summary.restarts).to.equal(0);
      expect(summary.watch).to.equal(false);
      expect(summary.pid).to.equal(null);
    });

    it('should fall back to 0 for non-finite monit values', () => {
      const summary = pm2.normalizeProcessSummary({
        pm_id: 2,
        monit: { cpu: NaN, memory: Infinity },
      });
      expect(summary.cpu).to.equal(0);
      expect(summary.memory).to.equal(0);
    });

    it('should set watch to true when env.watch is truthy', () => {
      const summary = pm2.normalizeProcessSummary({
        pm_id: 3,
        pm2_env: { watch: true },
      });
      expect(summary.watch).to.equal(true);
    });

    it('should map exec_mode, namespace and instances from pm2_env', () => {
      const summary = pm2.normalizeProcessSummary({
        pm_id: 4,
        pm2_env: {
          exec_mode: 'cluster',
          namespace: 'prod',
          instances: 4,
        },
      });
      expect(summary.execMode).to.equal('cluster');
      expect(summary.namespace).to.equal('prod');
      expect(summary.instances).to.equal(4);
    });

    it('should use pm_exec_path as scriptPath when available', () => {
      const summary = pm2.normalizeProcessSummary({
        pm_id: 5,
        pm2_env: { pm_exec_path: '/app/index.js', pm_cwd: '/app' },
      });
      expect(summary.scriptPath).to.equal('/app/index.js');
      expect(summary.cwd).to.equal('/app');
    });
  });
});

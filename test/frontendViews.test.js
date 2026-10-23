/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import { byteAxisUnit, findPeak, hourTicks, niceCeil, sampleAt } from '../src/services/chart.js';
import { formatBytesOf, formatShortDuration, parseMemorySize } from '../src/services/format.js';
import {
  RUN_LIMITS,
  deployTabDot,
  deploymentIdFromKey,
  deploymentKey,
  deriveAppName,
  deriveRunState,
  isFirstDeploy,
  outputTone,
  planDeploy,
  pm2Summary,
  recordDeployEvent,
  startRun,
} from '../src/services/deployment.js';
import { buildAttentionItems } from '../src/services/attention.js';

const HOUR = 3_600_000;

describe('frontend view helpers', () => {
  describe('chart scales', () => {
    it('rounds an axis maximum up to a value whose half is nice too', () => {
      expect(niceCeil(41)).to.equal(50);
      expect(niceCeil(14.2)).to.equal(20);
      expect(niceCeil(3)).to.equal(4);
      expect(niceCeil(300)).to.equal(400);
      expect(niceCeil(100)).to.equal(100);
      expect(niceCeil(0)).to.equal(1);
    });

    it('labels a byte axis in the unit of its maximum', () => {
      expect(byteAxisUnit(300 * 1024 ** 2)).to.deep.equal({ unit: 1024 ** 2, label: 'MB' });
      expect(byteAxisUnit(2 * 1024 ** 3)).to.deep.equal({ unit: 1024 ** 3, label: 'GB' });
      expect(byteAxisUnit(10)).to.deep.equal({ unit: 1, label: 'B' });
    });

    it('reads a step series at or before a time', () => {
      const samples = [
        { t: 10, v: 1 },
        { t: 20, v: 2 },
      ];
      expect(sampleAt(samples, 5)).to.equal(null);
      expect(sampleAt(samples, 15)).to.deep.equal({ t: 10, v: 1 });
      expect(sampleAt(samples, 20)).to.deep.equal({ t: 20, v: 2 });
    });

    it('finds the first occurrence of the peak', () => {
      expect(
        findPeak([
          { t: 1, v: 3 },
          { t: 2, v: 7 },
          { t: 3, v: 7 },
        ]),
      ).to.deep.equal({ t: 2, v: 7 });
      expect(findPeak([])).to.equal(null);
    });
  });

  describe('hour ticks', () => {
    it('keeps at most five labels over 24 hours and ends with now', () => {
      const t1 = new Date(2026, 9, 23, 14, 20).getTime();
      const ticks = hourTicks(t1 - 24 * HOUR, t1);
      expect(ticks.length).to.be.at.most(5);
      expect(ticks.at(-1)).to.deep.equal({ label: 'now', pct: 100, align: 'end' });
      expect(ticks.slice(0, -1).map((t) => t.label)).to.deep.equal(['18:00', '00:00', '06:00', '12:00']);
    });

    it('leaves out hours within 90 minutes of now', () => {
      const t1 = new Date(2026, 9, 23, 13, 0).getTime();
      const labels = hourTicks(t1 - 6 * HOUR, t1).map((t) => t.label);
      expect(labels).to.not.include('12:00');
      expect(labels.at(-1)).to.equal('now');
    });
  });

  describe('format helpers', () => {
    it('parses PM2 memory sizes', () => {
      expect(parseMemorySize('300M')).to.equal(300 * 1024 ** 2);
      expect(parseMemorySize('1G')).to.equal(1024 ** 3);
      expect(parseMemorySize('512k')).to.equal(512 * 1024);
      expect(parseMemorySize('1048576')).to.equal(1048576);
      expect(parseMemorySize('')).to.equal(null);
      expect(parseMemorySize('lots')).to.equal(null);
      expect(parseMemorySize(null)).to.equal(null);
    });

    it('names a shared unit once in a used/total pair', () => {
      expect(formatBytesOf(421 * 1024 ** 3, 460 * 1024 ** 3)).to.equal('421 of 460 GB');
      expect(formatBytesOf(900 * 1024 ** 2, 1.5 * 1024 ** 3)).to.equal('900 MB of 1.5 GB');
    });

    it('formats retention windows compactly', () => {
      expect(formatShortDuration(24 * HOUR)).to.equal('24 h');
      expect(formatShortDuration(14 * 24 * HOUR)).to.equal('14 days');
      expect(formatShortDuration(30 * 60_000)).to.equal('30 min');
    });
  });

  describe('deployment helpers', () => {
    it('round-trips deployment selection keys', () => {
      expect(deploymentIdFromKey(deploymentKey('abc'))).to.equal('abc');
      expect(deploymentIdFromKey(3)).to.equal(null);
      expect(deploymentIdFromKey('my-app')).to.equal(null);
    });

    it('derives a valid app name from a repository URL', () => {
      expect(deriveAppName('https://github.com/acme/Shop-API.git')).to.equal('shop-api');
      expect(deriveAppName('git@github.com:acme/landing.page.git')).to.equal('landing-page');
      expect(deriveAppName('https://github.com/acme/repo/')).to.equal('repo');
      expect(deriveAppName('https://github.com/acme/12345')).to.equal('');
      expect(deriveAppName('https://github.com/acme/all.git')).to.equal('');
      expect(deriveAppName('')).to.equal('');
    });

    it('plans the six deploy steps and marks the skipped ones', () => {
      const deployment = {
        repo_url: 'https://example.com/a.git',
        branch: 'main',
        deploy_path: '/srv/a',
        install_cmd: 'npm ci',
        build_cmd: '',
        pre_setup_script: '',
        post_setup_script: '#!/bin/sh\nnode migrate.js',
        start_script: 'server.js',
        pm2_options: { exec_mode: 'fork', instances: 1, max_memory_restart: '300M' },
      };
      const redeploy = planDeploy(deployment, { firstDeploy: false });
      expect(redeploy.map((s) => s.stage)).to.deep.equal([
        'pre_setup',
        'clone',
        'install',
        'build',
        'post_setup',
        'start',
      ]);
      expect(redeploy.filter((s) => s.skipped).map((s) => s.stage)).to.deep.equal(['pre_setup', 'build']);
      expect(redeploy[1].title).to.equal('Update the code');
      expect(redeploy[1].code).to.equal('git fetch --depth 1 origin main\ngit checkout -B main FETCH_HEAD');
      expect(redeploy[4].command).to.equal('node migrate.js');
      expect(redeploy[5].title).to.equal('Restart in PM2');

      const first = planDeploy({ ...deployment, install_cmd: 'skip' }, { firstDeploy: true });
      expect(first[1].code).to.equal('git clone --branch main --depth 1 https://example.com/a.git /srv/a');
      expect(first[2].skipped).to.equal(true);
      expect(first[5].title).to.equal('Start in PM2');

      // A redeploy of a deployment whose PM2 process was deleted starts it again.
      const offline = planDeploy(deployment, { firstDeploy: false, startsProcess: true });
      expect(offline[1].title).to.equal('Update the code');
      expect(offline[5].title).to.equal('Start in PM2');
      expect(pm2Summary(deployment.pm2_options)).to.equal('fork mode, 1 instance, restarts above 300 MB');
    });

    it('maps progress events onto step states', () => {
      const steps = [{ stage: 'clone' }, { stage: 'install' }, { stage: 'build' }, { stage: 'start' }];
      expect(deriveRunState(steps, []).states).to.deep.equal(['pending', 'pending', 'pending', 'pending']);

      const running = deriveRunState(steps, [
        { stage: 'clone', line: 'Fetching main from origin...\n', status: 'running' },
        { stage: 'install', line: 'Running npm ci...\n', status: 'running' },
      ]);
      expect(running.outcome).to.equal('running');
      expect(running.states).to.deep.equal(['done', 'active', 'pending', 'pending']);

      const waiting = deriveRunState(steps, [{ stage: 'clone', line: ' M a.js', status: 'confirm' }]);
      expect(waiting.outcome).to.equal('confirm');
      expect(waiting.states[0]).to.equal('wait');

      const failed = deriveRunState(steps, [
        { stage: 'install', line: 'Running npm ci...\n', status: 'running' },
        { stage: 'build', line: 'Running npm run build...\n', status: 'running' },
        { stage: 'error', line: 'npm exited with code 2', status: 'error' },
      ]);
      expect(failed.outcome).to.equal('failed');
      expect(failed.states).to.deep.equal(['done', 'done', 'fail', 'skip']);
      expect(failed.exitCode).to.equal(2);

      const done = deriveRunState(steps, [{ stage: 'done', line: '', status: 'success' }]);
      expect(done.states).to.deep.equal(['done', 'done', 'done', 'done']);
    });

    it('colours Hawkeye announcements apart from tool output', () => {
      expect(outputTone({ stage: 'install', line: 'Running npm ci...\n', status: 'running' })).to.equal('default');
      expect(outputTone({ stage: 'install', line: 'added 412 packages', status: 'running' })).to.equal('detail');
      expect(outputTone({ stage: 'clone', line: 'Local changes detected. Waiting...', status: 'running' })).to.equal(
        'confirm',
      );
      expect(outputTone({ stage: 'error', line: 'boom', status: 'error' })).to.equal('error');
      expect(outputTone({ stage: 'done', line: '', status: 'success' })).to.equal('success');
    });
  });

  describe('deployment runs', () => {
    it('keeps every deployment in its own run and evicts the oldest', () => {
      let runs = {};
      for (let i = 0; i <= RUN_LIMITS.deployments; i += 1) {
        runs = recordDeployEvent(runs, { deploymentId: `d${i}`, stage: 'clone', line: 'x', status: 'running' }, i);
      }
      expect(Object.keys(runs)).to.have.length(RUN_LIMITS.deployments);
      expect(runs.d0).to.equal(undefined);
      expect(runs[`d${RUN_LIMITS.deployments}`].lines).to.have.length(1);
    });

    it('starts a new run after a finished one and records the question', () => {
      let runs = recordDeployEvent({}, { deploymentId: 'a', stage: 'done', line: '', status: 'success' }, 1);
      expect(runs.a.finishedAt).to.equal(1);
      runs = recordDeployEvent(runs, { deploymentId: 'a', stage: 'clone', line: ' M x', status: 'confirm' }, 2);
      expect(runs.a.lines).to.have.length(1);
      expect(runs.a.confirmChanges).to.equal(' M x');
      expect(runs.a.finishedAt).to.equal(null);
    });

    it('replaces an earlier run when the user starts one', () => {
      let runs = recordDeployEvent({}, { deploymentId: 'a', stage: 'error', line: 'x', status: 'error' }, 1);
      runs = startRun(runs, 'a', { firstDeploy: true, startsProcess: true, now: 5 });
      expect(runs.a.lines).to.deep.equal([]);
      expect(runs.a.firstDeploy).to.equal(true);
      expect(runs.a.startsProcess).to.equal(true);
    });

    it('tells a clone from an update by the events once they arrive', () => {
      const deployment = { last_deployed_at: 1 };
      expect(isFirstDeploy(deployment, undefined)).to.equal(false);
      expect(
        isFirstDeploy(deployment, { lines: [{ stage: 'clone', line: 'Cloning https://x (branch: main)...\n' }] }),
      ).to.equal(true);
    });

    it('picks the Deploy tab dot, first match wins', () => {
      const deployment = { last_deployed_at: 1, deploying: 0, watch_last_error: null };
      expect(deployTabDot(deployment, undefined)).to.equal(null);
      expect(deployTabDot({ ...deployment, deploying: 1 }, undefined).tone).to.equal('accent');
      expect(deployTabDot({ ...deployment, watch_last_error: 'denied' }, undefined).tone).to.equal('warning');
      const waiting = { lines: [{ stage: 'clone', line: 'M', status: 'confirm' }], finishedAt: null };
      expect(deployTabDot({ ...deployment, deploying: 1 }, waiting).tone).to.equal('warning');
      const failed = { lines: [{ stage: 'error', line: 'x', status: 'error' }], finishedAt: 2 };
      expect(deployTabDot(deployment, failed).tone).to.equal('critical');
    });
  });

  describe('attention items', () => {
    it('lists critical items before warnings and skips stopped processes', () => {
      const items = buildAttentionItems({
        processes: [
          { id: 1, name: 'worker', status: 'errored', restarts: 15 },
          { id: 2, name: 'backup', status: 'stopped' },
        ],
        offlineDeployments: [{ id: 'b', pm2_name: 'landing', deploying: 0, last_deployed_at: null }],
        deployments: [
          { id: 'b', pm2_name: 'landing', deploying: 0, last_deployed_at: null },
          {
            id: 'c',
            pm2_name: 'api',
            last_deployed_at: 1,
            watch_last_error: 'Permission denied',
            watch_last_checked_at: 0,
          },
        ],
        deployRuns: {},
        hostCurrent: { cpu: 20, ram: 50, disk: 91, diskUsed: 421 * 1024 ** 3, diskTotal: 460 * 1024 ** 3 },
      });
      expect(items.map((i) => i.title)).to.deep.equal([
        'landing was never deployed successfully',
        'worker is errored',
        'Disk is 91% full',
        'api auto-deploy check failed',
      ]);
      expect(items[2].detail).to.equal('421 of 460 GB used on this machine.');
      expect(items[1].action).to.deep.equal({ label: 'Open logs', kind: 'logs', processKey: 1 });
    });

    it('reports a failed or waiting run of this session', () => {
      const deployments = [
        { id: 'a', pm2_name: 'shop', last_deployed_at: 1, build_cmd: 'npm run build' },
        { id: 'b', pm2_name: 'blog', last_deployed_at: 1 },
      ];
      const items = buildAttentionItems({
        processes: [],
        offlineDeployments: [],
        deployments,
        deployRuns: {
          a: {
            lines: [
              { stage: 'build', line: 'Running npm run build...\n', status: 'running' },
              { stage: 'error', line: 'npm exited with code 2\nmore', status: 'error' },
            ],
          },
          b: { lines: [{ stage: 'clone', line: ' M x', status: 'confirm' }] },
        },
        hostCurrent: null,
      });
      expect(items.map((i) => [i.level, i.title, i.detail])).to.deep.equal([
        ['critical', 'shop: redeploy failed at Build', 'npm exited with code 2'],
        ['warning', 'blog: deployment is waiting for you', 'Local changes in the deploy folder need a decision.'],
      ]);
    });
  });
});

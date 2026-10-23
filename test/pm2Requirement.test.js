/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for the PM2 version requirement. The CLI and daemon readers are
 * injected, so no PM2 installation is needed.
 */

import { expect } from 'chai';
import {
  MIN_PM2_MAJOR,
  checkPm2Requirement,
  parsePm2Version,
  pm2RequirementMessage,
} from '../lib/service/pm2Requirement.js';

describe('PM2 requirement (pm2Requirement.js)', () => {
  describe('parsePm2Version', () => {
    it('reads a bare version', () => {
      expect(parsePm2Version('7.1.0\n')).to.equal('7.1.0');
    });

    it('skips the out-of-date notice the CLI can print around it', () => {
      const output = '\n>>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update\n6.0.14\n';
      expect(parsePm2Version(output)).to.equal('6.0.14');
    });

    it('accepts pre-release versions', () => {
      expect(parsePm2Version('7.0.0-beta.1')).to.equal('7.0.0-beta.1');
    });

    it('returns null when no version is printed', () => {
      expect(parsePm2Version('command not found')).to.equal(null);
      expect(parsePm2Version(undefined)).to.equal(null);
    });
  });

  describe('pm2RequirementMessage', () => {
    it('requires version 7', () => {
      expect(MIN_PM2_MAJOR).to.equal(7);
    });

    it('accepts an installed PM2 7 with a matching daemon', () => {
      expect(pm2RequirementMessage({ cliVersion: '7.1.0', daemonVersion: '7.1.0' })).to.equal(null);
    });

    it('accepts a newer major version', () => {
      expect(pm2RequirementMessage({ cliVersion: '8.0.2', daemonVersion: '8.0.2' })).to.equal(null);
    });

    it('reports a missing pm2 command with install instructions', () => {
      const message = pm2RequirementMessage({ cliVersion: null });
      expect(message).to.include('no "pm2" command was found');
      expect(message).to.include('npm install -g pm2@latest');
    });

    it('reports an installed PM2 older than 7', () => {
      const message = pm2RequirementMessage({ cliVersion: '6.0.14' });
      expect(message).to.include('PM2 6.0.14 is installed');
      expect(message).to.include('pm2 update');
    });

    it('reports a daemon that still runs the old version', () => {
      const message = pm2RequirementMessage({ cliVersion: '7.1.0', daemonVersion: '6.0.14' });
      expect(message).to.include('daemon is still 6.0.14');
      expect(message).to.include('pm2 update');
    });
  });

  describe('checkPm2Requirement', () => {
    it('passes when CLI and daemon are on PM2 7', async () => {
      const result = await checkPm2Requirement({
        readCliVersion: async () => '7.1.0',
        readDaemonVersion: async () => '7.1.0',
      });
      expect(result).to.equal(null);
    });

    it('does not ask the daemon when the installed PM2 is too old', async () => {
      let daemonAsked = false;
      const result = await checkPm2Requirement({
        readCliVersion: async () => '6.0.14',
        readDaemonVersion: async () => {
          daemonAsked = true;
          return '6.0.14';
        },
      });
      expect(result).to.include('PM2 6.0.14 is installed');
      expect(daemonAsked).to.equal(false);
    });

    it('fails when the daemon is older than the installed PM2', async () => {
      const result = await checkPm2Requirement({
        readCliVersion: async () => '7.1.0',
        readDaemonVersion: async () => '6.0.14',
      });
      expect(result).to.include('daemon is still 6.0.14');
    });

    it('fails instead of passing when a version cannot be read', async () => {
      const result = await checkPm2Requirement({
        readCliVersion: async () => '7.1.0',
        readDaemonVersion: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      });
      expect(result).to.include('could not check the PM2 version: connect ECONNREFUSED');
    });
  });
});

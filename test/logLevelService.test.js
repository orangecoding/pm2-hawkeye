/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for the runtime log level service.
 *
 * The service is built through a factory that closes over its transport, so
 * every test here runs against a fake sender and never talks to a PM2 daemon.
 */

import { expect } from 'chai';
import { LOG_LEVELS, normalizeLevel, createLogLevelChannel } from '../lib/service/logLevelService.js';

describe('Log Level Service (logLevelService.js)', () => {
  // ── normalizeLevel ─────────────────────────────────────────────────────────

  describe('normalizeLevel', () => {
    it('should accept every supported level unchanged', () => {
      for (const level of LOG_LEVELS) {
        expect(normalizeLevel(level)).to.equal(level);
      }
    });

    it('should lower-case and trim its input', () => {
      expect(normalizeLevel('  DeBuG ')).to.equal('debug');
    });

    it('should reject a level the service does not know', () => {
      expect(normalizeLevel('verbose')).to.equal(null);
    });

    it('should reject values that are not strings', () => {
      expect(normalizeLevel(30)).to.equal(null);
      expect(normalizeLevel(undefined)).to.equal(null);
      expect(normalizeLevel(null)).to.equal(null);
    });
  });

  // ── getState ───────────────────────────────────────────────────────────────

  describe('getState', () => {
    it('should return null for a process it has never heard from', () => {
      const channel = createLogLevelChannel(async () => {});
      expect(channel.getState(7, 1000)).to.equal(null);
    });
  });

  // ── Request lifecycle ──────────────────────────────────────────────────────

  describe('setLevel', () => {
    it('should send the requested level and resolve with what the process reported', async () => {
      const sent = [];
      const channel = createLogLevelChannel(
        async (pmId, packet) => {
          sent.push({ pmId, packet });
        },
        { ackTimeoutMs: 200 },
      );

      // The pending request is registered synchronously, before the first
      // await inside setLevel, so acknowledging on the next line is safe.
      const answer = channel.setLevel(3, 111, 'debug');
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'debug' } });

      const result = await answer;
      expect(result.ok).to.be.true;
      expect(result.level).to.equal('debug');
      expect(result.ackAt).to.be.a('number');
      expect(sent).to.have.lengthOf(1);
      expect(sent[0].pmId).to.equal(3);
      expect(sent[0].packet.topic).to.equal('hawkeye:log-level');
      expect(sent[0].packet.data).to.deep.equal({ level: 'debug' });
    });

    it('should trust the level in the acknowledgement over the requested one', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 200 });
      const answer = channel.setLevel(3, 111, 'trace');
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'info' } });
      expect((await answer).level).to.equal('info');
    });

    it('should resolve with no-ack when the process stays silent', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 20 });
      const result = await channel.setLevel(3, 111, 'debug');
      expect(result).to.deep.equal({ ok: false, reason: 'no-ack' });
    });

    it('should supersede an in-flight request for the same process', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 200 });
      const first = channel.setLevel(3, 111, 'debug');
      const second = channel.setLevel(3, 111, 'warn');
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'warn' } });

      expect(await first).to.deep.equal({ ok: false, reason: 'superseded' });
      expect((await second).level).to.equal('warn');
    });

    it('should reject and forget the request when the transport fails', async () => {
      const channel = createLogLevelChannel(
        async () => {
          throw new Error('pm2 socket closed');
        },
        { ackTimeoutMs: 20 },
      );

      let message = '';
      try {
        await channel.setLevel(3, 111, 'debug');
      } catch (err) {
        message = err.message;
      }
      expect(message).to.equal('pm2 socket closed');

      // A late acknowledgement for a forgotten request must not be stored.
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'debug' } });
      expect(channel.getState(3, 111)).to.equal(null);
    });
  });

  describe('queryLevel', () => {
    it('should send no level so the process only reports its current one', async () => {
      const sent = [];
      const channel = createLogLevelChannel(
        async (pmId, packet) => {
          sent.push(packet);
        },
        { ackTimeoutMs: 200 },
      );

      const answer = channel.queryLevel(3, 111);
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'info' } });

      expect((await answer).level).to.equal('info');
      expect(sent[0].data).to.deep.equal({});
    });
  });

  describe('handleAck', () => {
    it('should ignore an acknowledgement for a process with no pending request', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 20 });
      channel.handleAck({ process: { pm_id: 9 }, data: { level: 'debug' } });
      expect(channel.getState(9, 111)).to.equal(null);
    });

    it('should not resolve a pending request from another process', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 20 });
      const answer = channel.setLevel(3, 111, 'debug');
      channel.handleAck({ process: { pm_id: 4 }, data: { level: 'debug' } });
      expect(await answer).to.deep.equal({ ok: false, reason: 'no-ack' });
    });

    it('should ignore an acknowledgement carrying an unsupported level', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 20 });
      const answer = channel.setLevel(3, 111, 'debug');
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'chatty' } });
      expect(await answer).to.deep.equal({ ok: false, reason: 'no-ack' });
    });
  });

  describe('getState after an acknowledgement', () => {
    it('should keep the level for the uptime it was acknowledged for', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 200 });
      const answer = channel.setLevel(3, 111, 'debug');
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'debug' } });
      await answer;

      expect(channel.getState(3, 111).level).to.equal('debug');
    });

    it('should drop the level once the process has restarted', async () => {
      const channel = createLogLevelChannel(async () => {}, { ackTimeoutMs: 200 });
      const answer = channel.setLevel(3, 111, 'debug');
      channel.handleAck({ process: { pm_id: 3 }, data: { level: 'debug' } });
      await answer;

      expect(channel.getState(3, 222)).to.equal(null);
      expect(channel.getState(3, 111)).to.equal(null);
    });
  });
});

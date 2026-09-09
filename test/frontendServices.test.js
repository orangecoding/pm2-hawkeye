/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import * as api from '../src/services/api.js';

describe('frontend services', () => {
  describe('fetchWithCsrf', () => {
    it('refreshes the consumed token after a failed mutation', async () => {
      const originalFetch = global.fetch;
      const refreshed = [];
      global.fetch = async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'mutation failed' }),
      });

      try {
        let error;
        try {
          await api.fetchWithCsrf('/api/example', {
            onCsrfRefresh: async () => {
              refreshed.push('fresh-token');
              return 'fresh-token';
            },
            method: 'POST',
          });
        } catch (caught) {
          error = caught;
        }

        expect(error).to.be.an('error').with.property('message', 'mutation failed');
        expect(refreshed).to.deep.equal(['fresh-token', 'fresh-token']);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('preserves a successful mutation result when the post-request refresh fails', async () => {
      const originalFetch = global.fetch;
      let refreshCount = 0;
      const refreshErrors = [];
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

      try {
        const result = await api.fetchWithCsrf('/api/example', {
          method: 'POST',
          onCsrfRefresh: async () => {
            refreshCount += 1;
            if (refreshCount === 2) throw new Error('refresh failed');
            return 'fresh-token';
          },
          onCsrfRefreshError: (error) => refreshErrors.push(error.message),
        });
        expect(result).to.deep.equal({ ok: true });
        expect(refreshErrors).to.deep.equal(['refresh failed']);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('preserves the mutation error when the post-request refresh also fails', async () => {
      const originalFetch = global.fetch;
      let refreshCount = 0;
      global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) });

      try {
        let error;
        try {
          await api.fetchWithCsrf('/api/example', {
            method: 'POST',
            onCsrfRefresh: async () => {
              refreshCount += 1;
              if (refreshCount === 2) throw new Error('refresh failed');
              return 'fresh-token';
            },
            onCsrfRefreshError: () => {},
          });
        } catch (caught) {
          error = caught;
        }
        expect(error).to.be.an('error').with.property('message', 'conflict');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('serializes mutations and gets a fresh token for each request', async () => {
      const originalFetch = global.fetch;
      const headers = [];
      let tokenNumber = 0;
      global.fetch = async (_url, options) => {
        headers.push(options.headers['X-CSRF-Token']);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };

      try {
        const options = {
          method: 'POST',
          onCsrfRefresh: async () => {
            tokenNumber += 1;
            return `token-${tokenNumber}`;
          },
        };
        await Promise.all([api.fetchWithCsrf('/api/one', options), api.fetchWithCsrf('/api/two', options)]);
        expect(headers).to.deep.equal(['token-1', 'token-3']);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('deployment normalization', () => {
    it('preserves an explicit zero instead of replacing it with the default', async () => {
      const deployment = await import('../src/services/deployment.js').catch(() => null);
      expect(deployment, 'deployment service').not.to.equal(null);
      if (!deployment) return;
      expect(deployment.normalizePm2Number('0', 10)).to.equal(0);
      expect(deployment.normalizePm2Number('', 10)).to.equal(10);
    });
  });

  describe('stored log pagination', () => {
    it('builds a cursor URL and prepends older display lines', async () => {
      const logs = await import('../src/services/logs.js').catch(() => null);
      expect(logs, 'logs service').not.to.equal(null);
      if (!logs) return;
      expect(logs.buildStoredLogsUrl('worker one', { before: 1700000000000, beforeId: 42 })).to.equal(
        '/api/processes/worker%20one/logs/stored?before=1700000000000&beforeId=42',
      );
      expect(logs.prependStoredLogPage([{ text: 'new' }], [{ text: 'old' }])).to.deep.equal([
        { text: 'old' },
        { text: 'new' },
      ]);
    });

    it('bounds a queued background-tab log burst', async () => {
      const logs = await import('../src/services/logs.js');
      const queued = logs.appendBounded(
        Array.from({ length: 800 }, (_, index) => index),
        [800, 801],
        800,
      );
      expect(queued).to.have.length(800);
      expect(queued[0]).to.equal(2);
      expect(queued[799]).to.equal(801);
    });
  });

  describe('WebSocket reconnection', () => {
    it('reconnects after a closed connection and stops reconnecting after cleanup', async () => {
      const realtime = await import('../src/services/realtime.js').catch(() => null);
      expect(realtime, 'realtime service').not.to.equal(null);
      if (!realtime) return;
      const sockets = [];
      const scheduled = [];
      class FakeSocket {
        static OPEN = 1;

        constructor(url) {
          this.url = url;
          this.readyState = 0;
          sockets.push(this);
        }

        close() {
          this.readyState = 3;
        }
      }

      const connection = realtime.createReconnectingWebSocket({
        url: 'ws://localhost/ws/stream',
        WebSocketImpl: FakeSocket,
        schedule: (callback, delay) => {
          scheduled.push({ callback, delay });
          return scheduled.length;
        },
        cancel: () => {},
        onMessage: () => {},
        onStateChange: () => {},
        onSocket: () => {},
      });

      expect(sockets).to.have.length(1);
      sockets[0].onclose();
      expect(scheduled).to.have.length(1);
      expect(scheduled[0].delay).to.equal(500);
      scheduled[0].callback();
      expect(sockets).to.have.length(2);

      connection.close();
      sockets[1].onclose();
      expect(scheduled).to.have.length(1);
    });
  });
});

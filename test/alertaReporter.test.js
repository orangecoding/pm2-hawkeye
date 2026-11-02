/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for the alerta reporter. fetch is stubbed; nothing leaves the process.
 */

import { strict as assert } from 'node:assert';
import { parseTargets, sendAlerta, testAlerta, toAlertaTopic } from '../lib/service/reporters/alerta.js';

const CONFIG = {
  url: 'https://alerta.example.com/',
  apiKey: ' secret-key ',
  targets: 'chriz, katha',
  priority: 'time-sensitive',
};

const PAYLOAD = {
  log_level: 'error',
  process_name: 'my.app',
  log: 'Error: boom',
  time: '2026-11-02T13:00:00.000Z',
};

describe('alerta reporter', () => {
  const realFetch = globalThis.fetch;
  let calls;

  /** @param {number} status @param {object} [body] */
  function stubFetch(status, body = {}) {
    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => body };
    };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe('toAlertaTopic', () => {
    it('makes every PM2 process name a valid alerta topic', () => {
      assert.equal(toAlertaTopic('my-app'), 'my-app');
      assert.equal(toAlertaTopic('api.v2 (worker)'), 'api-v2-worker');
      assert.equal(toAlertaTopic('x'.repeat(80)), 'x'.repeat(64));
      assert.equal(toAlertaTopic('...'), 'pm2');
    });
  });

  describe('parseTargets', () => {
    it('splits on commas, trims and drops empty and duplicate names', () => {
      assert.deepEqual(parseTargets(' chriz, katha,,chriz '), ['chriz', 'katha']);
      assert.deepEqual(parseTargets(''), []);
    });
  });

  describe('sendAlerta', () => {
    it('posts one push to /api/notify with the process as topic', async () => {
      stubFetch(201);

      await sendAlerta(CONFIG, PAYLOAD);

      assert.equal(calls.length, 1);
      const { url, init } = calls[0];
      assert.equal(url, 'https://alerta.example.com/api/notify');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer secret-key');
      assert.deepEqual(JSON.parse(init.body), {
        targets: ['chriz', 'katha'],
        topic: 'my-app',
        title: '[ERROR] my.app',
        message: '2026-11-02T13:00:00.000Z\nError: boom',
        priority: 'time-sensitive',
      });
    });

    it("rejects with alerta's own error message", async () => {
      stubFetch(400, { error: { code: 'UNKNOWN_TARGET', message: 'Unknown target: oma (known: chriz)' } });

      await assert.rejects(
        sendAlerta({ ...CONFIG, targets: 'oma' }, PAYLOAD),
        /HTTP 400: Unknown target: oma \(known: chriz\)/,
      );
    });
  });

  describe('testAlerta', () => {
    it('reports success with the HTTP status', async () => {
      stubFetch(201);

      assert.deepEqual(await testAlerta(CONFIG), { ok: true, status: 201 });
    });

    it('reports a failure instead of throwing', async () => {
      stubFetch(401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });

      const result = await testAlerta(CONFIG);

      assert.equal(result.ok, false);
      assert.match(result.error, /HTTP 401: Unauthorized/);
    });
  });
});

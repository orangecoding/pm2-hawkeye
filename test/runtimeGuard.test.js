/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { strict as assert } from 'node:assert';
import { assertSupportedRuntime, detectRuntime, unsupportedRuntimeMessage } from '../lib/runtimeGuard.js';

/** Collect the calls of the injected exit/error hooks. */
function spies() {
  const calls = { exitCodes: [], messages: [] };
  return {
    calls,
    exit: (code) => calls.exitCodes.push(code),
    onError: (message) => calls.messages.push(message),
  };
}

describe('runtime guard', () => {
  it('detects Node.js', () => {
    assert.deepEqual(detectRuntime({ process: { versions: { node: '22.14.0' } } }), {
      name: 'node',
      version: '22.14.0',
    });
  });

  it('detects Bun', () => {
    assert.deepEqual(detectRuntime({ Bun: { version: '1.4.2' } }), { name: 'bun', version: '1.4.2' });
  });

  it('detects Deno', () => {
    assert.deepEqual(detectRuntime({ Deno: { version: { deno: '2.1.0' } } }), { name: 'deno', version: '2.1.0' });
  });

  it('returns no message for Node.js', () => {
    assert.equal(unsupportedRuntimeMessage({ name: 'node', version: '22.14.0' }), null);
  });

  it('explains the Bun incompatibility', () => {
    const message = unsupportedRuntimeMessage({ name: 'bun', version: '1.4.2' });
    assert.match(message, /unsupported runtime: Bun 1\.4\.2/);
    assert.match(message, /better-sqlite3/);
    assert.match(message, /npm start/);
  });

  it('lets Node.js start up', () => {
    const { calls, exit, onError } = spies();
    const ok = assertSupportedRuntime({
      globalObject: { process: { versions: { node: '22.14.0' } } },
      env: {},
      exit,
      onError,
    });

    assert.equal(ok, true);
    assert.deepEqual(calls.exitCodes, []);
    assert.deepEqual(calls.messages, []);
  });

  it('aborts startup on Bun with exit code 1', () => {
    const { calls, exit, onError } = spies();
    const ok = assertSupportedRuntime({
      globalObject: { Bun: { version: '1.4.2' } },
      env: {},
      exit,
      onError,
    });

    assert.equal(ok, false);
    assert.deepEqual(calls.exitCodes, [1]);
    assert.equal(calls.messages.length, 1);
  });

  it('can be bypassed with ALLOW_UNSUPPORTED_RUNTIME=1', () => {
    const { calls, exit, onError } = spies();
    const ok = assertSupportedRuntime({
      globalObject: { Bun: { version: '1.4.2' } },
      env: { ALLOW_UNSUPPORTED_RUNTIME: '1' },
      exit,
      onError,
    });

    assert.equal(ok, true);
    assert.deepEqual(calls.exitCodes, []);
    assert.deepEqual(calls.messages, []);
  });
});

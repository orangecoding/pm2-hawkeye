/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { strict as assert } from 'node:assert';
import { startRuntime } from '../lib/transport/startup.js';

describe('runtime startup', () => {
  it('starts the log bus and listener before launching backfill in the background', async () => {
    const events = [];
    let onListening;

    await startRuntime({
      startLogBus: async () => events.push('bus'),
      startServices: () => events.push('services'),
      listen: (callback) => {
        events.push('listen');
        onListening = callback;
      },
      backfill: async () => events.push('backfill'),
      onBackfillError: () => assert.fail('backfill should not fail'),
    });

    assert.deepEqual(events, ['services', 'listen']);
    onListening();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['services', 'listen', 'bus', 'backfill']);
  });

  it('retries a failed log bus attach and backfills only after it succeeds', async () => {
    const events = [];
    let onListening;
    let attempts = 0;

    await startRuntime({
      startLogBus: async () => {
        attempts += 1;
        events.push(`bus-${attempts}`);
        if (attempts === 1) throw new Error('PM2 unavailable');
      },
      startServices: () => {},
      listen: (callback) => {
        onListening = callback;
      },
      backfill: async () => events.push('backfill'),
      onBackfillError: (error) => events.push(`error:${error.message}`),
      waitBeforeRetry: async () => events.push('wait'),
    });

    onListening();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, ['bus-1', 'error:PM2 unavailable', 'wait', 'bus-2', 'backfill']);
  });
});

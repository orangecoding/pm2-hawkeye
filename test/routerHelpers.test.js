/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { strict as assert } from 'node:assert';
import { parseStoredLogQuery } from '../lib/transport/router.js';

describe('router query validation', () => {
  it('accepts a bounded stored-log cursor', () => {
    assert.deepEqual(parseStoredLogQuery({ limit: '50', before: '1234', beforeId: '99' }), {
      ok: true,
      limit: 50,
      before: 1234,
      beforeId: 99,
    });
  });

  for (const query of [{ limit: '-1' }, { limit: '501' }, { limit: 'abc' }, { before: 'abc' }, { beforeId: '1' }]) {
    it(`rejects invalid stored-log query ${JSON.stringify(query)}`, () => {
      assert.equal(parseStoredLogQuery(query).ok, false);
    });
  }
});

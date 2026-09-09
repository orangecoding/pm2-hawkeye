/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { strict as assert } from 'node:assert';
import { excludeStoredGroups, filterBackfillLines, groupLogLines } from '../lib/service/logBackfill.js';
import { mergeLogFileLines } from '../lib/service/pm2Service.js';

describe('log backfill ordering', () => {
  it('keeps continuation lines attached to their timestamped entry while merging files', () => {
    const merged = mergeLogFileLines([
      {
        type: 'stderr',
        available: true,
        lines: [{ text: '2026-01-01T10:00:02.000Z error' }, { text: '    at second.js:2:1' }],
      },
      {
        type: 'stdout',
        available: true,
        lines: [{ text: '2026-01-01T10:00:01.000Z ready' }],
      },
    ]);

    assert.deepEqual(
      merged.map((line) => line.text),
      ['2026-01-01T10:00:01.000Z ready', '2026-01-01T10:00:02.000Z error', '    at second.js:2:1'],
    );
  });

  it('includes the last stored timestamp boundary to avoid losing same-time entries', () => {
    const since = Date.parse('2026-01-01T10:00:02.000Z');
    const lines = [
      { text: '2026-01-01T10:00:01.999Z old', source: 'stdout' },
      { text: '2026-01-01T10:00:02.000Z boundary', source: 'stdout' },
      { text: '2026-01-01T10:00:02.001Z new', source: 'stdout' },
    ];

    assert.deepEqual(
      filterBackfillLines(lines, since).map((line) => line.text),
      ['2026-01-01T10:00:02.000Z boundary', '2026-01-01T10:00:02.001Z new'],
    );
  });

  it('groups timestamp-less continuation lines with their primary line', () => {
    const groups = groupLogLines(
      [
        { text: '2026-01-01T10:00:02.000Z Error: boom', source: 'stderr' },
        { text: '    at first.js:1:1', source: 'stderr' },
        { text: '    at second.js:2:1', source: 'stderr' },
      ],
      1,
    );

    assert.equal(groups.length, 1);
    assert.deepEqual(JSON.parse(groups[0].log).lines, [
      '2026-01-01T10:00:02.000Z Error: boom',
      '    at first.js:1:1',
      '    at second.js:2:1',
    ]);
  });

  it('deduplicates stored boundary groups by occurrence count', () => {
    const boundary = Date.parse('2026-01-01T10:00:02.000Z');
    const repeated = JSON.stringify({ lines: ['same'], raw: 'same' });
    const groups = [
      { loggedAt: boundary, logLevel: 'info', log: repeated },
      { loggedAt: boundary, logLevel: 'info', log: repeated },
      { loggedAt: boundary + 1, logLevel: 'info', log: repeated },
    ];

    assert.deepEqual(excludeStoredGroups(groups, [{ logged_at: boundary, log: repeated }]), [groups[1], groups[2]]);
  });

  it('deduplicates groups already captured by the live bus after the boundary', () => {
    const boundary = Date.parse('2026-01-01T10:00:02.000Z');
    const liveLog = JSON.stringify({ lines: ['live'], raw: 'live' });
    const groups = [{ loggedAt: boundary + 1, logLevel: 'info', log: liveLog }];

    assert.deepEqual(excludeStoredGroups(groups, [{ logged_at: boundary + 1, log: liveLog }]), []);
  });

  it('deduplicates live bus groups when no prior backfill boundary exists', () => {
    const loggedAt = Date.parse('2026-01-01T10:00:02.000Z');
    const liveLog = JSON.stringify({ lines: ['first'], raw: 'first' });
    const groups = [{ loggedAt, logLevel: 'info', log: liveLog }];

    assert.deepEqual(excludeStoredGroups(groups, [{ logged_at: loggedAt, log: liveLog }]), []);
  });
});

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { up } from '../lib/storage/migrations/008.alerta-endpoints.js';

describe('migration 008: alerta endpoints', () => {
  it('drops the old alerta targets setting, so saving the settings works again', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE alerting_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO alerting_settings (key, value, updated_at) VALUES (?, ?, 1)');
    insert.run('reporter.alerta.targets', 'chriz, katha');
    insert.run('reporter.alerta.url', 'https://alerta.example.com');

    up(db);

    const keys = db
      .prepare('SELECT key FROM alerting_settings ORDER BY key')
      .all()
      .map((row) => row.key);
    assert.deepEqual(keys, ['reporter.alerta.url']);
  });
});

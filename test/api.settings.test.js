/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Integration tests for alerting settings, notification prefs, and general
 * settings API endpoints.
 */

import { expect } from 'chai';
import request from 'supertest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import app from '../lib/transport/server.js';
import { getDb } from '../lib/storage/db.js';
import { addMonitored } from '../lib/storage/monitoringStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Remove all alerting and monitoring rows between tests. */
function cleanDb() {
  const db = getDb();
  db.prepare('DELETE FROM alerting_settings').run();
  db.prepare('DELETE FROM log_entries').run();
  db.prepare('DELETE FROM metrics_history').run();
  db.prepare('DELETE FROM monitored_processes').run();
}

/** Log in and return { cookie, csrfToken }. */
async function getAuthSession() {
  const loginRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
  const cookie = loginRes.headers['set-cookie'][0];
  const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);
  return { cookie, csrfToken: sessionRes.body.csrfToken };
}

// ── Alerting settings ────────────────────────────────────────────────────────

describe('GET /api/alerting/settings', () => {
  beforeEach(cleanDb);

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/alerting/settings');
    expect(res.status).to.equal(401);
  });

  it('returns { settings: {} } when DB is empty', async () => {
    const { cookie } = await getAuthSession();
    const res = await request(app).get('/api/alerting/settings').set('Cookie', cookie);
    expect(res.status).to.equal(200);
    expect(res.body.settings).to.deep.equal({});
  });
});

describe('POST /api/alerting/settings', () => {
  beforeEach(cleanDb);

  it('returns 403 without CSRF token', async () => {
    const { cookie } = await getAuthSession();
    const res = await request(app)
      .post('/api/alerting/settings')
      .set('Cookie', cookie)
      .send({ settings: { 'alert.mode': 'every' } });
    expect(res.status).to.equal(403);
  });

  it('returns 400 for unknown settings keys', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/alerting/settings')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ settings: { 'unknown.key': 'value' } });
    expect(res.status).to.equal(400);
  });

  it('saves known keys and returns { ok: true }', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/alerting/settings')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ settings: { 'alert.mode': 'throttle', 'alert.throttleMinutes': '30' } });
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(true);

    // Verify settings were persisted.
    const { cookie: cookie2 } = await getAuthSession();
    const getRes = await request(app).get('/api/alerting/settings').set('Cookie', cookie2);
    expect(getRes.body.settings['alert.mode']).to.equal('throttle');
    expect(getRes.body.settings['alert.throttleMinutes']).to.equal('30');
  });
});

// ── Reporter tests ────────────────────────────────────────────────────────────

describe('POST /api/alerting/test/webhook', () => {
  it('returns { ok: false, error: string } for unreachable URL', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/alerting/test/webhook')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ url: 'http://localhost:19999/nonexistent', headers: [] });
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(false);
    expect(res.body.error).to.be.a('string');
  });
});

describe('POST /api/alerting/test/ntfy', () => {
  it('returns { ok: false, error: string } for bad config', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/alerting/test/ntfy')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ serverUrl: 'http://localhost:19999', topic: 'test-topic', priority: 'default' });
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(false);
    expect(res.body.error).to.be.a('string');
  });
});

// ── Session config block ──────────────────────────────────────────────────────

describe('GET /api/auth/session (config block)', () => {
  it('returns config block with env values', async () => {
    const { cookie } = await getAuthSession();
    const res = await request(app).get('/api/auth/session').set('Cookie', cookie);
    expect(res.status).to.equal(200);
    const { config } = res.body;
    expect(config).to.be.an('object');
    expect(config).to.have.all.keys(
      'host',
      'port',
      'authUsername',
      'sessionTtlMs',
      'cookieSecure',
      'trustProxy',
      'maxLogBytesPerFile',
      'metricsRetentionMs',
      'logsRetentionMs',
      'sqliteDbPath',
    );
  });
});

// ── General settings ──────────────────────────────────────────────────────────

describe('GET /api/settings/general', () => {
  it('returns settings object read from the .env file', async () => {
    const realEnvPath = path.resolve(__dirname, '..', '.env');
    let originalEnv = null;
    try {
      originalEnv = fs.readFileSync(realEnvPath, 'utf8');
    } catch {
      // .env may not exist.
    }
    fs.writeFileSync(realEnvPath, 'HOST=0.0.0.0\nPORT=3030\n', 'utf8');

    try {
      const { cookie } = await getAuthSession();
      const res = await request(app).get('/api/settings/general').set('Cookie', cookie);
      expect(res.status).to.equal(200);
      expect(res.body.settings).to.be.an('object');
      // Raw env key names are returned (not camelCase field names).
      expect(res.body.settings.HOST).to.be.a('string');
      expect(res.body.settings.PORT).to.be.a('string');
    } finally {
      if (originalEnv !== null) {
        fs.writeFileSync(realEnvPath, originalEnv, 'utf8');
      } else {
        try {
          fs.unlinkSync(realEnvPath);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

describe('POST /api/settings/general', () => {
  it('returns { ok: true, restartRequired: true }', async () => {
    // Point the env path to a temp file to avoid touching the real .env.
    const tmpEnv = path.join(os.tmpdir(), `pm2-hawkeye-test-${Date.now()}.env`);
    fs.writeFileSync(tmpEnv, 'HOST=0.0.0.0\nPORT=3030\n', 'utf8');

    const { cookie, csrfToken } = await getAuthSession();

    // Temporarily override __dirname-relative env resolution by patching env.
    // The router resolves .env relative to __dirname/../.. = project root.
    // We write to the real .env path during the test and restore it.
    const realEnvPath = path.resolve(__dirname, '..', '.env');
    let originalEnv = null;
    try {
      originalEnv = fs.readFileSync(realEnvPath, 'utf8');
    } catch {
      // .env may not exist in CI.
    }

    // Write a minimal .env for the test.
    fs.writeFileSync(realEnvPath, 'HOST=0.0.0.0\nPORT=3030\n', 'utf8');

    try {
      // POST accepts raw env key names directly.
      const res = await request(app)
        .post('/api/settings/general')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ settings: { HOST: '127.0.0.1' } });

      expect(res.status).to.equal(200);
      expect(res.body.ok).to.equal(true);
      expect(res.body.restartRequired).to.equal(true);

      // Verify the .env was updated.
      const written = fs.readFileSync(realEnvPath, 'utf8');
      expect(written).to.include('HOST=127.0.0.1');
    } finally {
      // Restore original .env.
      if (originalEnv !== null) {
        fs.writeFileSync(realEnvPath, originalEnv, 'utf8');
      } else {
        try {
          fs.unlinkSync(realEnvPath);
        } catch {
          /* ignore */
        }
      }
    }
  });

  it('rejects values containing line breaks to prevent .env injection', async () => {
    const { cookie, csrfToken } = await getAuthSession();

    const realEnvPath = path.resolve(__dirname, '..', '.env');
    let originalEnv = null;
    try {
      originalEnv = fs.readFileSync(realEnvPath, 'utf8');
    } catch {
      // .env may not exist in CI.
    }
    fs.writeFileSync(realEnvPath, 'HOST=0.0.0.0\nPORT=3030\n', 'utf8');

    try {
      const res = await request(app)
        .post('/api/settings/general')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ settings: { HOST: '0.0.0.0\nAUTH_PASSWORD_HASH=deadbeef' } });

      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('line breaks');

      // The injected line must not have been written to disk.
      const written = fs.readFileSync(realEnvPath, 'utf8');
      expect(written).to.not.include('AUTH_PASSWORD_HASH=deadbeef');
    } finally {
      if (originalEnv !== null) {
        fs.writeFileSync(realEnvPath, originalEnv, 'utf8');
      } else {
        try {
          fs.unlinkSync(realEnvPath);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

// ── Notification prefs ────────────────────────────────────────────────────────

describe('POST /api/notification-prefs', () => {
  beforeEach(cleanDb);

  it('returns 403 without CSRF', async () => {
    const { cookie } = await getAuthSession();
    const res = await request(app)
      .post('/api/notification-prefs')
      .set('Cookie', cookie)
      .send({ pm2Name: 'my-app', alertsEnabled: false });
    expect(res.status).to.equal(403);
  });

  it('updates alerts_enabled on a monitored process and returns correct shape', async () => {
    addMonitored('pref-test-app');

    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/notification-prefs')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ pm2Name: 'pref-test-app', alertsEnabled: false });

    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(true);
    expect(res.body.pm2Name).to.equal('pref-test-app');
    expect(res.body.alertsEnabled).to.equal(false);
  });

  it('is a no-op (200) for a process not in monitored_processes', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/notification-prefs')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ pm2Name: 'not-monitored', alertsEnabled: false });

    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(true);
  });
});

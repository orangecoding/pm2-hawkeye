/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Integration tests for the four monitoring API routes.
 */

import { expect } from 'chai';
import request from 'supertest';
import app from '../lib/transport/server.js';
import { getDb } from '../lib/storage/db.js';
import { addMonitored } from '../lib/storage/monitoringStorage.js';
import { insertMetric } from '../lib/storage/metricsStorage.js';
import { insertLogEntry } from '../lib/storage/logStorage.js';

// ── Auth helper ──────────────────────────────────────────────────────────────

/** Log in and return { cookie, csrfToken }. */
async function getAuthSession() {
  const loginRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });

  const cookie = loginRes.headers['set-cookie'][0];

  const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);

  return { cookie, csrfToken: sessionRes.body.csrfToken };
}

// Helper to clean DB state between tests.
function cleanDb() {
  const db = getDb();
  db.prepare('DELETE FROM log_entries').run();
  db.prepare('DELETE FROM metrics_history').run();
  db.prepare('DELETE FROM monitored_processes').run();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Monitoring API', () => {
  let auth;

  before(async () => {
    auth = await getAuthSession();
  });

  beforeEach(cleanDb);

  // GET /api/processes/:id/monitoring ───────────────────────────────────────

  describe('GET /api/processes/:id/monitoring', () => {
    it('returns isMonitored: false for an unmonitored process name', async () => {
      const res = await request(app).get('/api/processes/some-app/monitoring').set('Cookie', auth.cookie);

      expect(res.status).to.equal(200);
      expect(res.body.isMonitored).to.equal(false);
      expect(res.body.isOrphan).to.equal(false);
    });

    it('returns isMonitored: true for a monitored process name', async () => {
      addMonitored('some-app');

      const res = await request(app).get('/api/processes/some-app/monitoring').set('Cookie', auth.cookie);

      expect(res.status).to.equal(200);
      expect(res.body.isMonitored).to.equal(true);
    });

    it('returns 401 without authentication', async () => {
      const res = await request(app).get('/api/processes/some-app/monitoring');
      expect(res.status).to.equal(401);
    });
  });

  // POST /api/monitoring ────────────────────────────────────────────────────

  describe('POST /api/monitoring', () => {
    it('enables monitoring when monitored=true', async () => {
      // Get a fresh CSRF token.
      const { cookie, csrfToken } = await getAuthSession();

      const res = await request(app)
        .post('/api/monitoring')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ pm2Name: 'some-app', monitored: true });

      expect(res.status).to.equal(200);
      expect(res.body.ok).to.equal(true);
      expect(res.body.isMonitored).to.equal(true);
    });

    it('disables monitoring when monitored=false', async () => {
      addMonitored('some-app');
      const { cookie, csrfToken } = await getAuthSession();

      const res = await request(app)
        .post('/api/monitoring')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ pm2Name: 'some-app', monitored: false });

      expect(res.status).to.equal(200);
      expect(res.body.ok).to.equal(true);
      expect(res.body.isMonitored).to.equal(false);
    });

    it('returns 400 when monitored is not a boolean', async () => {
      const { cookie, csrfToken } = await getAuthSession();

      const res = await request(app)
        .post('/api/monitoring')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ pm2Name: 'some-app', monitored: 'yes' });

      expect(res.status).to.equal(400);
    });

    it('returns 403 without CSRF token', async () => {
      const { cookie } = await getAuthSession();

      const res = await request(app)
        .post('/api/monitoring')
        .set('Cookie', cookie)
        .send({ pm2Name: 'some-app', monitored: true });

      expect(res.status).to.equal(403);
    });

    it('supports process names with spaces', async () => {
      const { cookie, csrfToken } = await getAuthSession();

      const res = await request(app)
        .post('/api/monitoring')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ pm2Name: 'Daily-Digest Aggregator', monitored: true });

      expect(res.status).to.equal(200);
      expect(res.body.ok).to.equal(true);
      expect(res.body.pm2Name).to.equal('Daily-Digest Aggregator');
    });
  });

  // GET /api/processes/:id/metrics ──────────────────────────────────────────

  describe('GET /api/processes/:id/metrics', () => {
    it('returns empty samples for an unmonitored process', async () => {
      const res = await request(app).get('/api/processes/some-app/metrics').set('Cookie', auth.cookie);

      expect(res.status).to.equal(200);
      expect(res.body.samples).to.deep.equal([]);
    });

    it('returns stored metric samples for a monitored process', async () => {
      const { id } = addMonitored('some-app');
      insertMetric(id, 10, 1024);
      insertMetric(id, 20, 2048);

      const res = await request(app).get('/api/processes/some-app/metrics').set('Cookie', auth.cookie);

      expect(res.status).to.equal(200);
      expect(res.body.samples).to.have.length(2);
      expect(res.body.samples[0].cpu).to.equal(10);
    });
  });

  // GET /api/processes/:id/logs/stored ──────────────────────────────────────

  describe('GET /api/processes/:id/logs/stored', () => {
    it('returns empty entries for an unmonitored process', async () => {
      const res = await request(app).get('/api/processes/some-app/logs/stored').set('Cookie', auth.cookie);

      expect(res.status).to.equal(200);
      expect(res.body.entries).to.deep.equal([]);
    });

    it('returns stored log entries for a monitored process', async () => {
      const { id } = addMonitored('some-app');
      insertLogEntry(id, {
        loggedAt: Date.now(),
        logLevel: 'info',
        log: JSON.stringify({ lines: ['hello'], raw: 'hello' }),
      });

      const res = await request(app).get('/api/processes/some-app/logs/stored').set('Cookie', auth.cookie);

      expect(res.status).to.equal(200);
      expect(res.body.entries).to.have.length(1);
      expect(res.body.entries[0].log_level).to.equal('info');
      expect(res.body.nextCursor).to.equal(null);
    });

    it('returns a cursor only when another stored-log page exists', async () => {
      const { id } = addMonitored('some-app');
      for (let index = 1; index <= 3; index += 1) {
        insertLogEntry(id, {
          loggedAt: index,
          logLevel: 'info',
          log: JSON.stringify({ lines: [`line ${index}`], raw: `line ${index}` }),
        });
      }

      const first = await request(app).get('/api/processes/some-app/logs/stored?limit=2').set('Cookie', auth.cookie);
      const second = await request(app)
        .get(
          `/api/processes/some-app/logs/stored?limit=2&before=${first.body.nextCursor.before}&beforeId=${first.body.nextCursor.beforeId}`,
        )
        .set('Cookie', auth.cookie);

      expect(first.body.entries).to.have.length(2);
      expect(first.body.nextCursor).to.deep.equal({ before: 2, beforeId: first.body.entries[1].id });
      expect(second.body.entries).to.have.length(1);
      expect(second.body.nextCursor).to.equal(null);
    });
  });
});

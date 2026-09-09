/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import request from 'supertest';
import app from '../lib/transport/server.js';
import config from '../lib/config.js';

// ── Auth helper ─────────────────────────────────────────────────────────────

/** Log in with the test credentials and return the session cookie + CSRF token. */
async function getAuthSession() {
  const loginRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });

  const cookie = loginRes.headers['set-cookie'][0];

  const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);

  return { cookie, csrfToken: sessionRes.body.csrfToken };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('API Integration Tests', () => {
  describe('GET /login', () => {
    it('should return the login page', async () => {
      const res = await request(app).get('/login');
      expect(res.status).to.equal(200);
      expect(res.text).to.contain('Sign in');
    });

    it('should redirect to / when already authenticated', async () => {
      const { cookie } = await getAuthSession();
      const res = await request(app).get('/login').set('Cookie', cookie);
      expect(res.status).to.equal(302);
      expect(res.headers.location).to.equal('/');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return 400 if credentials missing', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).to.equal(400);
    });

    it('should return 401 for wrong credentials', async () => {
      const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrongpassword' });
      expect(res.status).to.equal(401);
    });

    it('should return 200 and set cookie for correct credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: config.AUTH_USERNAME, password: 'admin' });

      expect(res.status).to.equal(200);
      expect(res.body.ok).to.be.true;
      expect(res.headers['set-cookie']).to.exist;
      expect(res.headers['set-cookie'][0]).to.contain(config.SESSION_COOKIE_NAME);
    });
  });

  describe('Protected Routes (unauthenticated)', () => {
    it('should redirect to /login for unauthenticated /', async () => {
      const res = await request(app).get('/');
      expect(res.status).to.equal(302);
      expect(res.headers.location).to.equal('/login');
    });

    it('should return 401 for unauthenticated /api/processes', async () => {
      const res = await request(app).get('/api/processes');
      expect(res.status).to.equal(401);
    });

    it('should return 401 for unauthenticated /api/auth/session', async () => {
      const res = await request(app).get('/api/auth/session');
      expect(res.status).to.equal(401);
    });
  });

  describe('GET /api/auth/session (authenticated)', () => {
    it('should return session info including csrfToken', async () => {
      const { cookie } = await getAuthSession();
      const res = await request(app).get('/api/auth/session').set('Cookie', cookie);
      expect(res.status).to.equal(200);
      expect(res.body.authenticated).to.be.true;
      expect(res.body.username).to.equal('admin');
      expect(res.body.csrfToken).to.be.a('string').with.length.greaterThan(0);
      expect(res.body.expiresAt).to.be.a('number');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return 403 when CSRF token is missing', async () => {
      const { cookie } = await getAuthSession();
      const res = await request(app).post('/api/auth/logout').set('Cookie', cookie).send({});
      expect(res.status).to.equal(403);
    });

    it('should return 200 and clear session with valid CSRF token', async () => {
      const { cookie, csrfToken } = await getAuthSession();
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({});
      expect(res.status).to.equal(200);
      expect(res.body.ok).to.be.true;
    });
  });

  describe('Process ID validation', () => {
    it('should return 400 for an ID containing invalid characters', async () => {
      const { cookie } = await getAuthSession();
      const res = await request(app).get('/api/processes/bad!!id').set('Cookie', cookie);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('Invalid');
    });
  });

  describe('GET /api/host-metrics', () => {
    it('should return 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/host-metrics');
      expect(res.status).to.equal(401);
    });

    it('should return samples array and current reading when authenticated', async () => {
      const { cookie } = await getAuthSession();
      const res = await request(app).get('/api/host-metrics').set('Cookie', cookie);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('samples').that.is.an('array');
      // `current` carries the latest used/total bytes; it is null until the
      // scheduler has produced a reading (as in this test environment).
      expect(res.body).to.have.property('current');
    });
  });

  describe('Login lockout (aggressive)', () => {
    // A distinct forwarded IP gives this client its own rate-limit identity, so
    // the long lockout it triggers does not bleed into later integration tests.
    const clientIp = '192.0.2.123';
    const wrong = { username: 'admin', password: 'definitely-wrong' };

    it('locks the client out after 3 failed attempts, rejecting even valid credentials', async () => {
      // First two failures: 401, no lockout yet.
      await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp)
        .set('User-Agent', 'rotated-agent-1')
        .send(wrong)
        .expect(401);
      await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp)
        .set('User-Agent', 'rotated-agent-2')
        .send(wrong)
        .expect(401);

      // Third failure: still 401, but now a lockout is applied (retryAfterSeconds set).
      const third = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp)
        .set('User-Agent', 'rotated-agent-3')
        .send(wrong);
      expect(third.status).to.equal(401);
      expect(third.body.retryAfterSeconds).to.be.a('number').that.is.greaterThan(0);

      // While locked, even the correct credentials are rejected with 429.
      const locked = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', clientIp)
        .set('User-Agent', 'rotated-agent-4')
        .send({ username: 'admin', password: 'admin' });
      expect(locked.status).to.equal(429);
    });
  });
  describe('Runtime log level', () => {
    it('should return 401 for GET when unauthenticated', async () => {
      const res = await request(app).get('/api/processes/1/log-level');
      expect(res.status).to.equal(401);
    });

    it('should return 401 for POST when unauthenticated', async () => {
      const res = await request(app).post('/api/processes/1/log-level').send({ level: 'debug' });
      expect(res.status).to.equal(401);
    });

    it('should return 403 for POST without a CSRF token', async () => {
      const { cookie } = await getAuthSession();
      const res = await request(app).post('/api/processes/1/log-level').set('Cookie', cookie).send({ level: 'debug' });
      expect(res.status).to.equal(403);
    });

    it('should return 400 for an unsupported level', async () => {
      const { cookie, csrfToken } = await getAuthSession();
      const res = await request(app)
        .post('/api/processes/1/log-level')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({ level: 'chatty' });
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('level');
    });

    it('should return 400 when the level is missing', async () => {
      const { cookie, csrfToken } = await getAuthSession();
      const res = await request(app)
        .post('/api/processes/1/log-level')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send({});
      expect(res.status).to.equal(400);
    });
  });
});

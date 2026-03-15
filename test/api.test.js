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
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'admin' });

  const cookie = loginRes.headers['set-cookie'][0];

  const sessionRes = await request(app)
    .get('/api/auth/session')
    .set('Cookie', cookie);

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
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrongpassword' });
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
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .send({});
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
      const res = await request(app)
        .get('/api/processes/bad!!id')
        .set('Cookie', cookie);
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('Invalid');
    });
  });
});

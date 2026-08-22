/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Integration tests for the deployment HTTP API.
 *
 * These tests cover the HTTP layer only.  The actual git/npm execution is
 * fire-and-forget and will fail silently in the test environment (no real
 * repo), which is fine because we only verify the route behaviour.
 */

import { expect } from 'chai';
import request from 'supertest';
import { getDb } from '../lib/storage/db.js';
import { setDeploying } from '../lib/storage/deploymentStorage.js';
import app from '../lib/transport/server.js';

function cleanDb() {
  getDb().prepare('DELETE FROM deployments').run();
}

/** Log in and return session cookie + CSRF token. */
async function getAuthSession() {
  const loginRes = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
  const cookie = loginRes.headers['set-cookie'][0];
  const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);
  return { cookie, csrfToken: sessionRes.body.csrfToken };
}

/** Minimum valid deployment payload. */
const validBody = {
  appName: 'test-deploy-app',
  repoUrl: 'https://github.com/owner/repo',
  branch: 'main',
  startScript: 'index.js',
  installCmd: 'npm install',
};

describe('Deployment API', () => {
  beforeEach(cleanDb);

  // ── Authentication ─────────────────────────────────────────────────────────

  it('GET /api/deployments returns 401 without auth', async () => {
    const res = await request(app).get('/api/deployments');
    expect(res.status).to.equal(401);
  });

  it('POST /api/deployments returns 401 without auth', async () => {
    const res = await request(app).post('/api/deployments').send(validBody);
    expect(res.status).to.equal(401);
  });

  // ── CSRF ───────────────────────────────────────────────────────────────────

  it('POST /api/deployments returns 403 without CSRF token', async () => {
    const { cookie } = await getAuthSession();
    const res = await request(app).post('/api/deployments').set('Cookie', cookie).send(validBody);
    expect(res.status).to.equal(403);
  });

  // ── Input validation ───────────────────────────────────────────────────────

  it('POST /api/deployments returns 400 for invalid appName', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...validBody, appName: '../etc/passwd' });
    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('app name');
  });

  it('POST /api/deployments returns 400 for invalid repoUrl', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...validBody, repoUrl: 'file:///etc/passwd' });
    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('repo URL');
  });

  // ── Successful create ──────────────────────────────────────────────────────

  it('POST /api/deployments returns 202 with a deploymentId', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send(validBody);
    expect(res.status).to.equal(202);
    expect(res.body.ok).to.equal(true);
    expect(res.body.deploymentId).to.match(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/deployments returns the created record', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send(validBody);

    const getRes = await request(app).get('/api/deployments').set('Cookie', cookie);
    expect(getRes.status).to.equal(200);
    expect(getRes.body.deployments).to.have.length(1);
    expect(getRes.body.deployments[0].pm2_name).to.equal('test-deploy-app');
  });

  it('POST /api/deployments returns 409 for a duplicate app name', async () => {
    const { cookie, csrfToken } = await getAuthSession();

    await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send(validBody);

    // Need a fresh CSRF token after first request.
    const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);
    const csrfToken2 = sessionRes.body.csrfToken;

    const res = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken2)
      .set('Content-Type', 'application/json')
      .send(validBody);

    expect(res.status).to.equal(409);
  });

  // ── Redeploy ───────────────────────────────────────────────────────────────

  it('POST /api/deployments/:id/redeploy returns 404 for unknown ID', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .post(`/api/deployments/${fakeId}/redeploy`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    expect(res.status).to.equal(404);
  });

  it('POST /api/deployments/:id/redeploy returns 400 for invalid ID format', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/deployments/not-a-uuid/redeploy')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    expect(res.status).to.equal(400);
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  it('DELETE /api/deployments/:id removes the record', async () => {
    const { cookie, csrfToken } = await getAuthSession();

    const createRes = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send(validBody);

    const { deploymentId } = createRes.body;

    const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);
    const csrfToken2 = sessionRes.body.csrfToken;

    const delRes = await request(app)
      .delete(`/api/deployments/${deploymentId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken2);

    expect(delRes.status).to.equal(200);
    expect(delRes.body.ok).to.equal(true);

    const getRes = await request(app).get('/api/deployments').set('Cookie', cookie);
    expect(getRes.body.deployments).to.have.length(0);
  });
  // ── Branch watching ────────────────────────────────────────────────────────

  it('POST /api/deployments stores the branch-watch fields', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send({ ...validBody, watchEnabled: true, watchIntervalMinutes: 15 });

    const getRes = await request(app).get('/api/deployments').set('Cookie', cookie);
    expect(getRes.body.deployments[0].watch_enabled).to.equal(1);
    expect(getRes.body.deployments[0].watch_interval_minutes).to.equal(15);
  });

  it('POST /api/deployments defaults branch watching to off', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send(validBody);

    const getRes = await request(app).get('/api/deployments').set('Cookie', cookie);
    expect(getRes.body.deployments[0].watch_enabled).to.equal(0);
    expect(getRes.body.deployments[0].watch_interval_minutes).to.equal(5);
  });

  it('POST /api/deployments returns 400 for a non-numeric watch interval', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send({ ...validBody, watchEnabled: true, watchIntervalMinutes: 'soon' });
    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('watch interval');
  });

  it('POST /api/deployments returns 400 for an out-of-range watch interval', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const res = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send({ ...validBody, watchEnabled: true, watchIntervalMinutes: 0 });
    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('watch interval');
  });

  it('PUT /api/deployments/:id updates the branch-watch fields', async () => {
    const { cookie, csrfToken } = await getAuthSession();
    const createRes = await request(app)
      .post('/api/deployments')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send(validBody);

    // The create above kicks off a fire-and-forget deploy, and edits are
    // rejected while one is in progress.
    setDeploying(createRes.body.deploymentId, false);

    const sessionRes = await request(app).get('/api/auth/session').set('Cookie', cookie);

    const putRes = await request(app)
      .put(`/api/deployments/${createRes.body.deploymentId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', sessionRes.body.csrfToken)
      .set('Content-Type', 'application/json')
      .send({ ...validBody, watchEnabled: true, watchIntervalMinutes: 30 });

    expect(putRes.status).to.equal(200);
    expect(putRes.body.deployment.watch_enabled).to.equal(1);
    expect(putRes.body.deployment.watch_interval_minutes).to.equal(30);
  });
});

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Integration tests for the MCP settings API used by the Settings page.
 */

import { expect } from 'chai';
import request from 'supertest';
import app from '../lib/transport/server.js';
import { getDb } from '../lib/storage/db.js';
import { getMcpSettings } from '../lib/storage/mcpSettingsStorage.js';
import { TOOLS } from '../lib/transport/mcpTools.js';

/** Remove every MCP setting between tests. */
function cleanDb() {
  getDb().prepare("DELETE FROM alerting_settings WHERE key LIKE 'mcp.%'").run();
}

/** Log in and return the session cookie. */
async function login() {
  const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
  return res.headers['set-cookie'][0];
}

/** Fetch a fresh CSRF token; each one is good for a single request. */
async function csrf(cookie) {
  const res = await request(app).get('/api/auth/session').set('Cookie', cookie);
  return res.body.csrfToken;
}

/** POST JSON with session and a fresh CSRF token. */
async function post(cookie, url, body = {}) {
  return request(app)
    .post(url)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', await csrf(cookie))
    .send(body);
}

describe('MCP settings API', () => {
  let cookie;

  before(async () => {
    cookie = await login();
  });
  beforeEach(cleanDb);
  after(cleanDb);

  it('requires a session', async () => {
    // Own client address: unauthenticated requests share a per-client rate limit with the other suites.
    const res = await request(app).get('/api/mcp/settings').set('X-Forwarded-For', '203.0.113.43');
    expect(res.status).to.equal(401);
  });

  it('starts off, without a key, with only the read tools on', async () => {
    const res = await request(app).get('/api/mcp/settings').set('Cookie', cookie);
    expect(res.status).to.equal(200);
    expect(res.body.enabled).to.equal(false);
    expect(res.body.key).to.equal(null);
    expect(res.body.tools).to.have.length(TOOLS.length);
    for (const tool of res.body.tools) {
      expect(tool.enabled, tool.name).to.equal(tool.access === 'read');
    }
  });

  it('rejects a change without a CSRF token', async () => {
    const res = await request(app).post('/api/mcp/settings').set('Cookie', cookie).send({ enabled: true });
    expect(res.status).to.equal(403);
  });

  it('creates a key when the server is turned on and keeps it when turned off and on again', async () => {
    const on = await post(cookie, '/api/mcp/settings', { enabled: true });
    expect(on.status).to.equal(200);
    expect(on.body.enabled).to.equal(true);
    expect(on.body.key).to.match(/^hk_[\w-]{43}$/);

    await post(cookie, '/api/mcp/settings', { enabled: false });
    const again = await post(cookie, '/api/mcp/settings', { enabled: true });
    expect(again.body.key).to.equal(on.body.key);
  });

  it('stores only tools that differ from their default', async () => {
    const res = await post(cookie, '/api/mcp/settings', { tools: { restart_process: true, get_logs: false } });
    expect(res.status).to.equal(200);
    const restart = res.body.tools.find((tool) => tool.name === 'restart_process');
    expect(restart.enabled).to.equal(true);
    expect(getMcpSettings().toolOverrides).to.deep.equal({ restart_process: true, get_logs: false });

    await post(cookie, '/api/mcp/settings', { tools: { restart_process: false, get_logs: true } });
    expect(getMcpSettings().toolOverrides).to.deep.equal({});
  });

  it('rejects unknown tools and non-boolean values', async () => {
    const unknown = await post(cookie, '/api/mcp/settings', { tools: { drop_database: true } });
    expect(unknown.status).to.equal(400);
    expect(unknown.body.error).to.contain('drop_database');

    const notBoolean = await post(cookie, '/api/mcp/settings', { enabled: 'yes' });
    expect(notBoolean.status).to.equal(400);

    const badTool = await post(cookie, '/api/mcp/settings', { tools: { get_logs: 'on' } });
    expect(badTool.status).to.equal(400);
  });

  it('rotates the key', async () => {
    const on = await post(cookie, '/api/mcp/settings', { enabled: true });
    const rotated = await post(cookie, '/api/mcp/key/rotate');
    expect(rotated.status).to.equal(200);
    expect(rotated.body.key).to.match(/^hk_/);
    expect(rotated.body.key).to.not.equal(on.body.key);
  });

  it('keeps the MCP keys out of the alerting settings, so saving those still works', async () => {
    await post(cookie, '/api/mcp/settings', { enabled: true, tools: { redeploy: true } });
    const alerting = await request(app).get('/api/alerting/settings').set('Cookie', cookie);
    expect(Object.keys(alerting.body.settings).filter((key) => key.startsWith('mcp.'))).to.deep.equal([]);

    const save = await post(cookie, '/api/alerting/settings', { settings: alerting.body.settings });
    expect(save.status).to.equal(200);
  });
});

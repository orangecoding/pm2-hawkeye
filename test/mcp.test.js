/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Integration tests for the MCP endpoint: access control, tool filtering and
 * tools that only read the database. Tools that talk to PM2 are left out, a
 * test must never start a PM2 daemon.
 */

import { expect } from 'chai';
import request from 'supertest';
import app from '../lib/transport/server.js';
import { getDb } from '../lib/storage/db.js';
import { getMcpSettings, setMcpEnabled, setToolOverrides, rotateMcpKey } from '../lib/storage/mcpSettingsStorage.js';
import { createDeployment } from '../lib/storage/deploymentStorage.js';
import { TOOLS } from '../lib/transport/mcpTools.js';
import logger from '../lib/service/logger.js';

const READ_TOOLS = TOOLS.filter((tool) => tool.access === 'read').map((tool) => tool.name);

/**
 * Client address of these tests. Requests without a valid key count against
 * the per-client window of unauthenticated requests; a separate address keeps
 * them from rate-limiting the other suites.
 */
const CLIENT_IP = '203.0.113.42';

/** Remove every MCP setting and deployment between tests. */
function cleanDb() {
  const db = getDb();
  db.prepare("DELETE FROM alerting_settings WHERE key LIKE 'mcp.%'").run();
  db.prepare('DELETE FROM deployments').run();
}

/** Turn the server on and return its key. */
function enableServer() {
  setMcpEnabled(true);
  return getMcpSettings().key;
}

/**
 * Send one JSON-RPC request to the MCP endpoint.
 *
 * @param {string | null} key - Bearer key, or null for none.
 * @param {string} method
 * @param {object} [params]
 */
function rpc(key, method, params = {}) {
  const req = request(app)
    .post('/mcp')
    .set('X-Forwarded-For', CLIENT_IP)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (key) req.set('Authorization', `Bearer ${key}`);
  return req.send({ jsonrpc: '2.0', id: 1, method, params });
}

/**
 * Run a request and collect what it logs at error level.
 *
 * @param {() => Promise<object>} send
 * @returns {Promise<{ res: object, errors: string[] }>}
 */
async function withErrorLog(send) {
  const errors = [];
  const original = logger.error;
  logger.error = (...args) => errors.push(args.join(' '));
  try {
    return { res: await send(), errors };
  } finally {
    logger.error = original;
  }
}

/** Call a tool and return its parsed JSON result. */
async function callTool(key, name, args = {}) {
  const res = await rpc(key, 'tools/call', { name, arguments: args });
  expect(res.status).to.equal(200);
  return res.body.result;
}

describe('MCP endpoint', () => {
  beforeEach(cleanDb);
  after(cleanDb);

  describe('access', () => {
    it('answers 404 while the server is off, even with a key', async () => {
      const key = enableServer();
      setMcpEnabled(false);
      const res = await rpc(key, 'tools/list');
      expect(res.status).to.equal(404);
    });

    it('answers 401 without a key and logs it as an error with the client', async () => {
      enableServer();
      const { res, errors } = await withErrorLog(() => rpc(null, 'tools/list'));
      expect(res.status).to.equal(401);
      expect(res.headers['www-authenticate']).to.contain('Bearer');
      expect(res.body.error).to.contain('MCP key missing');
      expect(errors).to.have.length(1);
      expect(errors[0]).to.contain('[MCP] Rejected POST /mcp without a key');
      expect(errors[0]).to.contain(CLIENT_IP);
    });

    it('answers 401 with a wrong key and logs it without the key', async () => {
      enableServer();
      const { res, errors } = await withErrorLog(() => rpc('hk_wrong-guess', 'tools/list'));
      expect(res.status).to.equal(401);
      expect(res.body.error).to.contain('Invalid MCP key');
      expect(errors).to.have.length(1);
      expect(errors[0]).to.contain('with an invalid key');
      expect(errors[0]).to.not.contain('hk_wrong-guess');
    });

    it('answers 401 to an Authorization header that is not a bearer key', async () => {
      enableServer();
      const { res, errors } = await withErrorLog(() =>
        request(app)
          .post('/mcp')
          .set('X-Forwarded-For', CLIENT_IP)
          .set('Authorization', 'Basic YWRtaW46YWRtaW4=')
          .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      );
      expect(res.status).to.equal(401);
      expect(res.body.error).to.contain('Malformed Authorization header');
      expect(errors[0]).to.contain('with a malformed Authorization header');
      expect(errors[0]).to.not.contain('YWRtaW46YWRtaW4=');
    });

    it('logs nothing for a valid key or while the server is off', async () => {
      const key = enableServer();
      const valid = await withErrorLog(() => rpc(key, 'tools/list'));
      expect(valid.res.status).to.equal(200);
      setMcpEnabled(false);
      const off = await withErrorLog(() => rpc(null, 'tools/list'));
      expect(off.res.status).to.equal(404);
      expect([...valid.errors, ...off.errors]).to.deep.equal([]);
    });

    it('refuses the old key after a rotation and accepts the new one', async () => {
      const oldKey = enableServer();
      const newKey = rotateMcpKey();
      expect(newKey).to.not.equal(oldKey);
      expect((await rpc(oldKey, 'tools/list')).status).to.equal(401);
      expect((await rpc(newKey, 'tools/list')).status).to.equal(200);
    });

    it('answers GET with 405, since the stateless server has no stream', async () => {
      const key = enableServer();
      const res = await request(app)
        .get('/mcp')
        .set('X-Forwarded-For', CLIENT_IP)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).to.equal(405);
      expect(res.headers.allow).to.equal('POST');
    });
  });

  describe('protocol', () => {
    it('initializes with the server name and instructions', async () => {
      const key = enableServer();
      const res = await rpc(key, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      });
      expect(res.status).to.equal(200);
      expect(res.body.result.serverInfo.name).to.equal('pm2-hawkeye');
      expect(res.body.result.instructions).to.contain('get_deployment_status');
    });

    it('lists only the read tools by default', async () => {
      const key = enableServer();
      const res = await rpc(key, 'tools/list');
      const names = res.body.result.tools.map((tool) => tool.name);
      expect(names).to.have.members(READ_TOOLS);
      const listProcesses = res.body.result.tools.find((tool) => tool.name === 'list_processes');
      expect(listProcesses.annotations.readOnlyHint).to.equal(true);
    });

    it('lists a write tool once it is turned on and hides a read tool turned off', async () => {
      const key = enableServer();
      setToolOverrides({ restart_process: true, get_logs: false });
      const res = await rpc(key, 'tools/list');
      const tools = res.body.result.tools;
      const names = tools.map((tool) => tool.name);
      expect(names).to.include('restart_process');
      expect(names).to.not.include('get_logs');
      const restart = tools.find((tool) => tool.name === 'restart_process');
      expect(restart.annotations.readOnlyHint).to.equal(false);
      expect(restart.annotations.destructiveHint).to.equal(false);
    });

    it('refuses to call a tool that is off', async () => {
      const key = enableServer();
      const res = await rpc(key, 'tools/call', { name: 'delete_deployment', arguments: { deployment: 'x' } });
      expect(res.status).to.equal(200);
      const failed = res.body.error !== undefined || res.body.result?.isError === true;
      expect(failed).to.equal(true);
    });
  });

  describe('tools', () => {
    it('list_deployments returns env var names but never their values', async () => {
      const key = enableServer();
      createDeployment({
        pm2Name: 'secret-app',
        repoUrl: 'https://github.com/example/secret-app.git',
        branch: 'main',
        deployPath: '/tmp/secret-app',
        startScript: 'index.js',
        installCmd: 'npm install',
        envVars: { API_TOKEN: 'super-secret-value' },
        pm2Options: {},
      });
      const result = await callTool(key, 'list_deployments');
      const text = result.content[0].text;
      expect(text).to.not.contain('super-secret-value');
      const { deployments } = JSON.parse(text);
      expect(deployments).to.have.length(1);
      expect(deployments[0].env_var_names).to.deep.equal(['API_TOKEN']);
      expect(deployments[0]).to.not.have.property('env_vars');
    });

    it('get_deployment_status finds a deployment by app name', async () => {
      const key = enableServer();
      createDeployment({
        pm2Name: 'status-app',
        repoUrl: 'https://github.com/example/status-app.git',
        branch: 'main',
        deployPath: '/tmp/status-app',
        startScript: 'index.js',
        installCmd: 'npm install',
        envVars: {},
        pm2Options: {},
      });
      const result = await callTool(key, 'get_deployment_status', { deployment: 'status-app' });
      const status = JSON.parse(result.content[0].text);
      expect(status.appName).to.equal('status-app');
      expect(status.run).to.equal(null);
    });

    it('reports an unknown deployment as a failed call', async () => {
      const key = enableServer();
      const result = await callTool(key, 'get_deployment_status', { deployment: 'nope' });
      expect(result.isError).to.equal(true);
      expect(result.content[0].text).to.contain('Deployment not found');
    });

    it('update_deployment merges env vars and keeps the values it does not touch', async () => {
      const key = enableServer();
      setToolOverrides({ update_deployment: true });
      createDeployment({
        pm2Name: 'merge-app',
        repoUrl: 'https://github.com/example/merge-app.git',
        branch: 'main',
        deployPath: '/tmp/merge-app',
        startScript: 'server.js',
        installCmd: 'npm ci',
        envVars: { KEEP: 'kept', DROP: 'gone', CHANGE: 'old' },
        pm2Options: {},
      });
      const result = await callTool(key, 'update_deployment', {
        deployment: 'merge-app',
        branch: 'develop',
        envVars: { CHANGE: 'new', ADD: 'added' },
        removeEnvVars: ['DROP'],
      });
      expect(result.isError).to.not.equal(true);
      const row = getDb().prepare('SELECT * FROM deployments WHERE pm2_name = ?').get('merge-app');
      expect(row.branch).to.equal('develop');
      expect(row.start_script).to.equal('server.js');
      expect(row.install_cmd).to.equal('npm ci');
      expect(JSON.parse(row.env_vars)).to.deep.equal({ KEEP: 'kept', CHANGE: 'new', ADD: 'added' });
    });

    it('get_host_metrics returns the current reading and the history', async () => {
      const key = enableServer();
      const result = await callTool(key, 'get_host_metrics');
      const body = JSON.parse(result.content[0].text);
      expect(body).to.have.property('current');
      expect(body.samples).to.be.an('array');
    });
  });
});

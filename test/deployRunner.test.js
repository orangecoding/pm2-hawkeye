/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Unit tests for deployRunner security validators.
 *
 * These tests cover input validation only - no process spawning or PM2
 * interaction occurs.
 */

import { strict as assert } from 'node:assert';
import {
  activateDeployment,
  validateAppName,
  validateRepoUrl,
  resolveDeployPath,
  parseEnvFile,
} from '../lib/service/deployRunner.js';
import path from 'node:path';
import config from '../lib/config.js';

describe('deployRunner validators', () => {
  describe('activateDeployment', () => {
    const deployment = {
      pm2_name: 'my-app',
      start_script: 'index.js',
      deploy_path: '/srv/my-app',
      pm2_options: {},
      env_vars: {},
    };

    it('preflights the start script before asking PM2 to activate the deployment', async () => {
      let starts = 0;

      await assert.rejects(
        activateDeployment(deployment, {
          stat: async () => {
            const error = new Error('missing');
            error.code = 'ENOENT';
            throw error;
          },
          startProcess: async () => {
            starts += 1;
          },
        }),
        /Start script not found/,
      );

      assert.equal(starts, 0);
    });

    it('updates an existing PM2 application without deleting it first', async () => {
      let receivedOptions;
      let listCalls = 0;

      await activateDeployment(deployment, {
        stat: async () => ({ isFile: () => true }),
        startProcess: async (options) => {
          receivedOptions = options;
        },
        loadProcessList: async () => {
          listCalls += 1;
          return [
            {
              name: 'my-app',
              pid: listCalls,
              pm_id: 0,
              pm2_env: {
                status: 'online',
                pm_exec_path: '/srv/my-app/index.js',
                pm_cwd: '/srv/my-app',
                pm_uptime: listCalls,
                restart_time: listCalls - 1,
                args: [],
                node_args: [],
              },
            },
          ];
        },
      });

      assert.equal(receivedOptions.name, 'my-app');
      assert.equal(receivedOptions.script, 'index.js');
      assert.deepEqual(receivedOptions.args, []);
      assert.equal(receivedOptions.cron_restart, null);
    });

    it('rejects when PM2 resolves the start but keeps the old process configuration', async () => {
      await assert.rejects(
        activateDeployment(deployment, {
          stat: async () => ({ isFile: () => true }),
          startProcess: async () => {},
          loadProcessList: async () => [
            {
              name: 'my-app',
              pid: 1,
              pm_id: 0,
              pm2_env: {
                status: 'online',
                pm_exec_path: '/srv/my-app/old.js',
                pm_cwd: '/srv/my-app',
                pm_uptime: 1,
                restart_time: 0,
              },
            },
          ],
        }),
        /did not apply the requested start script/,
      );
    });

    it('rejects when the activated PM2 process is not online', async () => {
      await assert.rejects(
        activateDeployment(deployment, {
          stat: async () => ({ isFile: () => true }),
          startProcess: async () => {},
          loadProcessList: async () => [
            {
              name: 'my-app',
              pid: 2,
              pm_id: 0,
              pm2_env: {
                status: 'errored',
                pm_exec_path: '/srv/my-app/index.js',
                pm_cwd: '/srv/my-app',
                pm_uptime: 2,
                restart_time: 1,
              },
            },
          ],
        }),
        /status is "errored"/,
      );
    });

    it('rejects when PM2 swallows the restart error and leaves the old process unchanged', async () => {
      const unchanged = {
        name: 'my-app',
        pid: 10,
        pm_id: 0,
        pm2_env: {
          status: 'online',
          pm_exec_path: '/srv/my-app/index.js',
          pm_cwd: '/srv/my-app',
          pm_uptime: 100,
          restart_time: 3,
          args: [],
          node_args: [],
        },
      };

      await assert.rejects(
        activateDeployment(deployment, {
          stat: async () => ({ isFile: () => true }),
          startProcess: async () => {},
          loadProcessList: async () => [unchanged],
        }),
        /did not restart/,
      );
    });

    it('rejects when PM2 retains an option that the deployment removed', async () => {
      let listCalls = 0;
      await assert.rejects(
        activateDeployment(deployment, {
          stat: async () => ({ isFile: () => true }),
          startProcess: async () => {},
          loadProcessList: async () => {
            listCalls += 1;
            return [
              {
                name: 'my-app',
                pid: listCalls,
                pm_id: 0,
                pm2_env: {
                  status: 'online',
                  pm_exec_path: '/srv/my-app/index.js',
                  pm_cwd: '/srv/my-app',
                  pm_uptime: listCalls,
                  restart_time: listCalls,
                  args: ['--old-option'],
                  node_args: [],
                },
              },
            ];
          },
        }),
        /did not clear args/,
      );
    });

    it('rejects unsupported PM2 option removals before restarting the process', async () => {
      let starts = 0;
      await assert.rejects(
        activateDeployment(deployment, {
          stat: async () => ({ isFile: () => true }),
          startProcess: async () => {
            starts += 1;
          },
          loadProcessList: async () => [
            {
              name: 'my-app',
              pid: 1,
              pm_id: 0,
              pm2_env: {
                status: 'online',
                pm_exec_path: '/srv/my-app/index.js',
                pm_cwd: '/srv/my-app',
                max_memory_restart: 1024,
              },
            },
          ],
        }),
        /cannot safely remove memory restart limit/,
      );
      assert.equal(starts, 0);
    });
  });

  describe('validateAppName', () => {
    it('accepts simple alphanumeric names', () => {
      assert.equal(validateAppName('myapp'), true);
      assert.equal(validateAppName('my-app'), true);
      assert.equal(validateAppName('my_app'), true);
      assert.equal(validateAppName('MyApp123'), true);
    });

    it('rejects names with path traversal sequences', () => {
      assert.equal(validateAppName('../etc'), false);
      assert.equal(validateAppName('../../root'), false);
    });

    it('rejects names with spaces', () => {
      assert.equal(validateAppName('my app'), false);
    });

    it('rejects names with slashes', () => {
      assert.equal(validateAppName('a/b'), false);
    });

    it('rejects names starting with a dash or underscore', () => {
      assert.equal(validateAppName('-myapp'), false);
      assert.equal(validateAppName('_myapp'), false);
    });

    it('rejects empty string', () => {
      assert.equal(validateAppName(''), false);
    });

    it('rejects names longer than 64 characters', () => {
      assert.equal(validateAppName('a'.repeat(65)), false);
    });

    it('accepts a 64-character name', () => {
      assert.equal(validateAppName('a' + 'b'.repeat(63)), true);
    });

    it('rejects non-strings', () => {
      assert.equal(validateAppName(null), false);
      assert.equal(validateAppName(undefined), false);
      assert.equal(validateAppName(42), false);
    });
  });

  describe('validateRepoUrl', () => {
    it('accepts HTTPS GitHub URLs', () => {
      assert.equal(validateRepoUrl('https://github.com/owner/repo'), true);
      assert.equal(validateRepoUrl('https://github.com/owner/repo.git'), true);
    });

    it('accepts HTTPS GitLab URLs', () => {
      assert.equal(validateRepoUrl('https://gitlab.com/owner/repo'), true);
    });

    it('rejects file:// URLs', () => {
      assert.equal(validateRepoUrl('file:///etc/passwd'), false);
    });

    it('rejects http:// URLs', () => {
      assert.equal(validateRepoUrl('http://github.com/owner/repo'), false);
    });

    it('rejects arbitrary HTTPS hosts', () => {
      assert.equal(validateRepoUrl('https://evil.com/owner/repo'), false);
    });

    it('accepts SCP-style SSH URLs', () => {
      assert.equal(validateRepoUrl('git@github.com:owner/repo.git'), true);
      assert.equal(validateRepoUrl('git@gitlab.com:group/repo.git'), true);
      assert.equal(validateRepoUrl('git@example.com:owner/repo'), true);
    });

    it('accepts ssh:// URLs', () => {
      assert.equal(validateRepoUrl('ssh://git@github.com/owner/repo.git'), true);
      assert.equal(validateRepoUrl('ssh://git@gitlab.com/owner/repo.git'), true);
    });

    it('rejects non-strings', () => {
      assert.equal(validateRepoUrl(null), false);
      assert.equal(validateRepoUrl(42), false);
    });
  });

  describe('resolveDeployPath', () => {
    it('returns a path inside DEPLOY_BASE_DIR for a valid name', () => {
      const resolved = resolveDeployPath('my-app');
      assert.ok(resolved.startsWith(config.DEPLOY_BASE_DIR + path.sep), 'should be inside base dir');
      assert.ok(resolved.endsWith('my-app'));
    });

    it('throws for a traversal attempt via encoded dots', () => {
      // After validateAppName rejects the name the router would never call this,
      // but we verify the second line of defence anyway.
      assert.throws(() => resolveDeployPath('..'), /escapes base directory/);
    });
  });

  describe('parseEnvFile', () => {
    it('returns empty object when relPath is empty', () => {
      assert.deepEqual(parseEnvFile('/any/path', ''), {});
    });

    it('returns empty object when the file does not exist', () => {
      assert.deepEqual(parseEnvFile('/no/such/dir', '.env'), {});
    });

    it('parses KEY=value lines', (done) => {
      // Write a temporary env file and parse it.
      import('node:fs')
        .then(({ promises: fsp }) =>
          import('node:os').then(async (osModule) => {
            const dir = await fsp.mkdtemp(osModule.default.tmpdir() + path.sep + 'hawkeye-test-');
            const envPath = path.join(dir, '.env');
            await fsp.writeFile(envPath, 'NODE_ENV=production\nPORT=3000\n# comment\n\nEMPTY=\n');
            const result = parseEnvFile(dir, '.env');
            assert.equal(result.NODE_ENV, 'production');
            assert.equal(result.PORT, '3000');
            assert.equal(result.EMPTY, '');
            assert.ok(!('comment' in result));
            await fsp.rm(dir, { recursive: true });
            done();
          }),
        )
        .catch(done);
    });

    it('accepts an absolute path outside the deploy directory', (done) => {
      import('node:fs')
        .then(({ promises: fsp }) =>
          import('node:os').then(async (osModule) => {
            const dir = await fsp.mkdtemp(osModule.default.tmpdir() + path.sep + 'hawkeye-test-');
            const absEnvPath = path.join(dir, 'secrets.env');
            await fsp.writeFile(absEnvPath, 'SECRET=abc123\n');
            // Pass the absolute path directly - deploy_path points somewhere else.
            const result = parseEnvFile('/some/other/deploy/path', absEnvPath);
            assert.equal(result.SECRET, 'abc123');
            await fsp.rm(dir, { recursive: true });
            done();
          }),
        )
        .catch(done);
    });
  });
});

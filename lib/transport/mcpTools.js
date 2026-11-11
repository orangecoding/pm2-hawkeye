/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Tool registry of the MCP server.
 *
 * Every tool an agent can call is one entry in `TOOLS`. Its `access` decides
 * the default state (read tools are on, write and destructive tools are off
 * until the user turns them on in Settings) and the MCP annotations. Handlers
 * call the same service functions as the HTTP routes, return plain data and
 * throw an Error with a readable message for anything the agent should see as
 * a failed call.
 */

import { z } from 'zod';
import * as pm2 from '../service/pm2Service.js';
import * as logLevel from '../service/logLevelService.js';
import { detectLogLevel } from '../service/logLevel.js';
import { getDeployRun } from '../service/deployRunner.js';
import { getLastHostReading } from '../service/hostMetricsCollector.js';
import {
  resolvePm2Name,
  removeProcess,
  setMonitoring,
  getMetricsHistory,
  getStoredLogPage,
  MAX_LOG_PAGE_SIZE,
} from '../service/processOperations.js';
import {
  startDeployment,
  editDeployment,
  startRedeploy,
  confirmDeployment,
  removeDeployment,
  deploymentToFields,
} from '../service/deploymentOperations.js';
import { getAllDeployments, getDeploymentById, getDeploymentByName } from '../storage/deploymentStorage.js';
import { getByPm2Name } from '../storage/monitoringStorage.js';
import { getHostMetricsWindow } from '../storage/hostMetricsStorage.js';
import { buildProcessList } from './ws.js';

/**
 * @typedef {'read' | 'write' | 'destructive'} ToolAccess
 */

/**
 * @typedef {Object} ToolContext
 * @property {{ name: string, identity: string }} actor - Who calls, for the audit log.
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} title
 * @property {string} description - What the agent reads to decide when to call it.
 * @property {string} summary - One line for the Settings page.
 * @property {ToolAccess} access
 * @property {boolean} [runsCode] - Runs code from a repository or setup script on the server.
 * @property {Record<string, import('zod').ZodType>} inputSchema - Zod raw shape.
 * @property {(args: object, ctx: ToolContext) => Promise<object>} run
 */

/** Same rule as the `:id` parameter of the HTTP API: a pm_id or a PM2 name. */
const processRef = z
  .string()
  .regex(/^[\w .@:+-]{1,128}$/, 'Use a pm_id or a PM2 process name.')
  .describe('PM2 process: its numeric pm_id or its name.');

const deploymentRef = z.string().min(1).max(128).describe('Deployment id (UUID) or app name.');

const STORED_LEVELS = ['error', 'warn', 'info', 'debug'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Editable deployment fields, shared by create and update. */
const deploymentFieldShape = {
  repoUrl: z.string().describe('HTTPS GitHub/GitLab URL or SSH git URL.'),
  branch: z.string().describe('Branch to deploy. Default master.'),
  startScript: z.string().describe('Script PM2 starts, relative to the repository. Default index.js.'),
  installCmd: z.string().describe('Install command, or "skip". Default npm install.'),
  buildCmd: z.string().describe('Build command, empty for none.'),
  preSetupScript: z.string().describe('Shell script run in the deploy base directory before the clone.'),
  postSetupScript: z.string().describe('Shell script run in the app directory after the build.'),
  envVars: z.record(z.string(), z.string()).describe('Environment variables of the app.'),
  pm2Options: z.record(z.string(), z.unknown()).describe('PM2 options such as instances or max_memory_restart.'),
  watchEnabled: z.boolean().describe('Redeploy automatically when the branch gets new commits.'),
  watchIntervalMinutes: z.number().int().min(1).max(1440).describe('Minutes between branch checks.'),
  discardLocalChanges: z
    .boolean()
    .describe('Discard tracked local changes in the deploy directory on every redeploy without asking.'),
};

/**
 * Throw the error of a failed operation result, return the result otherwise.
 *
 * @template T
 * @param {T} result - Result of a processOperations or deploymentOperations call.
 * @returns {T}
 */
function unwrap(result) {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

/**
 * Text of a stored log entry. An entry is one log event (a stack trace keeps
 * its continuation lines), stored as JSON `{ lines, raw }`; older rows may be
 * plain text.
 *
 * @param {string} log - The `log` column of a stored entry.
 * @returns {string}
 */
export function storedLogText(log) {
  try {
    const parsed = JSON.parse(log);
    if (Array.isArray(parsed?.lines)) {
      return parsed.lines.join('\n');
    }
  } catch {
    // Plain text row.
  }
  return log;
}

/**
 * Find a running PM2 process or fail the call.
 *
 * @param {string} ref - pm_id or name.
 * @returns {Promise<object>} Raw PM2 descriptor.
 */
async function requireProcess(ref) {
  const proc = await pm2.findProcess(ref);
  if (!proc) {
    throw new Error(`Process not found: ${ref}`);
  }
  return proc;
}

/**
 * Find a deployment by id or app name or fail the call.
 *
 * @param {string} ref - Deployment id or app name.
 * @returns {object} Deployment record.
 */
function requireDeployment(ref) {
  const deployment = UUID_PATTERN.test(ref) ? getDeploymentById(ref) : getDeploymentByName(ref);
  if (!deployment) {
    throw new Error(`Deployment not found: ${ref}`);
  }
  return deployment;
}

/**
 * Describe a deployment for an agent. Environment variable values are left
 * out, so secrets of the deployed apps never end up in the agent's context;
 * only their names are listed.
 *
 * @param {object} record - Deployment record.
 * @returns {object}
 */
function describeDeployment(record) {
  const { env_vars: envVars, ...rest } = record;
  const run = getDeployRun(record.id);
  return {
    ...rest,
    deploying: Boolean(record.deploying),
    env_var_names: Object.keys(envVars ?? {}),
    last_run: run
      ? { status: run.status, stage: run.stage, startedAt: run.startedAt, finishedAt: run.finishedAt }
      : null,
  };
}

/**
 * Run a PM2 lifecycle command on a process and answer with its fresh
 * details. The call itself is audited by the MCP transport.
 *
 * @param {(pmId: number) => Promise<void>} command - pm2Service function.
 * @returns {ToolDefinition['run']}
 */
function lifecycle(command) {
  return async ({ process }) => {
    const proc = await requireProcess(process);
    await command(proc.pm_id);
    return { ok: true, details: await pm2.loadProcessDetails(proc.pm_id) };
  };
}

/** @type {ToolDefinition[]} */
export const TOOLS = [
  // Read ──────────────────────────────────────────────────────────────────
  {
    name: 'list_processes',
    title: 'List processes',
    access: 'read',
    summary: 'Every PM2 process with status, CPU, memory, uptime and restarts.',
    description:
      'List every PM2 process with status, CPU (percent), memory (bytes), uptime (epoch ms of the start), restarts and whether Hawkeye monitors it (stores its logs and metrics). Also returns the current host CPU, RAM and disk usage.',
    inputSchema: {},
    run: async () => {
      const list = await buildProcessList();
      return { processes: list.items, host: list.hostCurrent };
    },
  },
  {
    name: 'get_process',
    title: 'Get process details',
    access: 'read',
    summary: 'Details and live application metrics of one process.',
    description:
      'Details of one PM2 process: status, CPU, memory, uptime, restarts, interpreter, paths, and the latest value of every application metric it reports (heap, event loop, custom tx2 metrics).',
    inputSchema: { process: processRef },
    run: async ({ process }) => {
      const proc = await requireProcess(process);
      const details = await pm2.loadProcessDetails(proc.pm_id);
      return { ...details, isMonitored: Boolean(getByPm2Name(proc.name)) };
    },
  },
  {
    name: 'get_logs',
    title: 'Read logs',
    access: 'read',
    summary: 'Recent log lines, filterable by level. Stored history for monitored processes.',
    description: `Recent log lines of a process, newest first. For a monitored process the lines come from Hawkeye's database and can be paged back with nextCursor (pass its before and beforeId). For any other process they are the tail of its PM2 log files. level keeps only lines with that detected level. At most ${MAX_LOG_PAGE_SIZE} lines per call.`,
    inputSchema: {
      process: processRef,
      limit: z.number().int().min(1).max(MAX_LOG_PAGE_SIZE).optional().describe('Lines to return. Default 100.'),
      level: z.array(z.enum(STORED_LEVELS)).optional().describe('Only lines with one of these levels.'),
      before: z.number().int().positive().optional().describe('Cursor: logged_at of the oldest line seen.'),
      beforeId: z.number().int().positive().optional().describe('Cursor: id of the oldest line seen.'),
    },
    run: async ({ process, limit = 100, level, before, beforeId }) => {
      const pm2Name = await resolvePm2Name(process);
      if (getByPm2Name(pm2Name)) {
        const page = await getStoredLogPage(pm2Name, { limit, before, beforeId, levels: level });
        return {
          pm2Name,
          source: 'stored',
          entries: page.entries.map((e) => ({
            id: e.id,
            time: new Date(e.logged_at).toISOString(),
            logged_at: e.logged_at,
            level: e.log_level,
            text: storedLogText(e.log),
          })),
          nextCursor: page.nextCursor,
        };
      }

      await requireProcess(process);
      const lines = (await pm2.readLogLinesByName(pm2Name))
        .map((line) => ({ text: line.text, level: detectLogLevel(line.text) }))
        .filter((line) => !level?.length || level.includes(line.level));
      return { pm2Name, source: 'log-files', entries: lines.slice(-limit).reverse(), nextCursor: null };
    },
  },
  {
    name: 'get_metrics',
    title: 'Read metric history',
    access: 'read',
    summary: 'CPU, memory and application metric history of a monitored process.',
    description:
      'Stored history of a monitored process: CPU and memory samples plus one series per application metric. Empty for a process Hawkeye does not monitor (see set_monitoring).',
    inputSchema: { process: processRef },
    run: async ({ process }) => {
      const history = await getMetricsHistory(process);
      return { ...history, isMonitored: Boolean(getByPm2Name(history.pm2Name)) };
    },
  },
  {
    name: 'get_host_metrics',
    title: 'Read host metrics',
    access: 'read',
    summary: 'Host CPU, RAM and disk, current and history.',
    description:
      'Host CPU, RAM and disk usage: the current reading with absolute bytes, and the stored history in percent, oldest first.',
    inputSchema: {},
    run: async () => ({ current: getLastHostReading(), samples: getHostMetricsWindow() }),
  },
  {
    name: 'list_deployments',
    title: 'List deployments',
    access: 'read',
    summary: 'Deployments with repo, branch and watch state. Env values stay hidden.',
    description:
      'Apps Hawkeye deployed from git: repository, branch, scripts, PM2 options, branch watching and the state of the latest run. Environment variable values are never returned, only their names.',
    inputSchema: {},
    run: async () => ({ deployments: getAllDeployments().map(describeDeployment) }),
  },
  {
    name: 'get_deployment_status',
    title: 'Get deploy status',
    access: 'read',
    summary: 'Stage, output and open question of the latest deploy run.',
    description:
      'State of the latest deploy run of a deployment since Hawkeye started: status (running, confirm, success, error), stage, error, and the tail of its output. Status confirm means the run waits for confirm_deployment because the deploy directory has local changes, listed in pendingChanges.',
    inputSchema: { deployment: deploymentRef },
    run: async ({ deployment }) => {
      const record = requireDeployment(deployment);
      return {
        deploymentId: record.id,
        appName: record.pm2_name,
        deploying: Boolean(record.deploying),
        lastDeployedAt: record.last_deployed_at,
        run: getDeployRun(record.id),
      };
    },
  },
  {
    name: 'list_actions',
    title: 'List custom actions',
    access: 'read',
    summary: 'Custom actions a process registered with PM2.',
    description: 'Custom actions a process registered with PM2 (through tx2 or @pm2/io), with their parameters.',
    inputSchema: { process: processRef },
    run: async ({ process }) => {
      const proc = await requireProcess(process);
      return { process: proc.name, actions: await pm2.getProcessActions(proc.pm_id) };
    },
  },
  {
    name: 'get_log_level',
    title: 'Get log level',
    access: 'read',
    summary: 'Current log level of a process that supports it.',
    description:
      'Ask a running process for its current log level. supported is false when the app does not answer Hawkeye log level messages.',
    inputSchema: { process: processRef },
    run: async ({ process }) => {
      const target = unwrap(await pm2.findOnlineProcess(process));
      const answer = await logLevel.queryLevel(target.pmId);
      return { process: target.name, supported: answer.ok === true, level: answer.ok ? answer.level : null };
    },
  },

  // Write ─────────────────────────────────────────────────────────────────
  {
    name: 'restart_process',
    title: 'Restart process',
    access: 'write',
    summary: 'Restart a process.',
    description: 'Restart a PM2 process and return its fresh details.',
    inputSchema: { process: processRef },
    run: lifecycle(pm2.restartProcess),
  },
  {
    name: 'stop_process',
    title: 'Stop process',
    access: 'write',
    summary: 'Stop a running process.',
    description: 'Stop a running PM2 process. It stays in the PM2 list and can be started again.',
    inputSchema: { process: processRef },
    run: lifecycle(pm2.stopProcess),
  },
  {
    name: 'start_process',
    title: 'Start process',
    access: 'write',
    summary: 'Start a stopped process.',
    description: 'Start a stopped PM2 process.',
    inputSchema: { process: processRef },
    run: lifecycle(pm2.startStoppedProcess),
  },
  {
    name: 'set_monitoring',
    title: 'Set monitoring',
    access: 'write',
    summary: 'Turn stored logs and metrics on or off for a process.',
    description:
      'Turn monitoring on or off. A monitored process has its logs and metrics stored by Hawkeye, which get_logs paging and get_metrics need. Turning it on imports the existing log files.',
    inputSchema: {
      process: processRef,
      monitored: z.boolean().describe('True to store logs and metrics, false to stop and delete the stored history.'),
    },
    run: async ({ process, monitored }) => {
      // Only a running process can be added; removing also works for an orphan by name.
      const pm2Name = monitored ? (await requireProcess(process)).name : await resolvePm2Name(process);
      return setMonitoring(pm2Name, monitored);
    },
  },
  {
    name: 'set_log_level',
    title: 'Set log level',
    access: 'write',
    summary: 'Change the log level of a running process.',
    description:
      'Change the log level of a running process that listens for Hawkeye log level messages. The level is not stored: after a restart the app starts with its own level again.',
    inputSchema: { process: processRef, level: z.enum(logLevel.LOG_LEVELS) },
    run: async ({ process, level }) => {
      const target = unwrap(await pm2.findOnlineProcess(process));
      const answer = await logLevel.setLevel(target.pmId, logLevel.normalizeLevel(level));
      return {
        process: target.name,
        supported: answer.ok === true,
        level: answer.ok ? answer.level : null,
        requested: level,
      };
    },
  },
  {
    name: 'trigger_action',
    title: 'Trigger custom action',
    access: 'write',
    summary: 'Run a custom action of a process.',
    description: 'Run a custom action a process registered (see list_actions) and return its output.',
    inputSchema: {
      process: processRef,
      action: z.string().min(1).max(200).describe('Action name as listed by list_actions.'),
      params: z.string().max(2000).optional().describe('Parameter passed to the action, if it takes one.'),
    },
    run: async ({ process, action, params }) => {
      const proc = await requireProcess(process);
      const output = await pm2.triggerProcessAction(proc.pm_id, action, params);
      return { process: proc.name, action, output };
    },
  },
  {
    name: 'create_deployment',
    title: 'Deploy a new app',
    access: 'write',
    summary: 'Clone a repository, install, build and start it under PM2.',
    runsCode: true,
    description:
      'Clone a git repository, run the install, build and setup scripts and start it under PM2. Returns at once with the deployment id; follow the run with get_deployment_status. Runs code from the repository and the scripts on this server.',
    inputSchema: {
      appName: z.string().describe('PM2 name of the app: letters, digits, dashes and underscores, max 64.'),
      ...deploymentFieldShape,
      branch: deploymentFieldShape.branch.optional(),
      startScript: deploymentFieldShape.startScript.optional(),
      installCmd: deploymentFieldShape.installCmd.optional(),
      buildCmd: deploymentFieldShape.buildCmd.optional(),
      preSetupScript: deploymentFieldShape.preSetupScript.optional(),
      postSetupScript: deploymentFieldShape.postSetupScript.optional(),
      envVars: deploymentFieldShape.envVars.optional(),
      pm2Options: deploymentFieldShape.pm2Options.optional(),
      watchEnabled: deploymentFieldShape.watchEnabled.optional(),
      watchIntervalMinutes: deploymentFieldShape.watchIntervalMinutes.optional(),
      discardLocalChanges: deploymentFieldShape.discardLocalChanges.optional(),
    },
    run: async (args) => {
      const result = unwrap(startDeployment(args));
      return { ok: true, deploymentId: result.deploymentId, next: 'Call get_deployment_status to follow the run.' };
    },
  },
  {
    name: 'update_deployment',
    title: 'Edit a deployment',
    access: 'write',
    summary: 'Change repo, branch, scripts or env vars. Takes effect on the next deploy.',
    description:
      'Change fields of a deployment. Only the fields you pass change. envVars sets or overwrites the given variables and keeps the others; removeEnvVars deletes variables by name. Takes effect on the next deploy, not right away.',
    inputSchema: {
      deployment: deploymentRef,
      ...Object.fromEntries(Object.entries(deploymentFieldShape).map(([key, schema]) => [key, schema.optional()])),
      removeEnvVars: z.array(z.string()).optional().describe('Names of environment variables to delete.'),
    },
    run: async ({ deployment, removeEnvVars = [], envVars = {}, ...changes }) => {
      const record = requireDeployment(deployment);
      const current = deploymentToFields(record);
      const mergedEnv = { ...current.envVars, ...envVars };
      for (const name of removeEnvVars) {
        delete mergedEnv[name];
      }
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      const result = unwrap(editDeployment(record.id, { ...current, ...defined, envVars: mergedEnv }));
      return { ok: true, deployment: describeDeployment(result.deployment) };
    },
  },
  {
    name: 'redeploy',
    title: 'Redeploy',
    access: 'write',
    summary: 'Fetch the branch, run install, build and setup scripts, restart.',
    runsCode: true,
    description:
      'Fetch the configured branch, run install, build and setup scripts and restart the app. Returns at once; follow the run with get_deployment_status. With discardLocalChanges, tracked local changes in the deploy directory are discarded instead of waiting for confirm_deployment. Runs code on this server.',
    inputSchema: {
      deployment: deploymentRef,
      discardLocalChanges: z.boolean().optional().describe('Discard tracked local changes without asking.'),
    },
    run: async ({ deployment, discardLocalChanges }) => {
      const record = requireDeployment(deployment);
      const result = unwrap(startRedeploy(record.id, { autoConfirm: discardLocalChanges === true }));
      return { ok: true, deploymentId: result.deploymentId, next: 'Call get_deployment_status to follow the run.' };
    },
  },
  {
    name: 'confirm_deployment',
    title: 'Answer deploy question',
    access: 'write',
    summary: 'Answer the local-changes question of a running deploy.',
    description:
      'Answer a running deploy that waits because its directory has tracked local changes (get_deployment_status shows status confirm). discard true discards them and continues, false cancels the deploy. The question expires after 60 seconds.',
    inputSchema: {
      deployment: deploymentRef,
      discard: z.boolean().describe('True discards the local changes and continues, false cancels.'),
    },
    run: async ({ deployment, discard }) => {
      const record = requireDeployment(deployment);
      unwrap(confirmDeployment(record.id, discard));
      return { ok: true };
    },
  },

  // Destructive ───────────────────────────────────────────────────────────
  {
    name: 'delete_process',
    title: 'Delete process',
    access: 'destructive',
    summary: 'Remove a process from PM2, optionally with its deploy directory.',
    description:
      'Remove a process from PM2. With deleteDeployment, every instance with that name goes, plus its deployment record and its directory on disk. Cannot be undone.',
    inputSchema: {
      process: processRef,
      deleteDeployment: z.boolean().optional().describe('Also delete the deployment record and the deploy directory.'),
    },
    run: async ({ process, deleteDeployment }, { actor }) => {
      const result = unwrap(await removeProcess(process, { deleteDeploy: deleteDeployment === true, actor }));
      return { ok: true, pm2Name: result.pm2Name };
    },
  },
  {
    name: 'delete_deployment',
    title: 'Delete deployment record',
    access: 'destructive',
    summary: 'Delete a deployment record. The process keeps running.',
    description:
      'Delete a deployment record. The PM2 process keeps running and the directory on disk stays; Hawkeye only forgets how to redeploy it.',
    inputSchema: { deployment: deploymentRef },
    run: async ({ deployment }) => {
      const record = requireDeployment(deployment);
      unwrap(removeDeployment(record.id));
      return { ok: true, deleted: record.pm2_name };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Default state of a tool: read tools are on, everything else is off.
 *
 * @param {ToolDefinition} tool
 * @returns {boolean}
 */
function isOnByDefault(tool) {
  return tool.access === 'read';
}

/**
 * Whether a tool is on, given the stored overrides.
 *
 * @param {ToolDefinition} tool
 * @param {Record<string, boolean>} overrides
 * @returns {boolean}
 */
export function isToolEnabled(tool, overrides) {
  return typeof overrides[tool.name] === 'boolean' ? overrides[tool.name] : isOnByDefault(tool);
}

/**
 * Every tool with its current state, for the Settings page.
 *
 * @param {Record<string, boolean>} overrides
 * @returns {{ name: string, title: string, summary: string, access: ToolAccess, runsCode: boolean, enabled: boolean }[]}
 */
export function listToolStates(overrides) {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    summary: tool.summary,
    access: tool.access,
    runsCode: tool.runsCode === true,
    enabled: isToolEnabled(tool, overrides),
  }));
}

/**
 * Apply tool changes to the stored overrides. A tool set back to its default
 * loses its override, so the stored map only holds real deviations.
 *
 * @param {Record<string, boolean>} overrides - Current overrides.
 * @param {Record<string, unknown>} changes - Tool name -> wanted state.
 * @returns {{ ok: true, overrides: Record<string, boolean> } | { ok: false, error: string }}
 */
export function applyToolChanges(overrides, changes) {
  const unknown = Object.keys(changes).filter((name) => !TOOLS_BY_NAME.has(name));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown tools: ${unknown.join(', ')}` };
  }
  const invalid = Object.entries(changes).filter(([, value]) => typeof value !== 'boolean');
  if (invalid.length > 0) {
    return { ok: false, error: `Tool states must be booleans: ${invalid.map(([name]) => name).join(', ')}` };
  }

  const next = {};
  for (const tool of TOOLS) {
    const wanted = tool.name in changes ? changes[tool.name] : isToolEnabled(tool, overrides);
    if (wanted !== isOnByDefault(tool)) {
      next[tool.name] = wanted;
    }
  }
  return { ok: true, overrides: next };
}

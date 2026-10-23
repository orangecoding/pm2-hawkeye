/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { formatBytes, parseMemorySize } from './format.js';
import { appendBounded } from './logs.js';

/**
 * Convert a numeric form value while preserving valid zero values.
 *
 * @param {string|number} value
 * @param {number} fallback
 * @returns {number}
 */
export function normalizePm2Number(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Prefix of a selection key that points at a deployment instead of a process. */
const DEPLOYMENT_KEY_PREFIX = 'deployment:';

/**
 * Selection key of a deployment that has no PM2 process.
 *
 * A pm_id is a number and a PM2 name never contains a colon, so this key
 * cannot collide with a process key.
 *
 * @param {string} deploymentId
 * @returns {string}
 */
export function deploymentKey(deploymentId) {
  return `${DEPLOYMENT_KEY_PREFIX}${deploymentId}`;
}

/**
 * The deployment id inside a selection key, or null for a process key.
 *
 * @param {number|string|null} key
 * @returns {string|null}
 */
export function deploymentIdFromKey(key) {
  return typeof key === 'string' && key.startsWith(DEPLOYMENT_KEY_PREFIX)
    ? key.slice(DEPLOYMENT_KEY_PREFIX.length)
    : null;
}

/**
 * Shorten a git remote URL to `owner/repo` for display.
 *
 * Handles both HTTPS (https://github.com/owner/repo.git) and SSH
 * (git@github.com:owner/repo.git) forms, and falls back to the raw string.
 *
 * @param {string} url
 * @returns {string}
 */
export function shortRepo(url) {
  if (!url) return '';
  const cleaned = url
    .replace(/\.git$/, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : cleaned;
}

/**
 * Suggest an app name from a repository URL: its last path segment without
 * `.git`, lowercased, with every character the backend's `validateAppName`
 * rejects turned into `-`.
 *
 * @param {string} repoUrl
 * @returns {string} A valid app name, or '' when none can be derived.
 */
export function deriveAppName(repoUrl) {
  const last =
    String(repoUrl || '')
      .trim()
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop() ?? '';
  const name = last
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  // Mirrors validateAppName in lib/service/deployRunner.js.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || /^\d+$/.test(name) || name === 'all') return '';
  return name;
}

/**
 * Where an offline deployment (one without a PM2 process) stands.
 *
 * @param {{ deploying?: number|boolean, last_deployed_at?: number|null }} deployment
 * @returns {'deploying'|'broken'|'offline'} `broken` when the first deploy
 *   never finished, `offline` when it ran before but is gone from PM2.
 */
export function offlineStatus(deployment) {
  if (deployment.deploying) return 'deploying';
  return deployment.last_deployed_at == null ? 'broken' : 'offline';
}

/**
 * Summarise how PM2 runs a deployment, e.g. `fork mode, 1 instance, restarts
 * above 300 MB`.
 *
 * @param {object} [pm2Options] - Stored or form `pm2_options`.
 * @returns {string}
 */
export function pm2Summary(pm2Options = {}) {
  const mode = pm2Options.exec_mode || 'fork';
  const instances = normalizePm2Number(pm2Options.instances, 1);
  const count = instances === -1 ? 'one instance per core' : `${instances} instance${instances === 1 ? '' : 's'}`;
  const limit = parseMemorySize(pm2Options.max_memory_restart);
  return `${mode} mode, ${count}${limit ? `, restarts above ${formatBytes(limit)}` : ''}`;
}

/**
 * The first line of a shell script that does something, skipping the shebang
 * and blank lines. Used where a script needs a one-line label.
 *
 * @param {string} script
 * @returns {string}
 */
export function scriptHeadline(script) {
  const lines = String(script || '')
    .split('\n')
    .map((l) => l.trim());
  return lines.find((l) => l && !l.startsWith('#!')) ?? '';
}

/** Every stage the deploy runner reports, in the order it runs them. */
export const DEPLOY_STAGES = ['pre_setup', 'clone', 'install', 'build', 'post_setup', 'start'];

/**
 * The six steps a deploy of this configuration runs, in order, including the
 * ones it skips. Mirrors `runDeploy` in lib/service/deployRunner.js.
 *
 * @param {{
 *   repo_url?: string, branch?: string, deploy_path?: string, start_script?: string,
 *   install_cmd?: string|null, build_cmd?: string|null,
 *   pre_setup_script?: string|null, post_setup_script?: string|null, pm2_options?: object,
 * }} deployment - A deployment record, or the live form state in the same shape.
 * @param {{ firstDeploy: boolean, startsProcess?: boolean }} opts - A first
 *   deploy clones, a redeploy fetches. `startsProcess` says PM2 has no process
 *   to restart, so the last step starts one; it defaults to `firstDeploy`.
 * @returns {{ stage: string, title: string, skipped: boolean, code: string, command: string }[]}
 *   `code` is the full command block, `command` a one-line label of it.
 */
export function planDeploy(deployment, { firstDeploy, startsProcess = firstDeploy }) {
  const branch = deployment.branch || 'master';
  const install = deployment.install_cmd ? deployment.install_cmd.trim() : '';
  const build = deployment.build_cmd ? deployment.build_cmd.trim() : '';
  const pre = deployment.pre_setup_script ? deployment.pre_setup_script.trim() : '';
  const post = deployment.post_setup_script ? deployment.post_setup_script.trim() : '';
  const start = deployment.start_script || 'index.js';
  return [
    { stage: 'pre_setup', title: 'Pre-setup script', skipped: !pre, code: pre, command: scriptHeadline(pre) },
    firstDeploy
      ? {
          stage: 'clone',
          title: 'Clone the repository',
          skipped: false,
          code: `git clone --branch ${branch} --depth 1 ${deployment.repo_url || '<repository>'} ${deployment.deploy_path || ''}`.trim(),
          command: `git clone, branch ${branch}`,
        }
      : {
          stage: 'clone',
          title: 'Update the code',
          skipped: false,
          code: `git fetch --depth 1 origin ${branch}\ngit checkout -B ${branch} FETCH_HEAD`,
          command: `git fetch, checkout ${branch}`,
        },
    {
      stage: 'install',
      title: 'Install dependencies',
      skipped: !install || install === 'skip',
      code: install === 'skip' ? '' : install,
      command: install === 'skip' ? '' : install,
    },
    { stage: 'build', title: 'Build', skipped: !build, code: build, command: build },
    { stage: 'post_setup', title: 'Post-setup script', skipped: !post, code: post, command: scriptHeadline(post) },
    {
      stage: 'start',
      title: startsProcess ? 'Start in PM2' : 'Restart in PM2',
      skipped: false,
      code: start,
      command: start,
    },
  ];
}

/** Lines the deploy runner prints itself, as opposed to git or npm output. */
const STEP_ANNOUNCEMENT =
  /^(Running |Fetching |Cloning |Restarting PM2 process |Starting PM2 process |Local changes |Discarding local changes)/;

/**
 * Colour class of one output line in the deploy run panel.
 *
 * @param {{ stage: string, line: string, status: string }} entry
 * @returns {'default'|'detail'|'confirm'|'error'|'success'}
 */
export function outputTone(entry) {
  if (entry.stage === 'error' || entry.status === 'error') return 'error';
  if (entry.stage === 'done') return 'success';
  if (/^Local changes detected/.test(entry.line)) return 'confirm';
  return STEP_ANNOUNCEMENT.test(entry.line) ? 'default' : 'detail';
}

/**
 * Exit code inside a deploy error message, e.g. from `npm exited with code 2`.
 *
 * @param {string} message
 * @returns {number|null}
 */
function exitCodeOf(message) {
  const match = /exited with code (\d+)/.exec(message || '');
  return match ? Number(match[1]) : null;
}

/**
 * Work out what every step of a run looks like from the progress events seen
 * in this browser session.
 *
 * - the current stage is the stage of the latest event, and every stage
 *   before it is done;
 * - `status: 'confirm'` marks the current stage as waiting for the user;
 * - an `error` event fails the last real stage seen, and the stages after it
 *   did not run;
 * - a `done` event marks every stage done.
 *
 * Without any events (the page was reloaded during the run) every step stays
 * pending: nothing is invented.
 *
 * @param {{ stage: string }[]} steps - The steps that run, in order.
 * @param {{ stage: string, line: string, status: string }[]} lines - Progress events, oldest first.
 * @returns {{ states: ('done'|'active'|'wait'|'fail'|'skip'|'pending')[], outcome: 'running'|'confirm'|'failed'|'success', failedIndex: number, error: string, exitCode: number|null }}
 */
export function deriveRunState(steps, lines) {
  const stageIndex = (stage) => steps.findIndex((s) => s.stage === stage);
  const last = lines.at(-1);
  const pending = steps.map(() => 'pending');
  if (!last) return { states: pending, outcome: 'running', failedIndex: -1, error: '', exitCode: null };

  if (last.stage === 'done') {
    return { states: steps.map(() => 'done'), outcome: 'success', failedIndex: -1, error: '', exitCode: null };
  }

  if (last.stage === 'error') {
    const lastReal = [...lines].reverse().find((l) => stageIndex(l.stage) !== -1);
    const failedIndex = lastReal ? stageIndex(lastReal.stage) : 0;
    const states = steps.map((_, i) => (i < failedIndex ? 'done' : i === failedIndex ? 'fail' : 'skip'));
    return { states, outcome: 'failed', failedIndex, error: last.line, exitCode: exitCodeOf(last.line) };
  }

  const current = stageIndex(last.stage);
  const waiting = last.status === 'confirm';
  const states = steps.map((_, i) => {
    if (i < current) return 'done';
    if (i === current) return waiting ? 'wait' : 'active';
    return 'pending';
  });
  return { states, outcome: waiting ? 'confirm' : 'running', failedIndex: -1, error: '', exitCode: null };
}

/** How many deployments, and how many progress events each, the client keeps. */
export const RUN_LIMITS = { deployments: 5, events: 500 };

/**
 * A fresh, empty run.
 *
 * @param {number} now
 * @param {boolean|undefined} firstDeploy
 * @param {boolean|undefined} [startsProcess]
 * @returns {object}
 */
function emptyRun(now, firstDeploy, startsProcess) {
  return {
    lines: [],
    stage: null,
    status: 'running',
    confirmChanges: null,
    firstDeploy,
    startsProcess,
    startedAt: now,
    finishedAt: null,
    dismissed: false,
  };
}

/**
 * Put one run into the map as its most recent entry, evicting the oldest
 * deployments beyond {@link RUN_LIMITS}. Object key order follows insertion
 * for non-numeric keys such as UUIDs, so re-inserting tracks recency.
 *
 * @param {Record<string, object>} runs
 * @param {string} deploymentId
 * @param {object} run
 * @returns {Record<string, object>}
 */
function putRun(runs, deploymentId, run) {
  const next = { ...runs };
  delete next[deploymentId];
  next[deploymentId] = run;
  const ids = Object.keys(next);
  while (ids.length > RUN_LIMITS.deployments) delete next[ids.shift()];
  return next;
}

/**
 * Start tracking a run the user just started in this browser, replacing
 * whatever an earlier run of the same deployment left behind.
 *
 * @param {Record<string, object>} runs - deploymentId → run.
 * @param {string} deploymentId
 * @param {{ firstDeploy?: boolean, startsProcess?: boolean, now?: number }} [opts] -
 *   `firstDeploy`, and `startsProcess` (PM2 has no process for it yet), are
 *   decided when the run starts, so the labels stay right after the
 *   deployment record and the process list change at the end of the run.
 * @returns {Record<string, object>}
 */
export function startRun(runs, deploymentId, { firstDeploy, startsProcess, now = Date.now() } = {}) {
  return putRun(runs, deploymentId, emptyRun(now, firstDeploy, startsProcess));
}

/**
 * Feed one `deploy_progress` event into the run map.
 *
 * Every deployment's events are kept, not only the one on screen, so a run
 * started by the branch watcher or in another tab shows up wherever its
 * deployment is opened. An event for a deployment whose last run has
 * finished starts a new run.
 *
 * @param {Record<string, object>} runs - deploymentId → run.
 * @param {{ deploymentId: string, stage: string, line: string, status: string }} event
 * @param {number} [now]
 * @returns {Record<string, object>}
 */
export function recordDeployEvent(runs, event, now = Date.now()) {
  const existing = runs[event.deploymentId];
  const run = existing && !existing.finishedAt ? existing : emptyRun(now, undefined);
  const finished = event.stage === 'done' || event.stage === 'error';
  return putRun(runs, event.deploymentId, {
    ...run,
    lines: appendBounded(
      run.lines,
      [{ stage: event.stage, line: event.line, status: event.status }],
      RUN_LIMITS.events,
    ),
    stage: event.stage,
    status: event.status,
    // A paused deployment waits for the user to approve discarding local
    // changes; any later event clears the question.
    confirmChanges: event.status === 'confirm' ? event.line : null,
    finishedAt: finished ? now : null,
    dismissed: false,
  });
}

/**
 * Whether a run clones (a first deploy, or a redeploy whose folder has no git
 * repository) rather than fetching. The events tell for sure once the clone
 * step has started; before that the flag recorded at the start, or the
 * deployment record, decides.
 *
 * @param {object} deployment
 * @param {object | undefined} run
 * @returns {boolean}
 */
export function isFirstDeploy(deployment, run) {
  const cloneLine = run?.lines.find((l) => l.stage === 'clone' && /^(Cloning |Fetching |Local changes )/.test(l.line));
  if (cloneLine) return cloneLine.line.startsWith('Cloning ');
  return run?.firstDeploy ?? deployment.last_deployed_at == null;
}

/**
 * Whether a deployment has a run going on right now: one seen in this session
 * that has not finished, or one the server reports (`deploying`), for example
 * after a page reload.
 *
 * @param {object} deployment
 * @param {object | undefined} run
 * @returns {boolean}
 */
export function isRunActive(deployment, run) {
  return Boolean(deployment?.deploying) || Boolean(run && !run.finishedAt);
}

/**
 * Colour of the dot on a Deploy tab, first match wins: accent while a run is
 * working, warning while it waits for the user or the last branch check
 * failed, critical when the last run failed (or a first deploy never
 * finished), none otherwise.
 *
 * @param {object} deployment
 * @param {object | undefined} run
 * @returns {{ tone: 'accent'|'warning'|'critical', label: string } | null}
 */
export function deployTabDot(deployment, run) {
  if (!deployment) return null;
  const waiting = run?.lines.at(-1)?.status === 'confirm' && !run.finishedAt;
  if (isRunActive(deployment, run) && !waiting) return { tone: 'accent', label: 'Deployment running' };
  if (waiting) return { tone: 'warning', label: 'Deployment waiting for you' };
  if (deployment.watch_last_error) return { tone: 'warning', label: 'Auto-deploy check failed' };
  if (run?.lines.at(-1)?.stage === 'error') return { tone: 'critical', label: 'Last deployment failed' };
  if (deployment.last_deployed_at == null) return { tone: 'critical', label: 'Deployment failed' };
  return null;
}

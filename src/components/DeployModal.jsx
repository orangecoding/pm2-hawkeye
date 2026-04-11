/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../services/api.js';

// All PM2 ecosystem stages that may appear in progress messages.
const ALL_STAGES = ['pre_setup', 'clone', 'install', 'build', 'post_setup', 'start'];

const STAGE_LABELS = {
  pre_setup: 'Pre-setup',
  clone: 'Clone',
  install: 'Install',
  build: 'Build',
  post_setup: 'Post-setup',
  start: 'Start',
};

/**
 * Default values for pm2Options fields shown in the form.
 */
const DEFAULT_PM2_OPTIONS = {
  interpreter: 'node',
  interpreter_args: '',
  args: '',
  exec_mode: 'fork',
  instances: 1,
  watch: false,
  ignore_watch: 'node_modules',
  max_memory_restart: '',
  autorestart: true,
  max_restarts: 10,
  restart_delay: 0,
  min_uptime: '',
  kill_timeout: 1600,
  listen_timeout: 3000,
  wait_ready: false,
  shutdown_with_message: false,
  cron_restart: '',
  time: true,
  combine_logs: false,
  out_file: '',
  error_file: '',
  source_map_support: true,
  env_file: '',
};

// Shared sub-components ──────────────────────────────────────────────────────

/**
 * Collapsible section wrapper with a description shown when the section is open.
 *
 * @param {{ title: string, info: string, defaultOpen?: boolean, children: React.ReactNode }} props
 */
function Section({ title, info, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="deploy-section">
      <div className="deploy-section-header" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <span className={`deploy-section-chevron${open ? ' open' : ''}`}>&#9660;</span>
      </div>
      {open && (
        <>
          {info && <p className="deploy-section-info">{info}</p>}
          <div className="deploy-section-body">{children}</div>
        </>
      )}
    </div>
  );
}

/**
 * Labelled form field with an optional hint below the input.
 * Pass `required` to append the red asterisk to the label.
 *
 * @param {{ label: string, hint?: string, required?: boolean, children: React.ReactNode }} props
 */
function Field({ label, hint, required, children }) {
  return (
    <div className="deploy-field">
      <label>
        {label}
        {required && <span className="deploy-required" aria-label="required">*</span>}
      </label>
      {children}
      {hint && <p className="deploy-hint">{hint}</p>}
    </div>
  );
}

/**
 * Toggle switch row that does not inherit the block-label styles from Field.
 * Uses a dedicated wrapper so the toggle renders correctly inside the deploy form.
 *
 * @param {{ label: string, hint?: string, checked: boolean, onChange: (v: boolean) => void }} props
 */
function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="deploy-toggle-row">
      <label className="toggle-switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="toggle-track" />
        <span className="toggle-label">{label}</span>
      </label>
      {hint && <p className="deploy-hint">{hint}</p>}
    </div>
  );
}

// Stage pill bar ─────────────────────────────────────────────────────────────

/**
 * Renders the stage progress pills, hiding stages that were skipped.
 *
 * @param {{ visibleStages: string[], currentStage: string, status: string }} props
 */
function StagePillBar({ visibleStages, currentStage, status }) {
  const pillState = (stage) => {
    const idx = visibleStages.indexOf(stage);
    const curIdx = visibleStages.indexOf(currentStage);
    if (currentStage === 'error') return idx <= curIdx ? '--error' : '';
    if (currentStage === 'done') return '--done';
    if (idx < curIdx) return '--done';
    if (idx === curIdx) return status === 'error' ? '--error' : '--active';
    return '';
  };

  return (
    <div className="deploy-stage-bar">
      {visibleStages.map((stage, i) => (
        <React.Fragment key={stage}>
          {i > 0 && <span className="deploy-stage-arrow">&#8250;</span>}
          <span className={`deploy-stage-pill${pillState(stage)}`}>{STAGE_LABELS[stage]}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// View A: Deploy form ────────────────────────────────────────────────────────

/**
 * Convert a stored env_vars object to an array of {key, value} rows for the form.
 *
 * @param {object} obj
 * @returns {{ key: string, value: string }[]}
 */
function envObjToRows(obj) {
  const entries = Object.entries(obj || {});
  return entries.length ? entries.map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }];
}

/**
 * Convert a stored pm2_options object to the flat form state shape.
 * Merges defaults so any missing stored fields fall back gracefully.
 *
 * @param {object} opts
 * @returns {object}
 */
function pm2OptsFromStored(opts) {
  const ignore = Array.isArray(opts.ignore_watch)
    ? opts.ignore_watch.join('\n')
    : (opts.ignore_watch ?? DEFAULT_PM2_OPTIONS.ignore_watch);
  return {
    ...DEFAULT_PM2_OPTIONS,
    ...opts,
    ignore_watch: ignore,
  };
}

/**
 * The deployment configuration form.
 *
 * When `editingDeployment` is provided the form pre-fills with existing values,
 * the app name becomes read-only, and saving issues a PUT instead of a POST.
 *
 * @param {{
 *   csrfToken: string,
 *   onCsrfRefresh: () => Promise<string>,
 *   onDeployStarted: (id: string) => void,
 *   editingDeployment?: object | null,
 *   onEditSaved?: () => Promise<void>,
 *   onSaveAndRedeploy?: (deploymentId: string) => Promise<void>,
 * }} props
 */
function DeployForm({ csrfToken, onCsrfRefresh, onDeployStarted, editingDeployment, onEditSaved, onSaveAndRedeploy }) {
  const isEdit = Boolean(editingDeployment);

  const [appName, setAppName] = useState(() => editingDeployment?.pm2_name ?? '');
  const [repoUrl, setRepoUrl] = useState(() => editingDeployment?.repo_url ?? '');
  const [branch, setBranch] = useState(() => editingDeployment?.branch ?? 'main');
  const [startScript, setStartScript] = useState(() => editingDeployment?.start_script ?? 'index.js');
  const [installCmd, setInstallCmd] = useState(() => {
    const stored = editingDeployment?.install_cmd ?? 'npm install';
    // Split off any extra flags that were previously saved (e.g. "npm install --prod").
    const knownBases = ['npm install', 'npm ci', 'yarn install', 'yarn', 'pnpm install', 'skip'];
    const base = knownBases.find((b) => stored === b || stored.startsWith(b + ' '));
    return base ?? stored;
  });
  const [installArgs, setInstallArgs] = useState(() => {
    const stored = editingDeployment?.install_cmd ?? 'npm install';
    const knownBases = ['npm install', 'npm ci', 'yarn install', 'yarn', 'pnpm install', 'skip'];
    const base = knownBases.find((b) => stored === b || stored.startsWith(b + ' '));
    return base && stored.length > base.length ? stored.slice(base.length + 1) : '';
  });
  const [buildCmd, setBuildCmd] = useState(() => editingDeployment?.build_cmd ?? '');
  const [preSetupScript, setPreSetupScript] = useState(() => editingDeployment?.pre_setup_script ?? '');
  const [postSetupScript, setPostSetupScript] = useState(() => editingDeployment?.post_setup_script ?? '');
  const [envVars, setEnvVars] = useState(() =>
    isEdit ? envObjToRows(editingDeployment.env_vars) : [{ key: '', value: '' }],
  );
  const [pm2Opts, setPm2Opts] = useState(() =>
    isEdit ? pm2OptsFromStored(editingDeployment.pm2_options) : { ...DEFAULT_PM2_OPTIONS },
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const setOpt = (key, val) => setPm2Opts((prev) => ({ ...prev, [key]: val }));

  const addEnvVar = () => setEnvVars((prev) => [...prev, { key: '', value: '' }]);
  const removeEnvVar = (i) => setEnvVars((prev) => prev.filter((_, idx) => idx !== i));
  const updateEnvVar = (i, field, val) =>
    setEnvVars((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  /** Build the shared payload object from current form state. */
  const buildPayload = useCallback(() => {
    const envVarsObj = {};
    for (const { key, value } of envVars) {
      if (key.trim()) envVarsObj[key.trim()] = value;
    }
    const pm2Options = {
      ...pm2Opts,
      instances: Number(pm2Opts.instances) || 1,
      max_restarts: Number(pm2Opts.max_restarts) || 10,
      restart_delay: Number(pm2Opts.restart_delay) || 0,
      kill_timeout: Number(pm2Opts.kill_timeout) || 1600,
      listen_timeout: Number(pm2Opts.listen_timeout) || 3000,
      min_uptime: pm2Opts.min_uptime ? Number(pm2Opts.min_uptime) : undefined,
      ignore_watch: pm2Opts.ignore_watch
        ? pm2Opts.ignore_watch.split('\n').map((s) => s.trim()).filter(Boolean)
        : ['node_modules'],
    };
    return {
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || 'main',
      startScript: startScript.trim() || 'index.js',
      installCmd: installArgs.trim() ? `${installCmd} ${installArgs.trim()}` : installCmd,
      buildCmd: buildCmd.trim(),
      preSetupScript: preSetupScript.trim(),
      postSetupScript: postSetupScript.trim(),
      envVars: envVarsObj,
      pm2Options,
    };
  }, [envVars, pm2Opts, repoUrl, branch, startScript, installCmd, installArgs, buildCmd, preSetupScript, postSetupScript]);

  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setError('');
      setSubmitting(true);

      try {
        // Always fetch a fresh CSRF token immediately before submitting to avoid
        // stale-token mismatches caused by intervening mutations on the same page.
        const freshToken = await onCsrfRefresh();
        if (isEdit) {
          await fetchJson(`/api/deployments/${editingDeployment.id}`, {
            method: 'PUT',
            headers: { 'X-CSRF-Token': freshToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload()),
          });
          if (onEditSaved) await onEditSaved();
        } else {
          const payload = buildPayload();
          const result = await fetchJson('/api/deployments', {
            method: 'POST',
            headers: { 'X-CSRF-Token': freshToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ appName: appName.trim(), ...payload }),
          });
          onDeployStarted(result.deploymentId);
        }
      } catch (err) {
        setError(err.message);
        setSubmitting(false);
      }
    },
    [isEdit, editingDeployment, appName, buildPayload, onCsrfRefresh, onDeployStarted, onEditSaved],
  );

  /**
   * Save current config (PUT) then hand off to parent to trigger a redeploy.
   * Only available in edit mode.
   */
  const onRedeployClick = useCallback(async () => {
    setError('');
    setSubmitting(true);
    try {
      // Fetch a fresh token before the PUT so the subsequent redeploy POST
      // in onSaveAndRedeploy can also get a valid token after rotation.
      const freshToken = await onCsrfRefresh();
      await fetchJson(`/api/deployments/${editingDeployment.id}`, {
        method: 'PUT',
        headers: { 'X-CSRF-Token': freshToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (onSaveAndRedeploy) await onSaveAndRedeploy(editingDeployment.id);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }, [editingDeployment, onCsrfRefresh, buildPayload, onSaveAndRedeploy]);

  return (
    <>
      <form id="deploy-form" className="deploy-modal-body" onSubmit={onSubmit}>

        {/* How it works -- shown only on new deployments */}
        {!isEdit && (
          <div className="deploy-how-it-works">
            <div className="deploy-how-title">How deployment works</div>
            <div className="deploy-how-steps">
              {['pre-setup', 'git clone', 'install', 'build', 'post-setup', 'pm2 start'].map((s, i) => (
                <React.Fragment key={s}>
                  {i > 0 && <span className="deploy-how-arrow">&#8250;</span>}
                  <span className="deploy-how-step">{s}</span>
                </React.Fragment>
              ))}
            </div>
            <p>
              Hawkeye runs these steps on this server and streams all output in real time. Once done,
              the process appears in the sidebar. A <strong>Redeploy</strong> button lets you run{' '}
              <code>git pull</code> + restart at any time. Only public HTTPS repos are supported
              out of the box -- for private repos the server needs an SSH key or credential helper.
            </p>
          </div>
        )}

        <p className="deploy-required-note">
          Fields marked <span>*</span> are required.
        </p>

        {/* Repository */}
        <Section
          title="Repository"
          info="Where your code lives. Hawkeye clones this repository into the configured deploy base directory (DEPLOY_BASE_DIR). On redeploy it runs git pull instead of a fresh clone."
          defaultOpen
        >
          <Field
            label="App name"
            required={!isEdit}
            hint={isEdit
              ? 'The app name is tied to the deploy path and cannot be changed after initial deployment.'
              : 'Unique PM2 process name. Used as the directory name under the deploy base path. Alphanumeric, dashes and underscores only, max 64 characters.'}
          >
            <input
              className="settings-input"
              type="text"
              required={!isEdit}
              placeholder="my-api"
              value={appName}
              readOnly={isEdit}
              style={isEdit ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
              onChange={isEdit ? undefined : (e) => setAppName(e.target.value)}
            />
          </Field>
          <Field label="Repo URL" required hint="HTTPS URL (e.g. https://github.com/owner/repo) or SSH URL (e.g. git@github.com:owner/repo.git). For private repos the server needs an SSH key or credential helper configured.">
            <input
              className="settings-input"
              type="text"
              required
              placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </Field>
          <Field label="Branch" hint="Git branch to clone and pull from on each redeploy.">
            <input
              className="settings-input"
              type="text"
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </Field>
        </Section>

        {/* Runtime */}
        <Section
          title="Runtime"
          info="How PM2 should launch your application. The start script is the only required field here. All other fields default to standard Node.js settings."
          defaultOpen
        >
          <Field label="Start script" required hint="Entry point relative to the repo root, e.g. src/server.js or dist/index.js.">
            <input
              className="settings-input"
              type="text"
              required
              placeholder="index.js"
              value={startScript}
              onChange={(e) => setStartScript(e.target.value)}
            />
          </Field>
          <div className="deploy-two-col">
            <Field label="Interpreter" hint="Runtime binary. Leave as 'node' for standard Node.js. Use an absolute path for a custom binary.">
              <input
                className="settings-input"
                type="text"
                placeholder="node"
                value={pm2Opts.interpreter}
                onChange={(e) => setOpt('interpreter', e.target.value)}
              />
            </Field>
            <Field label="Interpreter args" hint="Flags passed to Node.js before the script, e.g. --max-old-space-size=4096.">
              <input
                className="settings-input"
                type="text"
                placeholder="--max-old-space-size=4096"
                value={pm2Opts.interpreter_args}
                onChange={(e) => setOpt('interpreter_args', e.target.value)}
              />
            </Field>
          </div>
          <Field label="Script args" hint="CLI arguments forwarded to your application, e.g. --port 8080.">
            <input
              className="settings-input"
              type="text"
              placeholder="--port 8080"
              value={pm2Opts.args}
              onChange={(e) => setOpt('args', e.target.value)}
            />
          </Field>
          <div className="deploy-two-col">
            <Field label="Exec mode" hint="fork: runs as a single process. cluster: uses Node.js cluster to spawn multiple workers sharing one port. Cluster requires your app to work with the cluster module.">
              <select
                className="settings-select"
                value={pm2Opts.exec_mode}
                onChange={(e) => setOpt('exec_mode', e.target.value)}
              >
                <option value="fork">fork (default)</option>
                <option value="cluster">cluster</option>
              </select>
            </Field>
            <Field label="Instances" hint="Number of processes to launch. Set to -1 to use all available CPU cores. Values above 1 require cluster mode.">
              <input
                className="settings-input"
                type="number"
                min="-1"
                value={pm2Opts.instances}
                onChange={(e) => setOpt('instances', e.target.value)}
              />
            </Field>
          </div>
        </Section>

        {/* Setup */}
        <Section
          title="Setup"
          info="Commands and scripts that run during the deployment sequence. Pre-setup runs before cloning (useful for system dependency checks). Post-setup runs after building and before PM2 start (useful for database migrations or file permissions). Both scripts have full shell access."
        >
          <Field label="Install command" hint="Package manager command run after cloning to install dependencies.">
            <select
              className="settings-select"
              value={installCmd}
              onChange={(e) => setInstallCmd(e.target.value)}
            >
              <option value="npm install">npm install</option>
              <option value="npm ci">npm ci (clean install, recommended for CI)</option>
              <option value="yarn">yarn</option>
              <option value="yarn install">yarn install</option>
              <option value="pnpm install">pnpm install</option>
              <option value="skip">Skip (no install)</option>
            </select>
          </Field>
          {installCmd !== 'skip' && (
            <Field label="Extra install flags" hint="Additional flags appended to the install command, e.g. --prod or --frozen-lockfile.">
              <input
                className="settings-input"
                type="text"
                placeholder="e.g. --prod"
                value={installArgs}
                onChange={(e) => setInstallArgs(e.target.value)}
              />
            </Field>
          )}
          <Field label="Build command" hint="Optional build step after installing, e.g. npm run build or tsc. Leave blank to skip.">
            <input
              className="settings-input"
              type="text"
              placeholder="npm run build"
              value={buildCmd}
              onChange={(e) => setBuildCmd(e.target.value)}
            />
          </Field>
          <Field label="Pre-setup script" hint="Shell script run before cloning, in the deploy base directory. Use it to install system packages, check that required tools are available, or prepare the environment.">
            <textarea
              className="settings-input"
              rows={4}
              placeholder={'#!/bin/sh\n# e.g. check for required tools\nwhich ffmpeg || (echo "ffmpeg not found" && exit 1)'}
              value={preSetupScript}
              onChange={(e) => setPreSetupScript(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', resize: 'vertical' }}
            />
          </Field>
          <Field label="Post-setup script" hint="Shell script run after building, inside the cloned repo directory, before PM2 starts the process. Use it for database migrations, writing config files, or setting file permissions.">
            <textarea
              className="settings-input"
              rows={4}
              placeholder={'#!/bin/sh\n# e.g. run database migrations\nnode scripts/migrate.js'}
              value={postSetupScript}
              onChange={(e) => setPostSetupScript(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', resize: 'vertical' }}
            />
          </Field>
        </Section>

        {/* Environment */}
        <Section
          title="Environment"
          info="Variables injected into the process environment. You can point to a .env file already present in the repo, add explicit key-value pairs, or both. Explicit variables always take precedence over file values."
        >
          <Field label="Env file" hint="Path to a .env file: relative to the repo root (e.g. .env.production) or absolute on the server (e.g. /etc/myapp/.env). Read at every deploy and redeploy. Values follow the KEY=value format; lines starting with # are ignored.">
            <input
              className="settings-input"
              type="text"
              placeholder=".env.production"
              value={pm2Opts.env_file}
              onChange={(e) => setOpt('env_file', e.target.value)}
            />
          </Field>
          <div className="deploy-field">
            <label>Environment variables</label>
            <p className="deploy-hint">Explicit key-value pairs injected at start time. These override values loaded from the env file above.</p>
            {envVars.map((row, i) => (
              <div className="env-var-row" key={i}>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="KEY"
                  value={row.key}
                  onChange={(e) => updateEnvVar(i, 'key', e.target.value)}
                />
                <input
                  className="settings-input"
                  type="text"
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => updateEnvVar(i, 'value', e.target.value)}
                />
                <button type="button" className="env-remove-btn" onClick={() => removeEnvVar(i)} aria-label="Remove variable">
                  &times;
                </button>
              </div>
            ))}
            <button type="button" className="env-add-btn" onClick={addEnvVar}>+ Add variable</button>
          </div>
        </Section>

        {/* Restart & Memory */}
        <Section
          title="Restart &amp; Memory"
          info="Controls what happens when your process exits, crashes, or uses too much memory. The defaults work well for most apps; adjust if you need fine-grained crash recovery behaviour."
        >
          <Toggle
            label="Auto-restart on crash"
            hint="Automatically restart the process whenever it exits, regardless of exit code. Disable only if you intentionally run short-lived processes."
            checked={pm2Opts.autorestart}
            onChange={(v) => setOpt('autorestart', v)}
          />
          <div className="deploy-two-col">
            <Field label="Max memory restart" hint="Restart the process when its heap exceeds this value, e.g. 200M or 1G. Leave blank to disable memory-based restarts.">
              <input
                className="settings-input"
                type="text"
                placeholder="200M"
                value={pm2Opts.max_memory_restart}
                onChange={(e) => setOpt('max_memory_restart', e.target.value)}
              />
            </Field>
            <Field label="Max restarts" hint="Maximum consecutive restarts before PM2 considers the app errored and stops retrying. PM2 resets this counter after the process has been stable for min_uptime.">
              <input
                className="settings-input"
                type="number"
                min="0"
                value={pm2Opts.max_restarts}
                onChange={(e) => setOpt('max_restarts', e.target.value)}
              />
            </Field>
          </div>
          <div className="deploy-two-col">
            <Field label="Restart delay (ms)" hint="Milliseconds to wait between consecutive restart attempts. Use this to avoid hammering a downstream dependency on repeated crashes.">
              <input
                className="settings-input"
                type="number"
                min="0"
                value={pm2Opts.restart_delay}
                onChange={(e) => setOpt('restart_delay', e.target.value)}
              />
            </Field>
            <Field label="Min uptime (ms)" hint="Minimum time in ms the process must stay up to be counted as a stable start. If it exits before this threshold the restart counter increments. Leave blank for PM2 default.">
              <input
                className="settings-input"
                type="number"
                min="0"
                placeholder="1000"
                value={pm2Opts.min_uptime}
                onChange={(e) => setOpt('min_uptime', e.target.value)}
              />
            </Field>
          </div>
          <div className="deploy-two-col">
            <Field label="Kill timeout (ms)" hint="Milliseconds PM2 waits for the process to exit after sending SIGINT before escalating to SIGKILL. Increase if your app needs more time for graceful shutdown.">
              <input
                className="settings-input"
                type="number"
                min="0"
                value={pm2Opts.kill_timeout}
                onChange={(e) => setOpt('kill_timeout', e.target.value)}
              />
            </Field>
            <Field label="Cron restart" hint="Schedule automatic restarts using a cron expression, e.g. 0 2 * * * restarts every night at 2 AM. Leave blank to disable.">
              <input
                className="settings-input"
                type="text"
                placeholder="0 2 * * *"
                value={pm2Opts.cron_restart}
                onChange={(e) => setOpt('cron_restart', e.target.value)}
              />
            </Field>
          </div>
          <Toggle
            label="Wait for ready signal"
            hint="Delay the end of the startup sequence until the app calls process.send('ready'). Useful when your app performs async initialisation (e.g. DB connection) before it is truly ready to serve traffic."
            checked={pm2Opts.wait_ready}
            onChange={(v) => setOpt('wait_ready', v)}
          />
          {pm2Opts.wait_ready && (
            <Field label="Listen timeout (ms)" hint="Maximum milliseconds to wait for the ready signal. If the signal is not received within this time PM2 considers the start a failure.">
              <input
                className="settings-input"
                type="number"
                min="0"
                value={pm2Opts.listen_timeout}
                onChange={(e) => setOpt('listen_timeout', e.target.value)}
              />
            </Field>
          )}
          <Toggle
            label="Shutdown with message"
            hint="Send process.send('shutdown') to the app instead of SIGINT when stopping. Use this if your app listens for the IPC shutdown message to trigger its graceful teardown sequence."
            checked={pm2Opts.shutdown_with_message}
            onChange={(v) => setOpt('shutdown_with_message', v)}
          />
        </Section>

        {/* Logging */}
        <Section
          title="Logging"
          info="Controls how PM2 writes log files for this process. The timestamp prefix is strongly recommended because pm2-hawkeye uses timestamps to sort and deduplicate log lines across stdout and stderr."
        >
          <Toggle
            label="Timestamp prefix"
            hint="Prefix every log line with an ISO timestamp. Required for pm2-hawkeye's chronological log sorting to work correctly. Strongly recommended."
            checked={pm2Opts.time}
            onChange={(v) => setOpt('time', v)}
          />
          <Toggle
            label="Combine stdout and stderr"
            hint="Write stdout and stderr to a single log file instead of separate files. Useful if your app does not distinguish between the two streams."
            checked={pm2Opts.combine_logs}
            onChange={(v) => setOpt('combine_logs', v)}
          />
          <div className="deploy-two-col">
            <Field label="Stdout log file" hint="Custom absolute path for the stdout log. Leave blank to use the PM2 default (~/.pm2/logs/name-out.log).">
              <input
                className="settings-input"
                type="text"
                placeholder="/var/log/my-app/out.log"
                value={pm2Opts.out_file}
                onChange={(e) => setOpt('out_file', e.target.value)}
              />
            </Field>
            <Field label="Stderr log file" hint="Custom absolute path for the stderr log. Leave blank to use the PM2 default (~/.pm2/logs/name-error.log).">
              <input
                className="settings-input"
                type="text"
                placeholder="/var/log/my-app/error.log"
                value={pm2Opts.error_file}
                onChange={(e) => setOpt('error_file', e.target.value)}
              />
            </Field>
          </div>
        </Section>

        {/* File watching */}
        <Section
          title="File Watching"
          info="PM2 can watch the filesystem and restart your app automatically when source files change. This is useful during development but should generally be disabled in production."
        >
          <Toggle
            label="Watch for file changes"
            hint="Restart the app automatically whenever a watched file changes. Not recommended for production deployments."
            checked={pm2Opts.watch}
            onChange={(v) => setOpt('watch', v)}
          />
          {pm2Opts.watch && (
            <Field label="Ignore watch patterns" hint="Files or directories to exclude from watching, one pattern per line. node_modules is excluded by default.">
              <textarea
                className="settings-input"
                rows={3}
                value={pm2Opts.ignore_watch}
                onChange={(e) => setOpt('ignore_watch', e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', resize: 'vertical' }}
              />
            </Field>
          )}
        </Section>

        {/* Advanced */}
        <Section
          title="Advanced"
          info="Low-level PM2 options. The defaults are suitable for almost all Node.js applications."
        >
          <Toggle
            label="Source map support"
            hint="Enable Node.js source map support so that stack traces from transpiled TypeScript or bundled code point to the original source lines."
            checked={pm2Opts.source_map_support}
            onChange={(v) => setOpt('source_map_support', v)}
          />
        </Section>

      </form>

      <div className="deploy-action-row">
        <button type="submit" form="deploy-form" className="deploy-submit-btn" disabled={submitting}>
          {submitting
            ? (isEdit ? 'Saving...' : 'Starting deployment...')
            : (isEdit ? 'Save changes' : 'Deploy')}
        </button>
        {isEdit && (
          <button
            type="button"
            className="deploy-redeploy-btn"
            disabled={submitting}
            onClick={onRedeployClick}
          >
            {submitting ? 'Saving...' : 'Save & Redeploy'}
          </button>
        )}
        {error && <span className="deploy-error-msg">{error}</span>}
      </div>
    </>
  );
}

// View B: Progress log ───────────────────────────────────────────────────────

/**
 * Real-time deployment progress view.
 *
 * @param {{
 *   lines: { stage: string, line: string, status: string }[],
 *   currentStage: string,
 *   status: string,
 *   visibleStages: string[],
 *   onClose: () => void,
 * }} props
 */
/**
 * @param {{
 *   lines: { stage: string, line: string, status: string }[],
 *   currentStage: string | null,
 *   status: string | null,
 *   visibleStages: string[],
 *   onClose: () => void,
 *   confirmChanges: string | null,
 *   onConfirmDeploy: (confirmed: boolean) => void,
 * }} props
 */
function DeployProgress({ lines, currentStage, status, visibleStages, onClose, confirmChanges, onConfirmDeploy }) {
  const logRef = useRef(null);
  const isDone = currentStage === 'done' && status === 'success';
  const isError = status === 'error';
  const isConfirming = status === 'confirm';

  // Auto-scroll as new lines arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <>
      <div className="deploy-modal-body">
        <StagePillBar visibleStages={visibleStages} currentStage={currentStage} status={status} />

        <div className="deploy-log" ref={logRef}>
          {lines.map((entry, i) => (
            <span key={i} className={entry.status === 'error' ? 'deploy-log-line--error' : undefined}>
              {entry.line}
            </span>
          ))}
          {!isDone && !isError && !isConfirming && <span style={{ color: 'var(--muted)' }}>...</span>}
        </div>

        {isConfirming && confirmChanges && (
          <div className="deploy-confirm-box">
            <p className="deploy-confirm-msg">
              The deploy directory has local changes that would prevent <code>git pull</code> from succeeding.
              Discard them to continue, or cancel the deployment.
            </p>
            <pre className="deploy-confirm-changes">{confirmChanges}</pre>
            <div className="deploy-confirm-actions">
              <button type="button" className="deploy-submit-btn" onClick={() => onConfirmDeploy(true)}>
                Discard &amp; Continue
              </button>
              <button type="button" className="deploy-cancel-btn" onClick={() => onConfirmDeploy(false)}>
                Cancel Deployment
              </button>
            </div>
          </div>
        )}

        {isDone && (
          <div className="deploy-success-banner">
            Deployment complete. The process is now running in PM2 and visible in the sidebar.
          </div>
        )}
        {isError && (
          <div className="deploy-error-banner">
            Deployment failed. See the log above for details. Fix the issue and use Redeploy to retry.
          </div>
        )}
      </div>

      {(isDone || isError) && (
        <div className="deploy-action-row">
          <button type="button" className="deploy-submit-btn" onClick={onClose}>Close</button>
        </div>
      )}
    </>
  );
}

// Main modal ─────────────────────────────────────────────────────────────────

/**
 * Deploy modal.
 *
 * Shows a form for configuring a new deployment.  Once submitted, switches to
 * a real-time progress view that receives output via WebSocket messages
 * forwarded from the parent component.
 *
 * When `editingDeployment` is provided the modal opens in edit mode: the form
 * is pre-filled, the app name is read-only, and saving issues a PUT request.
 * No progress view is shown after a successful edit -- the modal closes immediately
 * via `onEditSaved`.
 *
 * @param {{
 *   csrfToken: string,
 *   onClose: () => void,
 *   onDeployStarted: (deploymentId: string) => void,
 *   deployProgressLines: { stage: string, line: string, status: string }[],
 *   deployProgressStage: string | null,
 *   deployProgressStatus: string | null,
 *   activeDeploymentId: string | null,
 *   editingDeployment?: object | null,
 *   onEditSaved?: () => Promise<void>,
 *   onSaveAndRedeploy?: (deploymentId: string) => Promise<void>,
 *   onCsrfRefresh: () => Promise<string>,
 *   confirmChanges?: string | null,
 *   onConfirmDeploy?: (confirmed: boolean) => void,
 * }} props
 */
export default function DeployModal({
  csrfToken,
  onCsrfRefresh,
  onClose,
  onDeployStarted,
  deployProgressLines,
  deployProgressStage,
  deployProgressStatus,
  activeDeploymentId,
  editingDeployment,
  onEditSaved,
  onSaveAndRedeploy,
  confirmChanges,
  onConfirmDeploy,
}) {
  const isEdit = Boolean(editingDeployment);
  const showProgress = !isEdit && activeDeploymentId !== null;
  const isDoneOrError = deployProgressStatus === 'success' || deployProgressStatus === 'error';

  // Visible stages: always show clone/install/start; show pre/post/build only
  // if they actually appear in the received progress lines.
  const visibleStages = ALL_STAGES.filter(
    (s) =>
      s === 'clone' || s === 'install' || s === 'start' ||
      (deployProgressLines || []).some((l) => l.stage === s),
  );

  let title = 'Deploy from GitHub';
  if (isEdit) title = 'Edit Deployment';
  else if (showProgress) title = 'Deployment Progress';

  return (
    <div className="deploy-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="deploy-modal">
        <div className="deploy-modal-header">
          <h2>{title}</h2>
          {(!showProgress || isDoneOrError) && (
            <button type="button" onClick={onClose}>Close</button>
          )}
        </div>

        {showProgress ? (
          <DeployProgress
            lines={deployProgressLines}
            currentStage={deployProgressStage}
            status={deployProgressStatus}
            visibleStages={visibleStages}
            onClose={onClose}
            confirmChanges={confirmChanges}
            onConfirmDeploy={onConfirmDeploy}
          />
        ) : (
          <DeployForm
            csrfToken={csrfToken}
            onCsrfRefresh={onCsrfRefresh}
            onDeployStarted={onDeployStarted}
            editingDeployment={editingDeployment}
            onEditSaved={onEditSaved}
            onSaveAndRedeploy={onSaveAndRedeploy}
          />
        )}
      </div>
    </div>
  );
}

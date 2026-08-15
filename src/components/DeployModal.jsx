/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../services/api.js';
import { CheckCircle, Plus, WarningCircle, X } from './Icon.jsx';

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
 * A collapsible group of optional fields.
 *
 * The form used to be an eight-step wizard with prev/next pagination and a
 * "1 of 8" counter, even though six of those steps were entirely optional and
 * most deployments only need three fields. Everything is now on one page, with
 * the optional groups folded away until they are wanted.
 *
 * @param {{ title: string, summary: string, defaultOpen?: boolean, children: React.ReactNode }} props
 */
function Fieldset({ title, summary, defaultOpen = false, children }) {
  return (
    <details className="deploy-fieldset" open={defaultOpen}>
      <summary>
        <span className="deploy-fieldset-title">{title}</span>
        <span className="deploy-fieldset-summary">{summary}</span>
      </summary>
      <div className="deploy-fieldset-body">{children}</div>
    </details>
  );
}

/**
 * Labelled form field with an optional hint below the input.
 *
 * @param {{ label: string, hint?: string, required?: boolean, children: React.ReactNode }} props
 */
function Field({ label, hint, required, children }) {
  return (
    <div className="field">
      <label>
        {label}
        {required && (
          <span className="field-req" aria-label="required">
            *
          </span>
        )}
      </label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/**
 * Toggle switch row with a description.
 *
 * @param {{ label: string, hint?: string, checked: boolean, onChange: (v: boolean) => void }} props
 */
function Toggle({ label, hint, checked, onChange }) {
  return (
    <div className="deploy-toggle-row">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="toggle-track" />
        <span className="toggle-label">{label}</span>
      </label>
      {hint && <p className="hint">{hint}</p>}
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
    if (currentStage === 'error') return idx <= curIdx ? ' is-error' : '';
    if (currentStage === 'done') return ' is-done';
    if (idx < curIdx) return ' is-done';
    if (idx === curIdx) return status === 'error' ? ' is-error' : ' is-active';
    return '';
  };

  return (
    <ol className="deploy-stages">
      {visibleStages.map((stage) => (
        <li key={stage} className={`deploy-stage${pillState(stage)}`}>
          {STAGE_LABELS[stage]}
        </li>
      ))}
    </ol>
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
 *   onCsrfRefresh: () => Promise<string>,
 *   onDeployStarted: (id: string) => void,
 *   editingDeployment?: object | null,
 *   onEditSaved?: () => Promise<void>,
 *   onSaveAndRedeploy?: (deploymentId: string) => Promise<void>,
 * }} props
 */
function DeployForm({ onCsrfRefresh, onDeployStarted, editingDeployment, onEditSaved, onSaveAndRedeploy }) {
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
        ? pm2Opts.ignore_watch
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
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
  }, [
    envVars,
    pm2Opts,
    repoUrl,
    branch,
    startScript,
    installCmd,
    installArgs,
    buildCmd,
    preSetupScript,
    postSetupScript,
  ]);

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
      <form id="deploy-form" className="deploy-body" onSubmit={onSubmit}>
        {/* ── Required ─────────────────────────────────────────────────── */}
        <section className="deploy-required">
          <p className="hint">
            Hawkeye clones the repository into the deploy base directory and starts it under PM2. On a redeploy it
            runs git pull instead of cloning again.
          </p>

          <div className="deploy-two-col">
            <Field
              label="App name"
              required={!isEdit}
              hint={
                isEdit
                  ? 'Tied to the deploy path, so it cannot change after the first deployment.'
                  : 'PM2 process name, and the directory name under the deploy base path.'
              }
            >
              <input
                className="input"
                type="text"
                required={!isEdit}
                placeholder="my-api"
                value={appName}
                readOnly={isEdit}
                onChange={isEdit ? undefined : (e) => setAppName(e.target.value)}
              />
            </Field>
            <Field label="Branch" hint="Cloned and pulled from on each deploy.">
              <input
                className="input"
                type="text"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Repository URL" required hint="HTTPS or SSH. Private repos need a key on the server.">
            <input
              className="input"
              type="text"
              required
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </Field>

          <Field label="Start script" required hint="Entry point relative to the repo root.">
            <input
              className="input"
              type="text"
              required
              placeholder="index.js"
              value={startScript}
              onChange={(e) => setStartScript(e.target.value)}
            />
          </Field>
        </section>

        {/* ── Optional ─────────────────────────────────────────────────── */}
        <Fieldset title="Install and build" summary={`${installCmd}${buildCmd ? `, ${buildCmd}` : ''}`}>
          <Field label="Install command" hint="Run after cloning to install dependencies.">
            <select className="select" value={installCmd} onChange={(e) => setInstallCmd(e.target.value)}>
              <option value="npm install">npm install</option>
              <option value="npm ci">npm ci</option>
              <option value="yarn">yarn</option>
              <option value="yarn install">yarn install</option>
              <option value="pnpm install">pnpm install</option>
              <option value="skip">Skip installing</option>
            </select>
          </Field>
          {installCmd !== 'skip' && (
            <Field label="Extra install flags" hint="Appended to the install command.">
              <input
                className="input"
                type="text"
                placeholder="--prod"
                value={installArgs}
                onChange={(e) => setInstallArgs(e.target.value)}
              />
            </Field>
          )}
          <Field label="Build command" hint="Optional step after installing. Leave blank to skip.">
            <input
              className="input"
              type="text"
              placeholder="npm run build"
              value={buildCmd}
              onChange={(e) => setBuildCmd(e.target.value)}
            />
          </Field>
          <Field
            label="Pre-setup script"
            hint="Shell script run in the deploy base directory before cloning. Use it to check that required tools exist."
          >
            <textarea
              className="textarea"
              rows={3}
              placeholder={'#!/bin/sh\nwhich ffmpeg || exit 1'}
              value={preSetupScript}
              onChange={(e) => setPreSetupScript(e.target.value)}
            />
          </Field>
          <Field
            label="Post-setup script"
            hint="Shell script run inside the repo after building and before PM2 starts. Use it for migrations."
          >
            <textarea
              className="textarea"
              rows={3}
              placeholder={'#!/bin/sh\nnode scripts/migrate.js'}
              value={postSetupScript}
              onChange={(e) => setPostSetupScript(e.target.value)}
            />
          </Field>
        </Fieldset>

        <Fieldset
          title="Environment"
          summary={
            envVars.filter((v) => v.key.trim()).length
              ? `${envVars.filter((v) => v.key.trim()).length} variable(s)`
              : 'None set'
          }
        >
          <Field
            label="Env file"
            hint="Path to a .env file, relative to the repo root or absolute on the server. Read on every deploy."
          >
            <input
              className="input"
              type="text"
              placeholder=".env.production"
              value={pm2Opts.env_file}
              onChange={(e) => setOpt('env_file', e.target.value)}
            />
          </Field>
          <div className="field">
            <label>Variables</label>
            <p className="hint">Set here, these override anything loaded from the env file above.</p>
            {envVars.map((row, i) => (
              <div className="kv-row" key={i}>
                <input
                  className="input"
                  type="text"
                  placeholder="KEY"
                  aria-label={`Variable name ${i + 1}`}
                  value={row.key}
                  onChange={(e) => updateEnvVar(i, 'key', e.target.value)}
                />
                <input
                  className="input"
                  type="text"
                  placeholder="value"
                  aria-label={`Variable value ${i + 1}`}
                  value={row.value}
                  onChange={(e) => updateEnvVar(i, 'value', e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => removeEnvVar(i)}
                  aria-label={`Remove variable ${i + 1}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button type="button" className="btn btn--sm" onClick={addEnvVar}>
              <Plus size={12} weight="bold" />
              Add variable
            </button>
          </div>
        </Fieldset>

        <Fieldset
          title="How PM2 runs it"
          summary={`${pm2Opts.exec_mode}, ${pm2Opts.instances} instance${Number(pm2Opts.instances) === 1 ? '' : 's'}`}
        >
          <div className="deploy-two-col">
            <Field label="Interpreter" hint="Leave as node for standard Node.js.">
              <input
                className="input"
                type="text"
                placeholder="node"
                value={pm2Opts.interpreter}
                onChange={(e) => setOpt('interpreter', e.target.value)}
              />
            </Field>
            <Field label="Interpreter args" hint="Flags passed to Node before the script.">
              <input
                className="input"
                type="text"
                placeholder="--max-old-space-size=4096"
                value={pm2Opts.interpreter_args}
                onChange={(e) => setOpt('interpreter_args', e.target.value)}
              />
            </Field>
          </div>
          <Field label="Script args" hint="Arguments forwarded to your application.">
            <input
              className="input"
              type="text"
              placeholder="--port 8080"
              value={pm2Opts.args}
              onChange={(e) => setOpt('args', e.target.value)}
            />
          </Field>
          <div className="deploy-two-col">
            <Field label="Exec mode" hint="Cluster spawns several workers sharing one port.">
              <select className="select" value={pm2Opts.exec_mode} onChange={(e) => setOpt('exec_mode', e.target.value)}>
                <option value="fork">fork</option>
                <option value="cluster">cluster</option>
              </select>
            </Field>
            <Field label="Instances" hint="Use -1 for one per CPU core. Above 1 needs cluster mode.">
              <input
                className="input"
                type="number"
                min="-1"
                value={pm2Opts.instances}
                onChange={(e) => setOpt('instances', e.target.value)}
              />
            </Field>
          </div>
          <Toggle
            label="Source map support"
            hint="Stack traces from transpiled code point at the original source lines."
            checked={pm2Opts.source_map_support}
            onChange={(v) => setOpt('source_map_support', v)}
          />
        </Fieldset>

        <Fieldset
          title="Crash recovery"
          summary={pm2Opts.autorestart ? `Auto-restart, max ${pm2Opts.max_restarts}` : 'Auto-restart off'}
        >
          <Toggle
            label="Restart on crash"
            hint="Restart whenever the process exits, whatever the exit code."
            checked={pm2Opts.autorestart}
            onChange={(v) => setOpt('autorestart', v)}
          />
          <div className="deploy-two-col">
            <Field label="Restart above memory" hint="For example 200M or 1G. Blank disables this.">
              <input
                className="input"
                type="text"
                placeholder="200M"
                value={pm2Opts.max_memory_restart}
                onChange={(e) => setOpt('max_memory_restart', e.target.value)}
              />
            </Field>
            <Field label="Max consecutive restarts" hint="After this many, PM2 marks the app errored.">
              <input
                className="input"
                type="number"
                min="0"
                value={pm2Opts.max_restarts}
                onChange={(e) => setOpt('max_restarts', e.target.value)}
              />
            </Field>
          </div>
          <div className="deploy-two-col">
            <Field label="Delay between restarts (ms)" hint="Avoids hammering a downstream dependency.">
              <input
                className="input"
                type="number"
                min="0"
                value={pm2Opts.restart_delay}
                onChange={(e) => setOpt('restart_delay', e.target.value)}
              />
            </Field>
            <Field label="Minimum uptime (ms)" hint="Below this, a start counts as a failure.">
              <input
                className="input"
                type="number"
                min="0"
                placeholder="1000"
                value={pm2Opts.min_uptime}
                onChange={(e) => setOpt('min_uptime', e.target.value)}
              />
            </Field>
          </div>
          <div className="deploy-two-col">
            <Field label="Shutdown grace period (ms)" hint="Time after SIGINT before PM2 sends SIGKILL.">
              <input
                className="input"
                type="number"
                min="0"
                value={pm2Opts.kill_timeout}
                onChange={(e) => setOpt('kill_timeout', e.target.value)}
              />
            </Field>
            <Field label="Scheduled restart" hint="Cron expression. 0 2 * * * restarts nightly at 2 AM.">
              <input
                className="input"
                type="text"
                placeholder="0 2 * * *"
                value={pm2Opts.cron_restart}
                onChange={(e) => setOpt('cron_restart', e.target.value)}
              />
            </Field>
          </div>
          <Toggle
            label="Wait for a ready signal"
            hint="Startup finishes only once the app calls process.send('ready')."
            checked={pm2Opts.wait_ready}
            onChange={(v) => setOpt('wait_ready', v)}
          />
          {pm2Opts.wait_ready && (
            <Field label="Ready signal timeout (ms)" hint="Past this, the start counts as failed.">
              <input
                className="input"
                type="number"
                min="0"
                value={pm2Opts.listen_timeout}
                onChange={(e) => setOpt('listen_timeout', e.target.value)}
              />
            </Field>
          )}
          <Toggle
            label="Shut down with an IPC message"
            hint="Sends process.send('shutdown') instead of SIGINT when stopping."
            checked={pm2Opts.shutdown_with_message}
            onChange={(v) => setOpt('shutdown_with_message', v)}
          />
        </Fieldset>

        <Fieldset
          title="Logging and file watching"
          summary={`${pm2Opts.time ? 'Timestamps on' : 'Timestamps off'}, ${pm2Opts.watch ? 'watching' : 'not watching'}`}
        >
          <Toggle
            label="Timestamp every log line"
            hint="Required for Hawkeye to sort stdout and stderr chronologically. Keep this on."
            checked={pm2Opts.time}
            onChange={(v) => setOpt('time', v)}
          />
          <Toggle
            label="Combine stdout and stderr"
            hint="Writes both streams to one file."
            checked={pm2Opts.combine_logs}
            onChange={(v) => setOpt('combine_logs', v)}
          />
          <div className="deploy-two-col">
            <Field label="Stdout file" hint="Blank uses the PM2 default.">
              <input
                className="input"
                type="text"
                placeholder="/var/log/my-app/out.log"
                value={pm2Opts.out_file}
                onChange={(e) => setOpt('out_file', e.target.value)}
              />
            </Field>
            <Field label="Stderr file" hint="Blank uses the PM2 default.">
              <input
                className="input"
                type="text"
                placeholder="/var/log/my-app/error.log"
                value={pm2Opts.error_file}
                onChange={(e) => setOpt('error_file', e.target.value)}
              />
            </Field>
          </div>
          <Toggle
            label="Restart on file changes"
            hint="Useful in development, generally wrong in production."
            checked={pm2Opts.watch}
            onChange={(v) => setOpt('watch', v)}
          />
          {pm2Opts.watch && (
            <Field label="Ignore these paths" hint="One pattern per line.">
              <textarea
                className="textarea"
                rows={3}
                value={pm2Opts.ignore_watch}
                onChange={(e) => setOpt('ignore_watch', e.target.value)}
              />
            </Field>
          )}
        </Fieldset>
      </form>

      <div className="modal-footer">
        {error && (
          <span className="action-result" data-ok="false">
            <WarningCircle size={13} weight="fill" />
            <span>{error}</span>
          </span>
        )}
        <span className="modal-footer-spacer" />
        {isEdit && (
          <button type="button" className="btn" disabled={submitting} onClick={onRedeployClick}>
            {submitting ? 'Saving' : 'Save and redeploy'}
          </button>
        )}
        <button type="submit" form="deploy-form" className="btn btn--primary" disabled={submitting}>
          {submitting ? (isEdit ? 'Saving' : 'Starting') : isEdit ? 'Save changes' : 'Deploy'}
        </button>
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
  const confirmRef = useRef(null);
  const isDone = currentStage === 'done' && status === 'success';
  const isError = status === 'error';
  const isConfirming = status === 'confirm';

  // Auto-scroll log as new lines arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Scroll the confirm box into view whenever it appears.
  useEffect(() => {
    if (isConfirming && confirmRef.current) {
      confirmRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isConfirming]);

  return (
    <>
      <div className="deploy-body">
        <StagePillBar visibleStages={visibleStages} currentStage={currentStage} status={status} />

        {isConfirming && confirmChanges && (
          <div className="deploy-confirm" ref={confirmRef}>
            <p>
              The deploy directory has local changes, so <code>git pull</code> cannot run. Discard them to continue,
              or cancel the deployment.
            </p>
            <pre className="code-preview">{confirmChanges}</pre>
            <div className="deploy-confirm-actions">
              <button type="button" className="btn btn--danger" onClick={() => onConfirmDeploy(true)}>
                Discard and continue
              </button>
              <button type="button" className="btn" onClick={() => onConfirmDeploy(false)}>
                Cancel deployment
              </button>
            </div>
          </div>
        )}

        <div className="deploy-log" ref={logRef}>
          {lines.map((entry, i) => (
            <span key={i} className={entry.status === 'error' ? 'deploy-log-line--error' : undefined}>
              {entry.line}
            </span>
          ))}
          {!isDone && !isError && !isConfirming && <span className="deploy-log-waiting">Working</span>}
        </div>

        {isDone && (
          <div className="action-result" data-ok="true">
            <CheckCircle size={13} weight="fill" />
            <span>Deployed. The process is running in PM2 and appears in the sidebar.</span>
          </div>
        )}
        {isError && (
          <div className="action-result" data-ok="false">
            <WarningCircle size={13} weight="fill" />
            <span>Deployment failed. Fix the cause above, then use Redeploy to retry.</span>
          </div>
        )}
      </div>

      {(isDone || isError) && (
        <div className="modal-footer">
          <span className="modal-footer-spacer" />
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
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
    (s) => s === 'clone' || s === 'install' || s === 'start' || (deployProgressLines || []).some((l) => l.stage === s),
  );

  let title = 'Deploy from Git';
  if (isEdit) title = `Edit ${editingDeployment.pm2_name}`;
  else if (showProgress) title = 'Deploying';

  return (
    <div
      className="overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal modal--deploy">
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          {(!showProgress || isDoneOrError) && (
            <button type="button" className="btn btn--icon" aria-label="Close" onClick={onClose}>
              <X size={15} />
            </button>
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

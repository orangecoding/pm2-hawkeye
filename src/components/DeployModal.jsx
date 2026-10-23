/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { cloneElement, isValidElement, useCallback, useId, useRef, useState } from 'react';
import { fetchWithCsrf } from '../services/api.js';
import { deriveAppName, normalizePm2Number, planDeploy, pm2Summary } from '../services/deployment.js';
import { useDialogFocus } from '../services/dialog.js';
import KeyValueList from './KeyValueList.jsx';
import { StepList } from './DeployPanel.jsx';
import { ArrowClockwise, CaretRight, RocketLaunch, WarningCircle, X } from './Icon.jsx';

/** Default branch-watch poll interval in minutes, mirroring the backend default. */
const DEFAULT_WATCH_INTERVAL_MINUTES = 5;

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
 * One row of the Options list: a disclosure whose summary states the current
 * value, so the form can be read at a glance without opening anything.
 *
 * @param {{ title: string, summary: string, defaultOpen?: boolean, children: React.ReactNode }} props
 */
function Option({ title, summary, defaultOpen = false, children }) {
  return (
    <details className="deploy-option" open={defaultOpen}>
      <summary>
        <CaretRight size={12} className="deploy-option-caret" />
        <span className="deploy-option-title">{title}</span>
        <span className="deploy-option-summary">{summary}</span>
      </summary>
      <div className="deploy-option-body">{children}</div>
    </details>
  );
}

/**
 * A numbered section of the form.
 *
 * @param {{ number: number, title: string, note?: string, quiet?: boolean, children: React.ReactNode }} props -
 *   `quiet` draws the number in neutral colours, for the optional section.
 */
function Section({ number, title, note, quiet = false, children }) {
  return (
    <fieldset className="deploy-section">
      <legend>
        <span className="deploy-section-number" data-quiet={quiet}>
          {number}
        </span>
        {title}
        {note && <span className="deploy-section-note">{note}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

/** Install commands the form offers in its select, see the Install command field. */
const INSTALL_BASES = ['npm install', 'npm ci', 'yarn install', 'yarn', 'pnpm install', 'skip'];

/**
 * Split a stored install command into one of the {@link INSTALL_BASES} and the
 * extra flags saved after it, e.g. `npm install --prod`. A command that starts
 * with none of them is kept whole as the base.
 *
 * @param {string|null} [stored] - Saved command; empty means `npm install`.
 * @returns {{ base: string, args: string }}
 */
function splitInstallCmd(stored) {
  stored ??= 'npm install';
  const base = INSTALL_BASES.find((b) => stored === b || stored.startsWith(b + ' '));
  if (!base) return { base: stored, args: '' };
  return { base, args: stored.length > base.length ? stored.slice(base.length + 1) : '' };
}

/**
 * Labelled form field with an optional hint below the input.
 *
 * The label is tied to the control through a generated id, so clicking it
 * focuses the control and screen readers announce the label and the hint.
 *
 * @param {{ label: string, hint?: string, required?: boolean, children: React.ReactElement }} props
 */
function Field({ label, hint, required, children }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-describedby': hint ? hintId : undefined })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="field-req" aria-label="required">
            *
          </span>
        )}
      </label>
      {control}
      {hint && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
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

// Deploy form ─────────────────────────────────────────────────────────────────

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
 * The steps the preview column lists, built from the live form state.
 *
 * @param {object} draft - The form state in the shape of a deployment record.
 * @param {{ firstDeploy: boolean, name: string }} opts - `firstDeploy` is true
 *   for a new deployment and for one that never deployed successfully, since
 *   the runner clones whenever the deploy folder holds no repository yet.
 * @returns {{ stage: string, title: string, skipped: boolean, code: string, note: string }[]}
 */
function previewSteps(draft, { firstDeploy, name }) {
  return planDeploy(draft, { firstDeploy })
    .filter((step) => ['clone', 'install', 'build', 'start'].includes(step.stage))
    .map((step) => {
      let note = '';
      if (step.stage === 'clone' && !firstDeploy) note = 'Untracked files such as .env stay';
      if (step.stage === 'install' && step.skipped) note = 'Skipped';
      if (step.stage === 'build' && step.skipped) note = 'Skipped, no build command';
      if (step.stage === 'start') note = `as ${name}, ${pm2Summary(draft.pm2_options)}`;
      return { ...step, note };
    });
}

/**
 * Deploy modal: the configuration form for a new deployment or for editing
 * one, with a preview of what the deployment will run next to it. The
 * deployment's progress is not shown here; it runs in the Deploy tab.
 *
 * When `editingDeployment` is provided the form pre-fills with existing values,
 * the app name becomes read-only, and saving issues a PUT instead of a POST.
 *
 * For a new deployment the app name follows the repository URL until the user
 * types in it. The preview re-renders on every keystroke from the form state,
 * not from the saved record.
 *
 * @param {{
 *   onClose: () => void,
 *   onCsrfRefresh: () => Promise<string>,
 *   onDeployStarted: (deploymentId: string) => void,
 *   editingDeployment?: object | null,
 *   onEditSaved?: () => Promise<void>,
 *   onSaveAndRedeploy?: (deploymentId: string) => Promise<void>,
 *   deployBaseDir?: string,
 * }} props - `deployBaseDir` is the absolute folder new deployments are
 *   cloned into, from the session config.
 */
export default function DeployModal({
  onClose,
  onCsrfRefresh,
  onDeployStarted,
  editingDeployment,
  onEditSaved,
  onSaveAndRedeploy,
  deployBaseDir,
}) {
  const isEdit = Boolean(editingDeployment);
  /** Whether the next run clones: a new deployment, or one that never deployed successfully. */
  const firstDeploy = !isEdit || editingDeployment.last_deployed_at == null;
  const modalRef = useRef(null);
  const titleId = useId();
  useDialogFocus(modalRef, onClose);

  const [appName, setAppName] = useState(() => editingDeployment?.pm2_name ?? '');
  /** False while the app name still follows the repository URL. */
  const [appNameTouched, setAppNameTouched] = useState(isEdit);
  const [repoUrl, setRepoUrl] = useState(() => editingDeployment?.repo_url ?? '');
  const [branch, setBranch] = useState(() => editingDeployment?.branch ?? 'master');
  const [startScript, setStartScript] = useState(() => editingDeployment?.start_script ?? 'index.js');
  const [installCmd, setInstallCmd] = useState(() => splitInstallCmd(editingDeployment?.install_cmd).base);
  const [installArgs, setInstallArgs] = useState(() => splitInstallCmd(editingDeployment?.install_cmd).args);
  const [buildCmd, setBuildCmd] = useState(() => editingDeployment?.build_cmd ?? '');
  const [preSetupScript, setPreSetupScript] = useState(() => editingDeployment?.pre_setup_script ?? '');
  const [postSetupScript, setPostSetupScript] = useState(() => editingDeployment?.post_setup_script ?? '');
  const [envVars, setEnvVars] = useState(() =>
    isEdit ? envObjToRows(editingDeployment.env_vars) : [{ key: '', value: '' }],
  );
  const [pm2Opts, setPm2Opts] = useState(() =>
    isEdit ? pm2OptsFromStored(editingDeployment.pm2_options) : { ...DEFAULT_PM2_OPTIONS },
  );
  const [watchEnabled, setWatchEnabled] = useState(() => Boolean(editingDeployment?.watch_enabled));
  const [watchIntervalMinutes, setWatchIntervalMinutes] = useState(
    () => editingDeployment?.watch_interval_minutes ?? DEFAULT_WATCH_INTERVAL_MINUTES,
  );
  const [discardLocalChanges, setDiscardLocalChanges] = useState(() =>
    Boolean(editingDeployment?.discard_local_changes),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const setOpt = (key, val) => setPm2Opts((prev) => ({ ...prev, [key]: val }));

  const addEnvVar = () => setEnvVars((prev) => [...prev, { key: '', value: '' }]);
  const removeEnvVar = (i) => setEnvVars((prev) => prev.filter((_, idx) => idx !== i));
  const updateEnvVar = (i, field, val) =>
    setEnvVars((prev) => prev.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  const name = appNameTouched ? appName : deriveAppName(repoUrl);
  const shownName = name.trim() || 'my-app';
  const envCount = envVars.filter((v) => v.key.trim()).length;
  const fullInstallCmd = installArgs.trim() ? `${installCmd} ${installArgs.trim()}` : installCmd;

  /** Build the shared payload object from current form state. */
  const buildPayload = useCallback(() => {
    const envVarsObj = {};
    for (const { key, value } of envVars) {
      if (key.trim()) envVarsObj[key.trim()] = value;
    }
    const pm2Options = {
      ...pm2Opts,
      instances: normalizePm2Number(pm2Opts.instances, 1),
      max_restarts: normalizePm2Number(pm2Opts.max_restarts, 10),
      restart_delay: normalizePm2Number(pm2Opts.restart_delay, 0),
      kill_timeout: normalizePm2Number(pm2Opts.kill_timeout, 1600),
      listen_timeout: normalizePm2Number(pm2Opts.listen_timeout, 3000),
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
      branch: branch.trim() || 'master',
      startScript: startScript.trim() || 'index.js',
      installCmd: fullInstallCmd,
      buildCmd: buildCmd.trim(),
      preSetupScript: preSetupScript.trim(),
      postSetupScript: postSetupScript.trim(),
      envVars: envVarsObj,
      pm2Options,
      watchEnabled,
      watchIntervalMinutes: Number(watchIntervalMinutes) || DEFAULT_WATCH_INTERVAL_MINUTES,
      discardLocalChanges,
    };
  }, [
    envVars,
    pm2Opts,
    repoUrl,
    branch,
    startScript,
    fullInstallCmd,
    buildCmd,
    preSetupScript,
    postSetupScript,
    watchEnabled,
    watchIntervalMinutes,
    discardLocalChanges,
  ]);

  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setError('');
      setSubmitting(true);

      try {
        if (isEdit) {
          await fetchWithCsrf(`/api/deployments/${editingDeployment.id}`, {
            onCsrfRefresh,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload()),
          });
          if (onEditSaved) await onEditSaved();
        } else {
          const result = await fetchWithCsrf('/api/deployments', {
            onCsrfRefresh,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appName: name.trim(), ...buildPayload() }),
          });
          await onDeployStarted(result.deploymentId);
        }
      } catch (err) {
        setError(err.message);
        setSubmitting(false);
      }
    },
    [isEdit, editingDeployment, name, buildPayload, onCsrfRefresh, onDeployStarted, onEditSaved],
  );

  /**
   * Save current config (PUT) then hand off to the parent to trigger a
   * redeploy. Only available in edit mode.
   */
  const onRedeployClick = useCallback(async () => {
    if (!modalRef.current?.querySelector('form')?.reportValidity()) return;
    setError('');
    setSubmitting(true);
    try {
      await fetchWithCsrf(`/api/deployments/${editingDeployment.id}`, {
        onCsrfRefresh,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (onSaveAndRedeploy) await onSaveAndRedeploy(editingDeployment.id);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }, [editingDeployment, onCsrfRefresh, buildPayload, onSaveAndRedeploy]);

  const draft = {
    repo_url: repoUrl.trim(),
    branch: branch.trim() || 'master',
    deploy_path: isEdit ? editingDeployment.deploy_path : `${deployBaseDir ?? '<deploy base folder>'}/${shownName}`,
    install_cmd: fullInstallCmd,
    build_cmd: buildCmd,
    start_script: startScript.trim() || 'index.js',
    pm2_options: pm2Opts,
  };

  let setupSummary = 'None';
  if (preSetupScript.trim() && postSetupScript.trim()) setupSummary = 'Pre-setup and post-setup';
  else if (preSetupScript.trim()) setupSummary = 'Pre-setup';
  else if (postSetupScript.trim()) setupSummary = 'Post-setup';

  return (
    <div
      className="overlay overlay--top"
      onClick={(e) => e.target === e.currentTarget && !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div ref={modalRef} className="modal modal--deploy" tabIndex={-1}>
        <div className="modal-header modal-header--stacked">
          <div className="modal-heading">
            <h2 id={titleId} className="modal-title">
              {isEdit ? `Edit ${editingDeployment.pm2_name}` : 'New deployment'}
            </h2>
            <p className="hint">
              {isEdit
                ? 'Changes apply on the next deploy.'
                : 'Hawkeye clones a Git repository onto this server and runs it under PM2.'}
            </p>
          </div>
          <button type="button" className="btn btn--icon" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="deploy-modal-body">
          <form id="deploy-form" className="deploy-form" onSubmit={onSubmit}>
            <Section number={1} title="Where the code comes from">
              <Field
                label="Repository URL"
                required
                hint="HTTPS or SSH. A private repository needs a deploy key on this server."
              >
                <input
                  className="input"
                  type="text"
                  required
                  placeholder="https://github.com/owner/repo"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                />
              </Field>
              <div className="deploy-grid">
                <Field label="Branch" hint="Fetched again on every redeploy.">
                  <input
                    className="input"
                    type="text"
                    placeholder="master"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </Field>
                <Field
                  label="App name"
                  required={!isEdit}
                  hint={
                    isEdit
                      ? 'Tied to the deploy path, so it cannot change after the first deployment.'
                      : 'Taken from the repository name. It becomes the PM2 process name and the folder name, and cannot change later.'
                  }
                >
                  <input
                    className="input"
                    type="text"
                    required={!isEdit}
                    placeholder="my-api"
                    value={name}
                    readOnly={isEdit}
                    onChange={
                      isEdit
                        ? undefined
                        : (e) => {
                            setAppNameTouched(true);
                            setAppName(e.target.value);
                          }
                    }
                  />
                </Field>
              </div>
            </Section>

            <Section number={2} title="How to build and start it">
              <div className="deploy-grid">
                <Field label="Install command">
                  <select className="select" value={installCmd} onChange={(e) => setInstallCmd(e.target.value)}>
                    <option value="npm install">npm install</option>
                    <option value="npm ci">npm ci</option>
                    <option value="yarn install">yarn install</option>
                    <option value="yarn">yarn</option>
                    <option value="pnpm install">pnpm install</option>
                    <option value="skip">Skip installing</option>
                  </select>
                </Field>
                {installCmd !== 'skip' && (
                  <Field label="Extra install flags">
                    <input
                      className="input"
                      type="text"
                      placeholder="--omit=dev"
                      value={installArgs}
                      onChange={(e) => setInstallArgs(e.target.value)}
                    />
                  </Field>
                )}
              </div>
              <div className="deploy-grid">
                <Field label="Build command" hint="Leave empty to skip the build step.">
                  <input
                    className="input"
                    type="text"
                    placeholder="npm run build"
                    value={buildCmd}
                    onChange={(e) => setBuildCmd(e.target.value)}
                  />
                </Field>
                <Field label="Start script" required hint="Entry point, relative to the repository root.">
                  <input
                    className="input"
                    type="text"
                    required
                    placeholder="index.js"
                    value={startScript}
                    onChange={(e) => setStartScript(e.target.value)}
                  />
                </Field>
              </div>
            </Section>

            <Section number={3} title="Options" note="The defaults work for most apps." quiet>
              <div className="deploy-options">
                <Option
                  title="Environment"
                  summary={envCount ? `${envCount} variable(s)` : 'None set'}
                  defaultOpen={envCount > 0 || Boolean(pm2Opts.env_file)}
                >
                  <Field
                    label="Env file"
                    hint="Relative to the repository root, or an absolute path on this server. Read on every deploy."
                  >
                    <input
                      className="input"
                      type="text"
                      placeholder=".env.production"
                      value={pm2Opts.env_file}
                      onChange={(e) => setOpt('env_file', e.target.value)}
                    />
                  </Field>
                  <KeyValueList
                    label="Variables"
                    hint="Variables set here override the same names from the env file."
                    rows={envVars}
                    keyPlaceholder="KEY"
                    valuePlaceholder="value"
                    itemLabel="Variable"
                    addLabel="Add variable"
                    onAdd={addEnvVar}
                    onUpdate={updateEnvVar}
                    onRemove={removeEnvVar}
                  />
                </Option>

                <Option
                  title="Auto-deploy"
                  summary={watchEnabled ? `Every ${watchIntervalMinutes} min on ${branch.trim() || 'master'}` : 'Off'}
                >
                  <Toggle
                    label="Deploy automatically when the branch gets new commits"
                    hint="Hawkeye polls the remote branch and runs the same redeploy it runs when you click Redeploy now. Local changes in the deploy folder are discarded without asking, since nobody is there to confirm."
                    checked={watchEnabled}
                    onChange={setWatchEnabled}
                  />
                  {watchEnabled && (
                    <Field label="Check every" hint="Minutes between polls, 1 to 1440.">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={1440}
                        value={watchIntervalMinutes}
                        onChange={(e) => setWatchIntervalMinutes(e.target.value)}
                      />
                    </Field>
                  )}
                </Option>

                <Option
                  title="Local changes on redeploy"
                  summary={discardLocalChanges ? 'Discards local changes' : 'Asks first'}
                >
                  <Toggle
                    label="Discard local changes without asking"
                    hint="When a redeploy finds modified tracked files in the deploy folder, it runs git reset --hard before updating instead of pausing to ask. Untracked files are kept."
                    checked={discardLocalChanges}
                    onChange={setDiscardLocalChanges}
                  />
                </Option>

                <Option title="Setup scripts" summary={setupSummary}>
                  <Field
                    label="Pre-setup script"
                    hint="Shell script run in the deploy base folder before cloning. Use it to check that required tools exist."
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
                    hint="Shell script run inside the repository after building and before PM2 starts. Use it for migrations."
                  >
                    <textarea
                      className="textarea"
                      rows={3}
                      placeholder={'#!/bin/sh\nnode scripts/migrate.js'}
                      value={postSetupScript}
                      onChange={(e) => setPostSetupScript(e.target.value)}
                    />
                  </Field>
                </Option>

                <Option
                  title="How PM2 runs it"
                  summary={`${pm2Opts.exec_mode}, ${pm2Opts.instances} instance${Number(pm2Opts.instances) === 1 ? '' : 's'}`}
                >
                  <div className="deploy-grid">
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
                  <div className="deploy-grid">
                    <Field label="Exec mode" hint="Cluster spawns several workers sharing one port.">
                      <select
                        className="select"
                        value={pm2Opts.exec_mode}
                        onChange={(e) => setOpt('exec_mode', e.target.value)}
                      >
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
                </Option>

                <Option
                  title="Crash recovery"
                  summary={pm2Opts.autorestart ? `Auto-restart, max ${pm2Opts.max_restarts}` : 'Auto-restart off'}
                >
                  <Toggle
                    label="Restart on crash"
                    hint="Restart whenever the process exits, whatever the exit code."
                    checked={pm2Opts.autorestart}
                    onChange={(v) => setOpt('autorestart', v)}
                  />
                  <div className="deploy-grid">
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
                  <div className="deploy-grid">
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
                  <div className="deploy-grid">
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
                </Option>

                <Option
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
                  <div className="deploy-grid">
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
                </Option>
              </div>
            </Section>
          </form>

          <aside className="deploy-preview" aria-labelledby={`${titleId}-preview`}>
            <div>
              <h3 id={`${titleId}-preview`} className="deploy-preview-title">
                {isEdit ? 'What a redeploy will do' : 'What Hawkeye will do'}
              </h3>
              <p className="hint">Updates as you fill in the form.</p>
            </div>
            <StepList steps={previewSteps(draft, { firstDeploy, name: shownName })} compact />
            <p className="deploy-preview-after">
              {isEdit
                ? `${firstDeploy ? 'Save only stores the configuration.' : `Save keeps ${shownName} running as it is.`} Save and redeploy runs these steps now.`
                : `After that, ${shownName} appears in the sidebar and its Deploy tab shows the progress.`}
            </p>
          </aside>
        </div>

        <div className="modal-footer">
          {error ? (
            <span className="action-result modal-footer-text" data-ok="false">
              <WarningCircle size={13} weight="fill" />
              <span>{error}</span>
            </span>
          ) : (
            <p className="hint modal-footer-text">
              {isEdit
                ? 'Save does not touch the running process.'
                : 'The deployment runs on the server. You can close this window once it has started.'}
            </p>
          )}
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            Cancel
          </button>
          {isEdit && (
            <button type="submit" form="deploy-form" className="btn" disabled={submitting}>
              {submitting ? 'Saving' : 'Save'}
            </button>
          )}
          {isEdit ? (
            <button type="button" className="btn btn--primary" disabled={submitting} onClick={onRedeployClick}>
              <ArrowClockwise size={13} />
              {submitting ? 'Saving' : 'Save and redeploy'}
            </button>
          ) : (
            <button type="submit" form="deploy-form" className="btn btn--primary" disabled={submitting}>
              <RocketLaunch size={13} />
              {submitting ? 'Starting' : 'Deploy'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

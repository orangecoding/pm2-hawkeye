/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useRef, useState } from 'react';
import ConfirmButton from './ConfirmButton.jsx';
import {
  ArrowClockwise,
  CheckCircle,
  CircleNotch,
  Info,
  PencilSimple,
  RocketLaunch,
  Warning,
  WarningCircle,
} from './Icon.jsx';
import { formatClock } from '../services/chart.js';
import { formatAgo, formatDateTime } from '../services/format.js';
import {
  deriveRunState,
  isFirstDeploy,
  isRunActive,
  offlineStatus,
  outputTone,
  planDeploy,
  pm2Summary,
} from '../services/deployment.js';

/** Branch watcher tick, see lib/service/branchWatcher.js. */
const WATCH_TICK_MS = 60_000;

/**
 * A text link that runs an action, styled like every other link.
 *
 * @param {{ onClick: () => void, children: React.ReactNode }} props
 */
function ActionLink({ onClick, children }) {
  return (
    <a
      href="#"
      className="card-link"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {children}
    </a>
  );
}

/**
 * The "Edit configuration" button, which opens the deploy modal in edit mode.
 *
 * @param {{ onClick: () => void, sunken?: boolean }} props - `sunken` for a
 *   button sitting on a raised card.
 */
function EditButton({ onClick, sunken = true }) {
  return (
    <button type="button" className={`btn${sunken ? ' btn--sunken' : ''}`} onClick={onClick}>
      <PencilSimple size={13} />
      Edit configuration
    </button>
  );
}

/**
 * Note shown next to a step of the "What a (re)deploy does" card.
 *
 * @param {{ stage: string, skipped: boolean }} step
 * @param {object} deployment
 * @param {boolean} firstDeploy
 * @returns {string}
 */
function stepNote(step, deployment, firstDeploy) {
  if (step.stage === 'install' && step.skipped) return 'Skipped';
  if (step.skipped) return 'Not set, skipped';
  if (step.stage === 'clone') return firstDeploy ? 'Into the folder above' : 'Untracked files such as .env stay';
  if (step.stage === 'post_setup') return 'Runs inside the repository';
  if (step.stage === 'start') return pm2Summary(deployment.pm2_options);
  return '';
}

/**
 * Numbered list of deploy steps, active ones in accent, skipped ones dimmed.
 * Shared by the Deploy tab and the deploy form preview.
 *
 * @param {{
 *   steps: { stage: string, title: string, skipped: boolean, code: string, note: string }[],
 *   compact?: boolean,
 * }} props - `compact` draws the smaller circles of the form preview.
 */
export function StepList({ steps, compact = false }) {
  return (
    <ol className={`step-list${compact ? ' step-list--compact' : ''}`}>
      {steps.map((step, i) => (
        <li key={step.stage} className="step-list-item" data-skipped={step.skipped}>
          <span className="step-list-number">{i + 1}</span>
          <div className="step-list-body">
            <p className="step-list-head">
              <span className="step-list-title">{step.title}</span>
              {step.note && <span className="step-list-note">{step.note}</span>}
            </p>
            {step.code && <code className="step-list-code">{step.code}</code>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Callout and buttons for a deployment that waits for the user: the deploy
 * folder has tracked local changes the update would overwrite. This is a
 * bespoke prompt, not a ConfirmButton, because the server raises it.
 *
 * @param {{ deployment: object, changes: string, onConfirm: (confirmed: boolean) => Promise<void>, onEdit: () => void }} props
 */
function ConfirmCallout({ deployment, changes, onConfirm, onEdit }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  // A new question (or the next run) re-enables the buttons.
  useEffect(() => setBusy(false), [changes]);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  /**
   * Send the answer once.
   *
   * @param {boolean} confirmed
   */
  const answer = async (confirmed) => {
    setBusy(true);
    await onConfirm(confirmed);
  };

  return (
    <div className="callout callout--warning callout--stack" role="alert" ref={ref}>
      <p className="callout-title">The deploy folder has local changes</p>
      <p className="callout-text">
        Updating to the latest <span className="num">{deployment.branch}</span> would overwrite these files. Discard
        them to continue, or cancel the deployment. Untracked files stay either way.
      </p>
      <pre className="code-block">{changes}</pre>
      <div className="callout-actions">
        <button type="button" className="btn btn--danger" disabled={busy} onClick={() => answer(true)}>
          Discard changes and continue
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => answer(false)}>
          Cancel deployment
        </button>
      </div>
      <p className="hint">
        Do not want to be asked again? Set Local changes to Discard without asking in the{' '}
        <ActionLink onClick={onEdit}>configuration</ActionLink>.
      </p>
    </div>
  );
}

/** Icon of a step in the run panel, by state. */
const STEP_ICONS = {
  done: <CheckCircle size={16} weight="fill" aria-label="Done" />,
  active: <CircleNotch size={16} className="spin" aria-label="Running" />,
  wait: <Warning size={16} weight="fill" aria-label="Waiting for you" />,
  fail: <WarningCircle size={16} weight="fill" aria-label="Failed" />,
};

/**
 * The run of a deployment: what it is doing (or did), the steps with their
 * state, the confirm callout when it waits, and its output.
 *
 * Progress only exists for runs seen in this browser session. After a page
 * reload the server still reports `deploying`, so the panel shows that a run
 * is going on without inventing which step it is at.
 *
 * @param {{
 *   deployment: object,
 *   run: object | undefined,
 *   hasProcess: boolean,
 *   onRedeploy: (deployment: object) => Promise<void>,
 *   onEdit: (deployment: object) => void,
 *   onConfirm: (deploymentId: string, confirmed: boolean) => Promise<void>,
 *   onDismiss: (deploymentId: string) => void,
 *   onOpenLogs: () => void,
 * }} props
 */
function DeployRun({ deployment, run, hasProcess, onRedeploy, onEdit, onConfirm, onDismiss, onOpenLogs }) {
  const outputRef = useRef(null);
  const name = deployment.pm2_name;
  const firstDeploy = isFirstDeploy(deployment, run);
  // No old version runs while PM2 has no process: a first deploy, or a
  // deployment whose process was deleted. A run started here remembers it,
  // since the process shows up in PM2 before the run panel goes away.
  const startsProcess = firstDeploy || (run?.startsProcess ?? !hasProcess);
  const steps = planDeploy(deployment, { firstDeploy, startsProcess }).filter((s) => !s.skipped);
  const lines = run?.lines ?? [];
  const { states, outcome, failedIndex, exitCode } = deriveRunState(steps, lines);
  const startedBeforeLoad = !run && deployment.deploying;
  const activeIndex = states.findIndex((s) => s === 'active');
  const failedStep = steps[failedIndex];
  const finishedAt = run?.finishedAt ? formatClock(run.finishedAt) : '';

  // Follow the output as it arrives.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  let icon;
  let title;
  let sub;
  if (outcome === 'confirm') {
    icon = <Warning size={18} weight="fill" />;
    title = 'Redeploy is waiting for you';
    sub = `Nothing has changed yet. ${name} keeps running the old version.`;
  } else if (outcome === 'failed') {
    icon = <WarningCircle size={18} weight="fill" />;
    if (failedStep?.stage === 'start') {
      title = `${failedStep.title} failed`;
      sub = 'Check the output below.';
    } else {
      title = `${firstDeploy ? 'Deploy' : 'Redeploy'} failed at ${failedStep?.title ?? 'the first step'}`;
      sub = startsProcess
        ? `The steps after ${failedStep?.title} did not run, so nothing runs in PM2 yet.`
        : `The steps after ${failedStep?.title} did not run. ${name} was not restarted and still runs the previous version.`;
    }
  } else if (outcome === 'success') {
    icon = <CheckCircle size={18} weight="fill" />;
    title = firstDeploy ? 'Deployed' : 'Redeployed';
    sub = startsProcess
      ? `${name} started at ${finishedAt}.`
      : `${name} restarted at ${finishedAt} with the latest ${deployment.branch}.`;
  } else {
    icon = <CircleNotch size={18} className="spin" />;
    title = `${firstDeploy ? 'Deploying' : 'Redeploying'} ${name}`;
    const keeps = startsProcess ? '' : ` ${name} keeps serving the old version until the restart.`;
    if (startedBeforeLoad) {
      sub = 'Started before this page was loaded, so its earlier output is not shown. New output appears here.';
    } else if (activeIndex >= 0) {
      sub = `Step ${activeIndex + 1} of ${steps.length}: ${steps[activeIndex].title}.${keeps}`;
    } else {
      sub = `Starting.${keeps}`;
    }
  }

  const finished = outcome === 'failed' || outcome === 'success';
  const outputState = { running: 'Live', confirm: 'Paused' }[outcome] ?? 'Finished';
  const shownLines = lines.filter((l) => l.status !== 'confirm' && (l.line || l.stage === 'done'));

  /**
   * Note under a step title in the run panel.
   *
   * @param {{ command: string }} step
   * @param {string} state
   * @returns {string}
   */
  const runNote = (step, state) => {
    if (state === 'wait') return 'Waiting for you';
    if (state === 'skip') return 'Did not run';
    if (state === 'fail') return exitCode != null ? `Exited with code ${exitCode}` : 'Failed';
    return step.command;
  };

  return (
    <>
      <section className="card deploy-run" aria-labelledby="deploy-run-title" data-outcome={outcome}>
        <div className="deploy-run-head">
          <span className="deploy-run-icon">{icon}</span>
          <div className="deploy-run-heading" aria-live="polite">
            <h2 id="deploy-run-title" className="card-title">
              {title}
            </h2>
            <p className="card-hint card-hint--tight">{sub}</p>
          </div>
          <div className="deploy-run-actions">
            {outcome === 'failed' && (
              <>
                <EditButton onClick={() => onEdit(deployment)} />
                <button type="button" className="btn btn--primary" onClick={() => onRedeploy(deployment)}>
                  Try again
                </button>
              </>
            )}
            {outcome === 'success' && hasProcess && (
              <button type="button" className="btn btn--sunken" onClick={onOpenLogs}>
                Open logs
              </button>
            )}
            {finished && (
              <button type="button" className="btn btn--quiet" onClick={() => onDismiss(deployment.id)}>
                Dismiss
              </button>
            )}
          </div>
        </div>

        <div className="deploy-run-body">
          <ol className="run-steps" aria-label="Deployment steps">
            {steps.map((step, i) => (
              <li key={step.stage} className="run-step" data-state={states[i]}>
                <span className="run-step-icon">
                  {STEP_ICONS[states[i]] ?? <span className="run-step-ring" role="img" aria-label="Not started" />}
                </span>
                <div className="run-step-text">
                  <p className="run-step-title">{step.title}</p>
                  <p className="run-step-note">{runNote(step, states[i])}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="deploy-run-main">
            {outcome === 'confirm' && run?.confirmChanges && (
              <ConfirmCallout
                deployment={deployment}
                changes={run.confirmChanges}
                onConfirm={(confirmed) => onConfirm(deployment.id, confirmed)}
                onEdit={() => onEdit(deployment)}
              />
            )}

            <div className="output-box">
              <div className="output-box-head">
                <span className="output-box-title">Output</span>
                <span>{outputState}</span>
              </div>
              <div className="output-box-body" ref={outputRef}>
                {shownLines.map((entry, i) => (
                  <div key={i} className="output-line" data-tone={outputTone(entry)}>
                    {entry.stage === 'done' ? 'Deployed.' : entry.line}
                  </div>
                ))}
                {outcome === 'running' && (
                  <div className="output-line" data-tone="detail">
                    Working
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {!finished && (
        <p className="hint">
          You can switch to another process or tab while this runs. The deployment keeps running on the server even if
          you close the page.
        </p>
      )}
    </>
  );
}

/**
 * Callout for a deployment that has no PM2 process: its first deployment did
 * not finish (`broken`), or PM2 no longer has the process (`offline`).
 *
 * @param {{
 *   deployment: object,
 *   onRedeploy: (deployment: object) => Promise<void>,
 *   onEdit: (deployment: object) => void,
 *   onDelete: (deploymentId: string) => Promise<void>,
 * }} props
 */
function OfflineCallout({ deployment, onRedeploy, onEdit, onDelete }) {
  const broken = offlineStatus(deployment) === 'broken';
  const name = deployment.pm2_name;
  return (
    <section
      className={`callout callout--row${broken ? ' callout--critical' : ''}`}
      role="alert"
      aria-labelledby="offline-title"
    >
      {broken ? (
        <WarningCircle size={18} weight="fill" className="callout-icon" />
      ) : (
        <Info size={18} className="callout-icon" />
      )}
      <div className="callout-body">
        <h2 id="offline-title" className="card-title">
          {broken ? 'The first deployment did not finish' : `${name} is not in PM2`}
        </h2>
        <p className="callout-text">
          {broken
            ? 'Nothing runs in PM2 yet. Fix the cause, then deploy again. The output of the failed run is not kept after a page reload, so deploying again also shows you the error.'
            : 'It was deployed before, but PM2 no longer has a process for it. Deploy again to start it, or delete the deployment.'}
        </p>
      </div>
      <div className="callout-actions">
        <ConfirmButton
          label="Delete deployment"
          question={`Delete ${name}?`}
          variant="danger"
          choices={[{ label: 'Delete', danger: true, onConfirm: () => onDelete(deployment.id) }]}
        />
        <EditButton onClick={() => onEdit(deployment)} sunken={false} />
        <button type="button" className="btn btn--primary" onClick={() => onRedeploy(deployment)}>
          <RocketLaunch size={13} />
          Deploy again
        </button>
      </div>
    </section>
  );
}

/**
 * One label/value row of a card's definition list.
 *
 * @param {{ label: string, children: React.ReactNode }} props
 */
function Row({ label, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Deploy tab: everything about how Hawkeye deploys this app, and the place to
 * redeploy it. Also the whole page of a deployment that has no PM2 process.
 *
 * While a run is going on, or until a finished run is dismissed, the run panel
 * sits above the configuration cards.
 *
 * @param {{
 *   deployment: object,
 *   run: object | undefined,
 *   hasProcess: boolean,
 *   onRedeploy: (deployment: object) => Promise<void>,
 *   onEdit: (deployment: object) => void,
 *   onConfirm: (deploymentId: string, confirmed: boolean) => Promise<void>,
 *   onDismiss: (deploymentId: string) => void,
 *   onOpenLogs: () => void,
 *   onDelete: (deploymentId: string) => Promise<void>,
 * }} props - `run` is this deployment's entry of the session's run map.
 *   `hasProcess` is false on the page of a deployment without a PM2 process.
 */
export default function DeployPanel({
  deployment,
  run,
  hasProcess,
  onRedeploy,
  onEdit,
  onConfirm,
  onDismiss,
  onOpenLogs,
  onDelete,
}) {
  const name = deployment.pm2_name;
  const active = isRunActive(deployment, run);
  const showRun = active || Boolean(run && !run.dismissed);
  const firstDeploy = deployment.last_deployed_at == null;
  const steps = planDeploy(deployment, { firstDeploy, startsProcess: !hasProcess }).map((step) => ({
    ...step,
    note: stepNote(step, deployment, firstDeploy),
  }));
  const envKeys = Object.keys(deployment.env_vars ?? {});
  const envFile = deployment.pm2_options?.env_file;
  const watching = Boolean(deployment.watch_enabled);
  const lastCheck = deployment.watch_last_checked_at;
  const edit = () => onEdit(deployment);

  let nextCheck = 'Within a minute';
  if (lastCheck) {
    const due = lastCheck + deployment.watch_interval_minutes * 60_000;
    nextCheck = due <= Date.now() + WATCH_TICK_MS ? 'Within a minute' : formatClock(due);
  }

  return (
    <div className="deploy-panel fade-in">
      {showRun && (
        <DeployRun
          deployment={deployment}
          run={run}
          hasProcess={hasProcess}
          onRedeploy={onRedeploy}
          onEdit={onEdit}
          onConfirm={onConfirm}
          onDismiss={onDismiss}
          onOpenLogs={onOpenLogs}
        />
      )}

      {!hasProcess && !showRun && (
        <OfflineCallout deployment={deployment} onRedeploy={onRedeploy} onEdit={onEdit} onDelete={onDelete} />
      )}

      <div className="deploy-columns">
        <div className="deploy-column deploy-column--main">
          <section className="card" aria-labelledby="deploy-source">
            {hasProcess ? (
              <div className="card-head card-head--actions">
                <div className="card-head-text">
                  <h2 id="deploy-source" className="card-title">
                    Deployment
                  </h2>
                  <p className="card-hint">Hawkeye cloned {name} from Git and runs it under PM2.</p>
                </div>
                <div className="card-head-buttons">
                  <EditButton onClick={edit} />
                  <ConfirmButton
                    label="Redeploy now"
                    question={`Redeploy ${name} from ${deployment.branch}?`}
                    variant="primary"
                    icon={<ArrowClockwise size={13} />}
                    disabled={active}
                    title={active ? 'A deployment of this app is running' : undefined}
                    choices={[{ label: 'Redeploy', onConfirm: () => onRedeploy(deployment) }]}
                  />
                </div>
              </div>
            ) : (
              <div className="card-head">
                <h2 id="deploy-source" className="card-title">
                  Deployment
                </h2>
              </div>
            )}
            <dl className="card-dl">
              <Row label="Repository">
                <span className="num card-dl-break">{deployment.repo_url}</span>
              </Row>
              <Row label="Branch">
                <span className="code-chip">{deployment.branch}</span>
              </Row>
              <Row label="Folder on this server">
                <span className="num card-dl-break card-dl-dim">{deployment.deploy_path}</span>
              </Row>
              <Row label="Last deployed">
                {deployment.last_deployed_at ? (
                  <>
                    <span className="card-dl-ok">
                      <CheckCircle size={13} weight="fill" />
                      {formatDateTime(deployment.last_deployed_at)}
                    </span>
                    <span className="card-dl-muted"> ({formatAgo(deployment.last_deployed_at)})</span>
                  </>
                ) : (
                  <span className="card-dl-bad">Never</span>
                )}
              </Row>
              {hasProcess && (
                <Row label="Local changes">
                  {deployment.discard_local_changes ? 'Discards them without asking' : 'Asks before discarding them'}
                </Row>
              )}
            </dl>
          </section>

          <section className="card" aria-labelledby="deploy-steps">
            <div className="card-head">
              <h2 id="deploy-steps" className="card-title">
                {hasProcess ? 'What a redeploy does' : 'What a deploy does'}
              </h2>
              <p className="card-hint">
                {hasProcess
                  ? 'These steps run in order. Steps that are not set up are skipped. If one fails, the steps after it do not run and the running process stays as it is.'
                  : 'The first deploy clones the repository. Later redeploys fetch the branch instead.'}
              </p>
            </div>
            <StepList steps={steps} />
          </section>
        </div>

        <div className="deploy-column deploy-column--side">
          <section className="card" aria-labelledby="deploy-auto">
            <div className="card-head card-head--side">
              <h2 id="deploy-auto" className="card-title">
                Auto-deploy
              </h2>
              <span className={`tag${watching ? ' tag--accent' : ''}`}>{watching ? 'On' : 'Off'}</span>
              <ActionLink onClick={edit}>Change</ActionLink>
            </div>
            {watching ? (
              <>
                <p className="card-side-text">
                  Checks <span className="num">{deployment.branch}</span> every {deployment.watch_interval_minutes} min
                  and redeploys when it has new commits. Local changes are discarded without asking, since nobody is
                  there to confirm.
                </p>
                <dl className="card-dl card-dl--side">
                  <Row label="Last check">{lastCheck ? formatClock(lastCheck) : 'Not checked yet'}</Row>
                  <Row label="Next check">{nextCheck}</Row>
                  {deployment.watch_last_commit && (
                    <Row label="Last deployed commit">{deployment.watch_last_commit.slice(0, 7)}</Row>
                  )}
                </dl>
              </>
            ) : (
              <p className="card-side-text card-side-text--last">Deploys only when you start it here.</p>
            )}
            {deployment.watch_last_error && (
              <div className="card-warning">
                <Warning size={14} weight="fill" />
                <span>
                  The last check failed: <span className="num">{deployment.watch_last_error}</span>
                </span>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="deploy-env">
            <div className="card-head card-head--side">
              <h2 id="deploy-env" className="card-title">
                Environment
              </h2>
              <ActionLink onClick={edit}>Change</ActionLink>
            </div>
            {envFile || envKeys.length > 0 ? (
              <>
                <p className="card-side-text card-side-text--muted">
                  Applied on every deploy. Values are not shown here.
                </p>
                <dl className="card-dl card-dl--side">
                  <Row label="Env file">{envFile || 'None'}</Row>
                  <Row label="Variables">
                    {envKeys.length > 0 ? (
                      <span className="code-chips">
                        {envKeys.map((key) => (
                          <span key={key} className="code-chip code-chip--dim">
                            {key}
                          </span>
                        ))}
                      </span>
                    ) : (
                      'None'
                    )}
                  </Row>
                </dl>
              </>
            ) : (
              <p className="card-side-text card-side-text--muted card-side-text--last">
                No env file and no variables set.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

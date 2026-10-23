/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import Actions from './Actions.jsx';
import ConfirmButton from './ConfirmButton.jsx';
import { Check } from './Icon.jsx';
import { formatShortDuration } from '../services/format.js';

/**
 * What turning monitoring on actually gives you, stated where the switch is.
 * The retention windows come from the server configuration.
 *
 * @param {number} metricsRetentionMs
 * @param {number} logsRetentionMs
 * @returns {string[]}
 */
function monitoringBenefits(metricsRetentionMs, logsRetentionMs) {
  return [
    `CPU, memory and application metrics, sampled every 20 s and kept for ${formatShortDuration(metricsRetentionMs)}`,
    `Log lines stored and searchable for ${formatShortDuration(logsRetentionMs)}`,
    'Alerts when a matching log line appears',
  ];
}

/**
 * Levels the picker offers, most verbose first.
 *
 * Mirrors LOG_LEVELS in lib/service/logLevelService.js. `silent` is included
 * because a noisy process sometimes needs shutting up, but it is dimmed in
 * the group so it is not picked by accident.
 */
const LOG_LEVEL_CHOICES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

/**
 * A card of the Manage tab: a title with an optional hint, then rows.
 *
 * @param {{ id: string, title: string, hint?: React.ReactNode, danger?: boolean, children: React.ReactNode }} props
 */
function Card({ id, title, hint, danger = false, children }) {
  return (
    <section className={`card${danger ? ' card--danger' : ''}`} aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="card-title">
          {title}
        </h2>
        {hint && <p className="card-hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Manage tab: every function that changes the selected process, one card per
 * concern. Deployment lives in its own tab.
 *
 * @param {{
 *   selectedProcess: object,
 *   isMonitored: boolean,
 *   metricsRetentionMs?: number,
 *   logsRetentionMs?: number,
 *   onToggleMonitoring: (pm2Name: string, currentlyMonitored: boolean) => void,
 *   onToggleAlerts: (pm2Name: string, alertsEnabled: boolean) => void,
 *   onOpenAlerting: () => void,
 *   actions: object[],
 *   logLevel: { supported: boolean|null, level: string|null, busy: boolean },
 *   onSetLogLevel: (level: string) => Promise<void>,
 *   selectedProcessId: string | null,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<string>,
 *   selectedDeployment: object | null,
 *   onDelete: (withDeploy?: boolean) => Promise<void>,
 *   onRemoveOrphan: (pm2Name: string) => Promise<void>,
 * }} props - `onOpenAlerting` opens Settings on its Alerting page.
 */
export default function ManagePanel({
  selectedProcess,
  isMonitored,
  metricsRetentionMs = 24 * 60 * 60 * 1000,
  logsRetentionMs = 14 * 24 * 60 * 60 * 1000,
  onToggleMonitoring,
  onToggleAlerts,
  onOpenAlerting,
  actions,
  logLevel,
  onSetLogLevel,
  selectedProcessId,
  csrfToken,
  onCsrfRefresh,
  selectedDeployment,
  onDelete,
  onRemoveOrphan,
}) {
  const name = selectedProcess.name;
  const isOrphan = selectedProcess.isOrphan ?? false;
  const alertsEnabled = selectedProcess.alertsEnabled !== false;
  const statusLower = String(selectedProcess.status ?? '').toLowerCase();
  const isOnline = statusLower === 'online';
  const isStopped = ['stopped', 'errored', 'error', 'one-launch-status'].includes(statusLower);
  const hasDeployment = Boolean(selectedDeployment);

  return (
    <div className="manage-panel fade-in">
      <Card
        id="manage-history"
        title="History and alerts"
        hint="Without stored history you see live data only, and nothing survives a page reload."
      >
        <div className="card-row">
          <div className="card-row-text">
            <p className="card-row-label">
              Store logs and metrics
              {isMonitored && <span className="tag tag--accent">On</span>}
            </p>
            {isMonitored ? (
              <p className="card-row-hint">
                Logs are kept for {formatShortDuration(logsRetentionMs)}, metrics for{' '}
                {formatShortDuration(metricsRetentionMs)}.
              </p>
            ) : (
              <ul className="manage-benefits">
                {monitoringBenefits(metricsRetentionMs, logsRetentionMs).map((benefit) => (
                  <li key={benefit}>
                    <Check size={11} weight="bold" />
                    <span>{benefit}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {isMonitored ? (
            <ConfirmButton
              label="Turn off"
              question={`Delete all stored history for ${name}?`}
              variant="danger"
              choices={[{ label: 'Delete history', danger: true, onConfirm: () => onToggleMonitoring(name, true) }]}
            />
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => onToggleMonitoring(name, false)}>
              Turn on
            </button>
          )}
        </div>

        {isMonitored && (
          <div className="card-row">
            <div className="card-row-text">
              <p className="card-row-label">Alerts</p>
              <p className="card-row-hint">
                Notify when a log line of {name} matches the alert rules. Rules and reporters are set in{' '}
                <a
                  href="#settings-alerting"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenAlerting();
                  }}
                >
                  Settings, Alerting
                </a>
                .
              </p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={alertsEnabled}
                aria-label={`Alerts for ${name}`}
                onChange={(e) => onToggleAlerts(name, e.target.checked)}
              />
              <span className="toggle-track" />
              <span className="toggle-label">{alertsEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </div>
        )}
      </Card>

      {isOnline && (
        <Card
          id="manage-level"
          title="Log level"
          hint="Changes how much the running process logs, without restarting it. It applies to this instance only and is gone as soon as the process restarts."
        >
          <div className="card-row">
            <div className="card-row-text card-row-text--narrow">
              <p className="card-row-label">
                Current level
                {logLevel.level && <span className="tag tag--accent">{logLevel.level}</span>}
              </p>
              {logLevel.supported === false && (
                <p className="card-row-hint">
                  {name} did not answer. It needs the Hawkeye log-level listener, see the README for the snippet.
                </p>
              )}
            </div>
            <div className="segmented" role="group" aria-label="Log level">
              {LOG_LEVEL_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="segmented-item"
                  data-quiet={choice === 'silent'}
                  aria-pressed={logLevel.level === choice}
                  disabled={logLevel.busy}
                  onClick={() => onSetLogLevel(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {actions.length > 0 && (
        <Card id="manage-actions" title="Custom actions" hint={`Registered by ${name} with PM2 through axm_actions.`}>
          <Actions
            actions={actions}
            selectedProcessId={selectedProcessId}
            csrfToken={csrfToken}
            onCsrfRefresh={onCsrfRefresh}
          />
        </Card>
      )}

      <Card id="manage-remove" title="Remove" danger>
        {isOrphan ? (
          <div className="card-row">
            <div className="card-row-text">
              <p className="card-row-label">Orphaned record</p>
              <p className="card-row-hint">
                This process is tracked by Hawkeye but no longer exists in PM2. Removing it deletes its stored history.
              </p>
            </div>
            <ConfirmButton
              label="Remove record"
              question={`Remove ${name} from Hawkeye?`}
              variant="danger"
              choices={[{ label: 'Remove', danger: true, onConfirm: () => onRemoveOrphan(name) }]}
            />
          </div>
        ) : (
          <div className="card-row">
            <div className="card-row-text">
              <p className="card-row-label">Delete from PM2</p>
              <p className="card-row-hint">
                {isStopped
                  ? hasDeployment
                    ? 'You can keep the cloned files on disk or remove them along with the process.'
                    : 'Removes the process from PM2. Files on disk are untouched.'
                  : hasDeployment
                    ? `Stop ${name} first. You can then keep the cloned files on disk or remove them too.`
                    : `Stop ${name} first. Removing it from PM2 leaves the files on disk untouched.`}
              </p>
            </div>
            {isStopped ? (
              <ConfirmButton
                label="Delete"
                question={`Delete ${name}?`}
                variant="danger"
                choices={
                  hasDeployment
                    ? [
                        { label: 'PM2 only', onConfirm: () => onDelete(false) },
                        { label: 'PM2 and disk', danger: true, onConfirm: () => onDelete(true) },
                      ]
                    : [{ label: 'Delete', danger: true, onConfirm: () => onDelete(false) }]
                }
              />
            ) : (
              <button type="button" className="btn" disabled title="Stop the process first">
                Delete
              </button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import Actions from './Actions.jsx';
import ConfirmButton from './ConfirmButton.jsx';
import { Check } from './Icon.jsx';

/** What turning monitoring on actually gives you, stated where the switch is. */
const MONITORING_BENEFITS = [
  'CPU and memory history, sampled every 20 s and kept for 24 hours',
  'Log lines stored and searchable for 14 days',
  'Alerts when a matching log line appears',
];

/**
 * Manage tab: every function that changes the selected process.
 *
 * Before this panel existed these controls were spread across four surfaces:
 * a monitoring strip above the logs, a custom-action <select> under the process
 * name, delete and remove-orphan buttons in the header row, and Edit/Redeploy
 * in both the header and the sidebar. Per-process alerting had a backend route
 * but no control at all.
 *
 * @param {{
 *   selectedProcess: object,
 *   isMonitored: boolean,
 *   onToggleMonitoring: (pm2Name: string, currentlyMonitored: boolean) => void,
 *   onToggleAlerts: (pm2Name: string, alertsEnabled: boolean) => void,
 *   actions: object[],
 *   selectedProcessId: string | null,
 *   csrfToken: string | null,
 *   onCsrfRefresh: () => Promise<string>,
 *   selectedDeployment: object | null,
 *   onEditDeployment: (pm2Name: string) => void,
 *   onDelete: (withDeploy?: boolean) => Promise<void>,
 *   onRemoveOrphan: (pm2Name: string) => Promise<void>,
 * }} props
 */
export default function ManagePanel({
  selectedProcess,
  isMonitored,
  onToggleMonitoring,
  onToggleAlerts,
  actions,
  selectedProcessId,
  csrfToken,
  onCsrfRefresh,
  selectedDeployment,
  onEditDeployment,
  onDelete,
  onRemoveOrphan,
}) {
  const name = selectedProcess.name;
  const isOrphan = selectedProcess.isOrphan ?? false;
  const alertsEnabled = selectedProcess.alertsEnabled !== false;
  const statusLower = String(selectedProcess.status ?? '').toLowerCase();
  const isDeletable = !isOrphan && ['stopped', 'errored', 'error', 'one-launch-status'].includes(statusLower);

  return (
    <div className="manage-panel fade-in">
      {/* ── Monitoring ──────────────────────────────────────────────────── */}
      <section className="manage-section">
        <div className="manage-section-head">
          <h2 className="manage-section-title">Monitoring</h2>
          <p className="hint">
            Without monitoring you see live data only. Nothing survives a page reload.
          </p>
        </div>

        <div className="manage-row">
          <div className="manage-row-text">
            <p className="manage-row-label">
              Store history for {name}
              {isMonitored && <span className="tag tag--accent">On</span>}
            </p>
            {!isMonitored && (
              <ul className="manage-benefits">
                {MONITORING_BENEFITS.map((benefit) => (
                  <li key={benefit}>
                    <Check size={11} weight="bold" />
                    <span>{benefit}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="manage-row-control">
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
        </div>

        {isMonitored && (
          <div className="manage-row">
            <div className="manage-row-text">
              <p className="manage-row-label">Alerts</p>
              <p className="hint">
                Send a notification when a log line matches your alerting rules. Configure reporters in Settings.
              </p>
            </div>
            <div className="manage-row-control">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={alertsEnabled}
                  onChange={(e) => onToggleAlerts(name, e.target.checked)}
                />
                <span className="toggle-track" />
                <span className="toggle-label">{alertsEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
          </div>
        )}
      </section>

      {/* ── PM2 custom actions ──────────────────────────────────────────── */}
      {actions.length > 0 && (
        <section className="manage-section">
          <div className="manage-section-head">
            <h2 className="manage-section-title">Custom actions</h2>
            <p className="hint">Actions this process registered with PM2 through axm_actions.</p>
          </div>
          <Actions
            actions={actions}
            selectedProcessId={selectedProcessId}
            csrfToken={csrfToken}
            onCsrfRefresh={onCsrfRefresh}
          />
        </section>
      )}

      {/* ── Deployment ──────────────────────────────────────────────────── */}
      {selectedDeployment && !isOrphan && (
        <section className="manage-section">
          <div className="manage-section-head">
            <h2 className="manage-section-title">Deployment</h2>
          </div>
          <div className="manage-row">
            <div className="manage-row-text">
              <p className="manage-row-label">{selectedDeployment.repo_url}</p>
              <p className="hint">
                Branch {selectedDeployment.branch}
                {selectedDeployment.last_deployed_at
                  ? `, last deployed ${new Date(selectedDeployment.last_deployed_at).toLocaleString('en-GB')}`
                  : ', never deployed successfully'}
              </p>
            </div>
            {/* Same label as the header button; one action, one name. */}
            <div className="manage-row-control">
              <button type="button" className="btn" onClick={() => onEditDeployment(name)}>
                Redeploy
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ── Destructive ─────────────────────────────────────────────────── */}
      {(isOrphan || isDeletable) && (
        <section className="manage-section manage-section--danger">
          <div className="manage-section-head">
            <h2 className="manage-section-title">Remove</h2>
          </div>

          {isOrphan && (
            <div className="manage-row">
              <div className="manage-row-text">
                <p className="manage-row-label">Orphaned record</p>
                <p className="hint">
                  This process is tracked by Hawkeye but no longer exists in PM2. Removing it deletes its stored
                  history.
                </p>
              </div>
              <div className="manage-row-control">
                <ConfirmButton
                  label="Remove record"
                  question={`Remove ${name} from Hawkeye?`}
                  variant="danger"
                  choices={[{ label: 'Remove', danger: true, onConfirm: () => onRemoveOrphan(name) }]}
                />
              </div>
            </div>
          )}

          {isDeletable && (
            <div className="manage-row">
              <div className="manage-row-text">
                <p className="manage-row-label">Delete from PM2</p>
                <p className="hint">
                  {selectedDeployment
                    ? 'You can keep the cloned files on disk or remove them along with the process.'
                    : 'Removes the process from PM2. Files on disk are untouched.'}
                </p>
              </div>
              <div className="manage-row-control">
                <ConfirmButton
                  label="Delete"
                  question={`Delete ${name}?`}
                  variant="danger"
                  choices={
                    selectedDeployment
                      ? [
                          { label: 'PM2 only', onConfirm: () => onDelete(false) },
                          { label: 'PM2 and disk', danger: true, onConfirm: () => onDelete(true) },
                        ]
                      : [{ label: 'Delete', danger: true, onConfirm: () => onDelete(false) }]
                  }
                />
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

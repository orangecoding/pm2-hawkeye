/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import ConfirmButton from './ConfirmButton.jsx';
import { GitBranch } from './Icon.jsx';
import { formatBytes, formatRelativeTime, formatDate, formatDateTime } from '../services/format.js';
import { offlineStatus, shortRepo } from '../services/deployment.js';

/** Status word shown for a deployment without a PM2 process. */
const OFFLINE_STATUS_TEXT = {
  broken: 'deploy failed',
  deploying: 'deploying',
  offline: 'not in PM2',
};

/**
 * Repository and branch of a Hawkeye deployment, as a chip.
 *
 * @param {{ deployment: object, onClick?: () => void }} props - Without
 *   `onClick` the chip is plain text.
 */
function DeployChip({ deployment, onClick }) {
  const body = (
    <>
      <GitBranch size={12} weight="bold" />
      <span className="deploy-chip-repo">{shortRepo(deployment.repo_url)}</span>
      <span className="deploy-chip-branch">{deployment.branch}</span>
    </>
  );
  if (!onClick) return <span className="deploy-chip deploy-chip--static">{body}</span>;
  return (
    <button
      type="button"
      className="deploy-chip"
      title={`Deployed by Hawkeye from ${shortRepo(deployment.repo_url)}. Open the Deploy tab.`}
      onClick={onClick}
    >
      {body}
    </button>
  );
}

/**
 * Header for the selected process, or for a deployment that has no PM2
 * process.
 *
 * For a process: name, status, the deployment chip when Hawkeye deployed it,
 * Restart and Stop/Start, then the live numbers. The chip opens the Deploy
 * tab, where every deployment action lives.
 *
 * For an offline deployment there is nothing to restart or measure, so the
 * header states that in place of the buttons and the stat strip.
 *
 * The cpu and mem readouts are shortcuts: clicking one opens the Metrics tab
 * scrolled to that chart. They do not expand in place, so the charts still
 * live in exactly one tab.
 *
 * @param {{
 *   selectedProcess?: object | null,
 *   offlineDeployment?: object | null,
 *   details?: object | null,
 *   selectedDeployment?: object | null,
 *   onRestart?: () => Promise<void>,
 *   onStop?: () => Promise<void>,
 *   onStart?: () => Promise<void>,
 *   onOpenDeploy?: () => void,
 *   onShowMetrics?: ((chartId: string) => void) | null,
 *   children?: React.ReactNode,
 * }} props - Pass either `selectedProcess` or `offlineDeployment`.
 */
export default function ProcessHeader({
  selectedProcess = null,
  offlineDeployment = null,
  details = null,
  selectedDeployment = null,
  onRestart,
  onStop,
  onStart,
  onOpenDeploy,
  onShowMetrics = null,
  children,
}) {
  if (offlineDeployment) {
    const state = offlineStatus(offlineDeployment);
    const name = offlineDeployment.pm2_name;
    return (
      <header className="process-header">
        <div className="process-header-row">
          <h1 className="process-name">{name}</h1>
          <span className="status-text" data-status={state === 'broken' ? 'broken' : state}>
            {OFFLINE_STATUS_TEXT[state]}
          </span>
          <DeployChip deployment={offlineDeployment} />
        </div>
        <p className="stat-strip-empty">
          {offlineDeployment.last_deployed_at
            ? `No PM2 process. It was last deployed ${formatDateTime(offlineDeployment.last_deployed_at)}.`
            : `No PM2 process. Hawkeye has a deployment for ${name}, but it never started.`}
        </p>
        {children}
      </header>
    );
  }

  const status = String(selectedProcess.status ?? '');
  const statusLower = status.toLowerCase();
  const isOnline = statusLower === 'online';
  const isOrphan = selectedProcess.isOrphan ?? false;
  const pid = details?.process?.pid;
  const isDeployed = Boolean(selectedDeployment) && !isOrphan;

  // Only cpu and mem carry a chartId: those are the two the Metrics tab plots.
  // The rest stay plain text rather than promising a chart that is not there.
  const stats = details
    ? [
        { label: 'cpu', value: `${details.process.cpu}%`, chartId: 'metric-cpu' },
        { label: 'mem', value: formatBytes(details.process.memory), chartId: 'metric-mem' },
        { label: 'restarts', value: String(details.process.restarts) },
        // pm_uptime is the last start time; it keeps ticking after a stop, so
        // like `pm2 ls` the uptime is only shown while the process runs.
        isOnline
          ? {
              label: 'uptime',
              value: formatRelativeTime(details.process.uptime),
              title: `Started ${formatDate(details.process.uptime)}`,
            }
          : { label: 'uptime', value: '---' },
        ...(pid != null ? [{ label: 'pid', value: String(pid) }] : []),
      ]
    : null;

  return (
    <header className="process-header">
      <div className="process-header-row">
        <h1 className="process-name">{selectedProcess.name}</h1>

        <span className="status-text" data-status={statusLower}>
          {statusLower}
        </span>

        {isDeployed && <DeployChip deployment={selectedDeployment} onClick={onOpenDeploy} />}

        <div className="process-header-actions">
          {!isOrphan && (
            <ConfirmButton
              label="Restart"
              question={`Restart ${selectedProcess.name}?`}
              choices={[{ label: 'Restart', onConfirm: onRestart }]}
            />
          )}
          {!isOrphan &&
            (isOnline ? (
              <ConfirmButton
                label="Stop"
                question={`Stop ${selectedProcess.name}?`}
                choices={[{ label: 'Stop', danger: true, onConfirm: onStop }]}
              />
            ) : (
              <button type="button" className="btn btn--primary" onClick={onStart}>
                Start
              </button>
            ))}
        </div>
      </div>

      {stats ? (
        <div className="stat-strip">
          {stats.map((stat) => {
            const body = (
              <>
                <span className="stat-strip-label">{stat.label}</span>
                <span className="stat-strip-value">{stat.value}</span>
              </>
            );

            return stat.chartId && onShowMetrics ? (
              <button
                type="button"
                className="stat-strip-item stat-strip-item--link"
                key={stat.label}
                title={`Show ${stat.label} history in Metrics`}
                onClick={() => onShowMetrics(stat.chartId)}
              >
                {body}
              </button>
            ) : (
              <div className="stat-strip-item" key={stat.label} title={stat.title}>
                {body}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="stat-strip-empty">Waiting for the first sample.</p>
      )}

      {children}
    </header>
  );
}

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import ConfirmButton from './ConfirmButton.jsx';
import { GitBranch } from './Icon.jsx';
import { formatBytes, formatRelativeTime, formatDate } from '../services/format.js';

/**
 * Shorten a git remote URL to `owner/repo` for display.
 *
 * Handles both HTTPS (https://github.com/owner/repo.git) and SSH
 * (git@github.com:owner/repo.git) forms, and falls back to the raw string.
 *
 * @param {string} url
 * @returns {string}
 */
function shortRepo(url) {
  if (!url) return '';
  const cleaned = url
    .replace(/\.git$/, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : cleaned;
}

/**
 * Header for the selected process.
 *
 * Two lines only: who it is and what you can do to it, then the live numbers.
 *
 * Deliberately not here any more: the status dot (the status word beside it
 * already carried the same information in the same colour), the absolute
 * uptime date (it restated the relative uptime next to it, and now lives in a
 * tooltip), the script filename, and the Monitored chip. That chip was the
 * loudest element on the page while being the least actionable, and the Manage
 * tab already flags the state worth acting on, which is monitoring being off.
 *
 * In its place the header states something that could not be seen anywhere
 * before: whether Hawkeye deployed this process, from which repository and
 * branch, with Redeploy sitting directly next to Restart and Stop.
 *
 * The cpu and mem readouts are shortcuts: clicking one opens the Metrics tab
 * scrolled to that chart. They do not expand in place, so the charts still
 * live in exactly one tab.
 *
 * @param {{
 *   selectedProcess: object | null,
 *   details: object | null,
 *   selectedDeployment: object | null,
 *   onRestart: () => Promise<void>,
 *   onStop: () => Promise<void>,
 *   onStart: () => Promise<void>,
 *   onEditDeployment: (pm2Name: string) => void,
 *   onShowMetrics?: ((chartId: string) => void) | null,
 *   children?: React.ReactNode,
 * }} props
 */
export default function ProcessHeader({
  selectedProcess,
  details,
  selectedDeployment,
  onRestart,
  onStop,
  onStart,
  onEditDeployment,
  onShowMetrics = null,
  children,
}) {
  if (!selectedProcess) {
    return (
      <header className="process-header">
        <div className="process-header--empty">Select a process from the sidebar.</div>
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
        {
          label: 'uptime',
          value: formatRelativeTime(details.process.uptime),
          title: `Started ${formatDate(details.process.uptime)}`,
        },
        ...(pid != null ? [{ label: 'pid', value: String(pid) }] : []),
      ]
    : null;

  return (
    <header className="process-header">
      <div className="process-header-row">
        <h1 className="process-name">{selectedProcess.name}</h1>

        <span className="status-text" data-status={statusLower}>
          {status}
        </span>

        {isDeployed && (
          <button
            type="button"
            className="deploy-chip"
            title={`Deployed by Hawkeye from ${selectedDeployment.repo_url}. Open the deployment configuration.`}
            onClick={() => onEditDeployment(selectedProcess.name)}
          >
            <GitBranch size={12} weight="bold" />
            <span className="deploy-chip-repo">{shortRepo(selectedDeployment.repo_url)}</span>
            <span className="deploy-chip-branch">{selectedDeployment.branch}</span>
          </button>
        )}

        <div className="process-header-actions">
          {isDeployed && (
            <button type="button" className="btn" onClick={() => onEditDeployment(selectedProcess.name)}>
              Redeploy
            </button>
          )}
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

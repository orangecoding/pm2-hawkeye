/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import ConfirmButton from './ConfirmButton.jsx';
import { formatBytes, formatRelativeTime, formatDate } from '../services/format.js';

/**
 * Header for the selected process.
 *
 * Carries the identity of the object being acted on, the two controls used
 * continuously (Restart and Stop/Start), and an always-visible strip of live
 * numbers. Every other action moved to the Manage tab: the header used to hold
 * restart, stop, start, delete, remove-orphan, edit-deployment and a custom
 * action dropdown in a single wrapping row.
 *
 * The stat strip is plain text on hairlines rather than clickable cards. It
 * previously required a click per metric to reveal a chart, one at a time,
 * which hid trends by default. Charts now live in the Metrics tab.
 *
 * @param {{
 *   selectedProcess: object | null,
 *   details: object | null,
 *   isMonitored: boolean,
 *   onRestart: () => Promise<void>,
 *   onStop: () => Promise<void>,
 *   onStart: () => Promise<void>,
 *   children?: React.ReactNode,
 * }} props
 */
export default function ProcessHeader({ selectedProcess, details, isMonitored, onRestart, onStop, onStart, children }) {
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
  const pid = details?.process?.pid;
  const script = selectedProcess?.pm2_env?.pm_exec_path ?? selectedProcess?.script ?? '';
  const scriptShort = script.split('/').pop() || script;

  const stats = details
    ? [
        { label: 'CPU', value: `${details.process.cpu}%` },
        { label: 'Memory', value: formatBytes(details.process.memory) },
        { label: 'Restarts', value: String(details.process.restarts) },
        {
          label: 'Uptime',
          value: formatRelativeTime(details.process.uptime),
          sub: formatDate(details.process.uptime),
        },
      ]
    : null;

  return (
    <header className="process-header">
      <div className="process-header-row">
        <div className="process-title">
          <span className="status-dot" data-status={statusLower} />
          <h1>{selectedProcess.name}</h1>
        </div>

        <div className="process-meta">
          <span className="status-text" data-status={statusLower}>
            {status}
          </span>
          {pid != null && <span className="process-meta-mono">PID {pid}</span>}
          {scriptShort && <span className="process-meta-mono">{scriptShort}</span>}
          {isMonitored && <span className="tag tag--accent">Monitored</span>}
        </div>

        <div className="process-header-actions">
          <ConfirmButton
            label="Restart"
            question={`Restart ${selectedProcess.name}?`}
            choices={[{ label: 'Restart', onConfirm: onRestart }]}
          />
          {!selectedProcess.isOrphan &&
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
          {stats.map((stat) => (
            <div className="stat-strip-item" key={stat.label}>
              <span className="stat-strip-label">{stat.label}</span>
              <span className="stat-strip-value">{stat.value}</span>
              {stat.sub && <span className="stat-strip-sub">{stat.sub}</span>}
            </div>
          ))}
        </div>
      ) : (
        <p className="stat-strip-empty">Waiting for the first sample.</p>
      )}

      {children}
    </header>
  );
}

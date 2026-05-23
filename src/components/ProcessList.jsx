/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import { formatBytes } from '../services/format.js';

/**
 * Megaphone icon rendered next to process names when alerting is enabled.
 * @param {{ size?: number, color?: string }} props
 */
function MegaphoneIcon({ size = 12, color = '#d4a259' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1.5 4.5h2l3-2.5v7.5l-3-2.5h-2a.5.5 0 0 1-.5-.5v-1.5a.5.5 0 0 1 .5-.5Z" fill={color} />
      <path d="M8 4.2a2.5 2.5 0 0 1 0 3.6" stroke={color} strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

/**
 * REC dot rendered in the sub-row of monitored processes.
 * @param {{ size?: number, color?: string }} props
 */
function RecIcon({ size = 7, color = '#e07a5f' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <circle cx="4" cy="4" r="3" fill={color} />
    </svg>
  );
}

/**
 * Single process row in the sidebar.
 *
 * @param {{
 *   proc: object,
 *   isSelected: boolean,
 *   onSelect: (id: string) => void,
 * }} props
 */
function ProcRow({ proc, isSelected, onSelect }) {
  const id = proc.id ?? proc.name;
  const status = String(proc.status ?? '').toLowerCase();
  const classes = [
    'process-item',
    isSelected ? 'active' : '',
    proc.isOrphan ? 'orphan' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); }
      }}
    >
      <div className="process-item-main-row">
        <span className="process-item-dot" data-status={status} />
        <span className="process-item-name">{proc.name}</span>
        {proc.alertsEnabled !== false && proc.isMonitored && <MegaphoneIcon />}
      </div>
      <div className="process-item-sub-row">
        <span className="process-item-status-text" data-status={status}>{status}</span>
        {proc.cpu != null && <span className="process-item-cpu">{proc.cpu.toFixed(1)}%</span>}
        {proc.memory != null && <span className="process-item-mem">{formatBytes(proc.memory)}</span>}
        {proc.isMonitored && <RecIcon />}
      </div>
    </div>
  );
}

/**
 * Sidebar process list.
 *
 * Renders the process list and, below it, any offline deployment records.
 * The brand card and toolbar buttons moved to App.jsx's topbar in the Direction A layout.
 *
 * @param {{
 *   processes: object[],
 *   selectedProcessId: string | null,
 *   onSelect: (id: string) => void,
 *   onEditDeployment: (pm2Name: string) => void,
 *   offlineDeployments: object[],
 *   onDeleteDeployment: (deploymentId: string) => void,
 *   drawerOpen?: boolean,
 * }} props
 */
export default function ProcessList({
  processes,
  selectedProcessId,
  onSelect,
  onEditDeployment,
  offlineDeployments = [],
  onDeleteDeployment,
  drawerOpen = false,
}) {
  const selectedIdStr = String(selectedProcessId);

  return (
    <aside className="app-sidebar section-shell" data-open={drawerOpen}>
      <div className="sidebar-title-row">
        <span className="sidebar-title-label">Processes</span>
        <span className="sidebar-title-count">{processes.length}</span>
      </div>
      <div className="process-list" role="listbox" aria-label="PM2 processes">
        {processes.length === 0 && offlineDeployments.length === 0 && (
          <div className="empty-card compact">
            <p>No PM2 processes found.</p>
          </div>
        )}
        {processes.map((proc) => (
          <ProcRow
            key={proc.name}
            proc={proc}
            isSelected={String(proc.id ?? proc.name) === selectedIdStr}
            onSelect={onSelect}
          />
        ))}
        {offlineDeployments.length > 0 && (
          <div className="offline-deployments-section">
            <div className="offline-deployments-header">Offline deployments</div>
            {offlineDeployments.map((dep) => (
              <div className="offline-deployment-item" key={dep.id}>
                <div className="offline-deployment-top">
                  <span className="process-item-name">{dep.pm2_name}</span>
                  <span className={`offline-deploy-badge offline-deploy-badge--${dep.displayStatus}`}>
                    {dep.displayStatus === 'deploying' && 'Deploying…'}
                    {dep.displayStatus === 'broken' && 'Broken'}
                    {dep.displayStatus === 'offline' && 'Offline'}
                  </span>
                </div>
                <div className="offline-deployment-actions">
                  <button
                    className="edit-deploy-btn"
                    onClick={() => onEditDeployment(dep.pm2_name)}
                  >
                    Edit / Redeploy
                  </button>
                  <button
                    className="offline-deploy-delete-btn"
                    onClick={() => onDeleteDeployment(dep.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

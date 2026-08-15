/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useMemo, useState } from 'react';
import { formatBytes } from '../services/format.js';
import { MagnifyingGlass, Record } from './Icon.jsx';
import ConfirmButton from './ConfirmButton.jsx';

/** Tone class per offline-deployment state. */
const OFFLINE_TAG_TONE = {
  deploying: ' tag--accent',
  broken: ' tag--critical',
  offline: '',
};

/** Human label per offline-deployment state. */
const OFFLINE_TAG_LABEL = {
  deploying: 'Deploying',
  broken: 'Failed',
  offline: 'Stopped',
};

/**
 * Single process row.
 *
 * One line: state dot, name, then CPU and memory right-aligned in tabular
 * figures so the numbers form a readable column down the list.
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

  return (
    <button
      type="button"
      className={`process-item${isSelected ? ' active' : ''}`}
      role="option"
      aria-selected={isSelected}
      onClick={() => onSelect(id)}
    >
      <span className="status-dot" data-status={status} />
      <span className="process-item-name">{proc.name}</span>
      <span className="process-item-meta">
        {proc.cpu != null && <span>{proc.cpu.toFixed(0)}%</span>}
        {proc.memory != null && <span>{formatBytes(proc.memory)}</span>}
        {proc.isMonitored && (
          <span className="process-item-rec" title="Monitored - logs and metrics are being stored">
            <Record size={9} weight="fill" />
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Sidebar process list.
 *
 * Rows are grouped by state (running, then not running, then deployments with
 * no PM2 process) so a stopped or broken app cannot hide in the middle of a
 * long list of healthy ones. A filter box appears once there are enough
 * entries for scanning to be slower than typing.
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
  const [filter, setFilter] = useState('');
  const selectedIdStr = String(selectedProcessId);
  const query = filter.trim().toLowerCase();

  const matches = (name) => !query || String(name).toLowerCase().includes(query);

  const { running, notRunning } = useMemo(() => {
    const visible = processes.filter((p) => matches(p.name));
    return {
      running: visible.filter((p) => String(p.status ?? '').toLowerCase() === 'online'),
      notRunning: visible.filter((p) => String(p.status ?? '').toLowerCase() !== 'online'),
    };
  }, [processes, query]);

  const visibleOffline = offlineDeployments.filter((d) => matches(d.pm2_name));
  const totalVisible = running.length + notRunning.length + visibleOffline.length;
  const showFilter = processes.length + offlineDeployments.length > 6;

  /**
   * Render one titled group of process rows.
   *
   * @param {string} title
   * @param {object[]} items
   */
  const group = (title, items) =>
    items.length > 0 && (
      <div className="process-group">
        <div className="process-group-head">
          <p className="section-label">{title}</p>
          <span className="process-group-count">{items.length}</span>
        </div>
        {items.map((proc) => (
          <ProcRow
            key={proc.name}
            proc={proc}
            isSelected={String(proc.id ?? proc.name) === selectedIdStr}
            onSelect={onSelect}
          />
        ))}
      </div>
    );

  return (
    <aside className="app-sidebar" data-open={drawerOpen}>
      {showFilter && (
        <div className="sidebar-search">
          <MagnifyingGlass className="sidebar-search-icon" size={13} weight="bold" />
          <input
            className="input"
            type="text"
            value={filter}
            placeholder="Filter processes"
            aria-label="Filter processes"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      <div className="process-list" role="listbox" aria-label="PM2 processes">
        {totalVisible === 0 && (
          <p className="sidebar-empty">
            {processes.length === 0 && offlineDeployments.length === 0
              ? 'No PM2 processes found.'
              : `Nothing matches "${filter.trim()}".`}
          </p>
        )}

        {group('Running', running)}
        {group('Not running', notRunning)}

        {visibleOffline.length > 0 && (
          <div className="process-group">
            <div className="process-group-head">
              <p className="section-label">Not deployed</p>
              <span className="process-group-count">{visibleOffline.length}</span>
            </div>
            {visibleOffline.map((dep) => (
              <div className="offline-item" key={dep.id}>
                <div className="offline-item-top">
                  <span className="process-item-name">{dep.pm2_name}</span>
                  <span className={`tag${OFFLINE_TAG_TONE[dep.displayStatus] ?? ''}`}>
                    {OFFLINE_TAG_LABEL[dep.displayStatus] ?? dep.displayStatus}
                  </span>
                </div>
                <div className="offline-item-actions">
                  <button type="button" className="btn btn--sm" onClick={() => onEditDeployment(dep.pm2_name)}>
                    Redeploy
                  </button>
                  <ConfirmButton
                    label="Delete"
                    question={`Delete ${dep.pm2_name}?`}
                    variant="danger"
                    size="sm"
                    choices={[{ label: 'Delete', danger: true, onConfirm: () => onDeleteDeployment(dep.id) }]}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

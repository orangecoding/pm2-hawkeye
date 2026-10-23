/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useMemo, useState } from 'react';
import { formatBytes } from '../services/format.js';
import { deploymentKey, offlineStatus } from '../services/deployment.js';
import { GitBranch, MagnifyingGlass, Record, SquaresFour } from './Icon.jsx';

/** Tag shown on a not-running process, by PM2 status. */
const STATUS_TAGS = {
  errored: { label: 'Errored', tone: 'critical' },
  error: { label: 'Errored', tone: 'critical' },
  stopped: { label: 'Stopped', tone: '' },
  stopping: { label: 'Stopping', tone: 'warning' },
  launching: { label: 'Starting', tone: 'warning' },
  'one-launch-status': { label: 'Starting', tone: 'warning' },
};

/** Tag and dot colour of a deployment without a PM2 process, by offline status. */
const OFFLINE_ROWS = {
  deploying: { label: 'Deploying', tone: 'accent', dot: 'deploying' },
  broken: { label: 'Deploy failed', tone: 'critical', dot: 'errored' },
  offline: { label: 'Not in PM2', tone: '', dot: 'stopped' },
};

/**
 * Sidebar row: state dot, name and, on the right, either the live CPU and
 * memory (running) or a status tag (not running). One button with nothing
 * nested in it, so the whole row is one target.
 *
 * @param {{
 *   rowKey: number|string,
 *   name: string,
 *   dot: string,
 *   isRunning: boolean,
 *   isSelected: boolean,
 *   isDeployed: boolean,
 *   meta?: { cpu: number|null, memory: number|null, isMonitored: boolean },
 *   tag?: { label: string, tone: string },
 *   onSelect: (key: number|string) => void,
 * }} props
 */
function Row({ rowKey, name, dot, isRunning, isSelected, isDeployed, meta, tag, onSelect }) {
  return (
    <button
      type="button"
      className={`process-item${isSelected ? ' active' : ''}`}
      data-running={isRunning}
      aria-current={isSelected ? 'page' : undefined}
      onClick={() => onSelect(rowKey)}
    >
      <span className="status-dot" data-status={dot} />
      <span className="process-item-name">
        <span className="process-item-label">{name}</span>
        {isDeployed && (
          <span className="process-item-deployed" title="Deployed by Hawkeye">
            <GitBranch size={10} weight="bold" aria-label="Deployed by Hawkeye" />
          </span>
        )}
      </span>
      {meta && (
        <span className="process-item-meta">
          {meta.cpu != null && <span>{meta.cpu.toFixed(0)}%</span>}
          {meta.memory != null && <span>{formatBytes(meta.memory)}</span>}
          {meta.isMonitored && (
            <span className="process-item-rec" title="Monitored - logs and metrics are being stored">
              <Record size={9} weight="fill" />
            </span>
          )}
        </span>
      )}
      {tag && <span className={`tag${tag.tone ? ` tag--${tag.tone}` : ''}`}>{tag.label}</span>}
    </button>
  );
}

/**
 * Sidebar: the Overview entry, then every process grouped into Running and
 * Not running. It is the only process list in the app.
 *
 * Deployments that have no PM2 process (a first deploy that failed or is still
 * running, or a deployed app removed from PM2 by hand) are ordinary rows in
 * Not running. Selecting one opens its deployment page; the actions that used
 * to sit on these rows live there now, so picking a row never acts on it.
 *
 * A filter box appears once there are enough entries for scanning to be
 * slower than typing.
 *
 * @param {{
 *   processes: object[],
 *   selection: number|string|null,
 *   onSelect: (key: number|string|null) => void,
 *   deployedNames?: Set<string>,
 *   offlineDeployments: object[],
 *   attentionCount: number,
 *   drawerOpen?: boolean,
 * }} props - `selection` is null while the Overview shows, a pm_id or orphan
 *   name for a process, or a `deployment:<id>` key for an offline deployment.
 */
export default function ProcessList({
  processes,
  selection,
  onSelect,
  deployedNames = new Set(),
  offlineDeployments = [],
  attentionCount,
  drawerOpen = false,
}) {
  const [filter, setFilter] = useState('');
  const selectedStr = String(selection);
  const query = filter.trim().toLowerCase();
  const total = processes.length + offlineDeployments.length;

  const { running, notRunning } = useMemo(() => {
    const matches = (name) => !query || String(name).toLowerCase().includes(query);
    const rows = [
      ...processes.map((p) => {
        const status = String(p.status ?? '').toLowerCase();
        const key = p.id ?? p.name;
        return {
          key,
          name: p.name,
          dot: status,
          isRunning: status === 'online',
          isDeployed: deployedNames.has(p.name),
          meta: { cpu: p.cpu, memory: p.memory, isMonitored: p.isMonitored },
          tag: STATUS_TAGS[status] ?? {
            label: status ? status[0].toUpperCase() + status.slice(1) : 'Unknown',
            tone: '',
          },
        };
      }),
      ...offlineDeployments.map((d) => {
        const look = OFFLINE_ROWS[offlineStatus(d)];
        return {
          key: deploymentKey(d.id),
          name: d.pm2_name,
          dot: look.dot,
          isRunning: false,
          isDeployed: true,
          tag: { label: look.label, tone: look.tone },
        };
      }),
    ].filter((row) => matches(row.name));
    return { running: rows.filter((r) => r.isRunning), notRunning: rows.filter((r) => !r.isRunning) };
  }, [processes, offlineDeployments, deployedNames, query]);

  /**
   * Render one titled group of rows.
   *
   * @param {string} title
   * @param {object[]} rows
   */
  const group = (title, rows) =>
    rows.length > 0 && (
      <div className="process-group" role="group" aria-label={title}>
        <div className="process-group-head">
          <p className="section-label">{title}</p>
          <span className="process-group-count">{rows.length}</span>
        </div>
        {rows.map((row) => (
          <Row
            key={row.key}
            rowKey={row.key}
            name={row.name}
            dot={row.dot}
            isRunning={row.isRunning}
            isSelected={String(row.key) === selectedStr}
            isDeployed={row.isDeployed}
            meta={row.isRunning ? row.meta : undefined}
            tag={row.isRunning ? undefined : row.tag}
            onSelect={onSelect}
          />
        ))}
      </div>
    );

  return (
    <aside className="app-sidebar" data-open={drawerOpen}>
      <nav className="sidebar-nav" aria-label="Main">
        <button
          type="button"
          className={`sidebar-nav-item${selection == null ? ' active' : ''}`}
          aria-current={selection == null ? 'page' : undefined}
          onClick={() => onSelect(null)}
        >
          <SquaresFour size={15} />
          Overview
          {attentionCount > 0 && (
            <span
              className="sidebar-nav-badge"
              title={`${attentionCount} ${attentionCount === 1 ? 'item needs' : 'items need'} attention`}
            >
              {attentionCount}
            </span>
          )}
        </button>
      </nav>

      <div className="sidebar-head">
        <div className="sidebar-head-row">
          <p className="section-label">Processes</p>
          <span className="process-group-count">{total}</span>
        </div>
        {total > 6 && (
          <label className="sidebar-search">
            <MagnifyingGlass className="sidebar-search-icon" size={13} weight="bold" />
            <input
              className="input"
              type="text"
              value={filter}
              placeholder="Filter processes"
              aria-label="Filter processes"
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
        )}
      </div>

      <div className="process-list">
        {running.length + notRunning.length === 0 && (
          <p className="sidebar-empty">
            {total === 0 ? 'No PM2 processes found.' : `Nothing matches "${filter.trim()}".`}
          </p>
        )}

        {group('Running', running)}
        {group('Not running', notRunning)}
      </div>
    </aside>
  );
}

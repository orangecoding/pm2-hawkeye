/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, {useMemo} from 'react';
import {formatBytes, getStatusTone} from '../services/format.js';

/**
 * Return a human-readable tooltip for a PM2 process status string.
 *
 * @param {string} status
 * @returns {string}
 */
function statusTooltip(status) {
    const s = String(status).toLowerCase();
    if (s === 'online') return 'Running normally';
    if (s === 'launching') return 'Starting up';
    if (s === 'stopped') return 'Stopped (not running)';
    if (s === 'errored') return 'Crashed or encountered an error';
    if (s === 'one-launch-status') return 'Exited after a single launch';
    if (s === 'orphan') return 'No longer running in PM2, but still tracked by Hawkeye';
    return `Status: ${status}`;
}

/**
 * Sidebar process list.
 *
 * Each process row shows its status, CPU/memory, and a read-only monitoring
 * tag.  Rows are rendered as divs (not buttons) so nested interactive elements
 * are valid HTML.  Monitored processes are visually distinguished; orphaned
 * ones (monitored but absent from PM2) receive a warning tint.  Processes that
 * were deployed via hawkeye show a "Deployed" badge, a Redeploy button, and an
 * Edit button.
 *
 * A second section below the process list shows deployment records that have
 * no corresponding running PM2 process. Each such entry is tagged as
 * "Broken" (first deploy failed), "Not running in PM2" (previously ran but
 * now absent), or "Deploying..." (deploy currently in progress). Users can
 * edit/redeploy or delete these entries.
 *
 * @param {{
 *   processes: object[],
 *   selectedProcessId: string | null,
 *   status: string,
 *   onSelect: (id: string) => void,
 *   onOpenSettings: () => void,
 *   onOpenDeploy: () => void,
 *   onToggleAlert: (pm2Name: string, currentlyEnabled: boolean) => void,
 *   deployments: object[],
 *   onEditDeployment: (pm2Name: string) => void,
 *   onRemoveOrphan: (pm2Name: string) => void,
 *   offlineDeployments: object[],
 *   onDeleteDeployment: (deploymentId: string) => void,
 * }} props
 */
export default function ProcessList({processes, selectedProcessId, status, onSelect, onOpenSettings, onOpenDeploy, onToggleAlert, deployments = [], onEditDeployment, onRemoveOrphan, offlineDeployments = [], onDeleteDeployment}) {
    /** @type {Set<string>} O(1) lookup for deployed process names */
    const deployedNames = useMemo(
        () => new Set(deployments.map((d) => d.pm2_name)),
        [deployments]
    );

    return (
        <aside className="sidebar section-shell">
            <div className="brand-card">
                <p className="eyebrow">PM2 Inventory</p>
                <h1>Command Center</h1>
                <p className="subtle">Monitor processes, inspect logs, and restart services.</p>
            </div>
            <div className="sidebar-toolbar">
                <button className="ghost-button" type="button" onClick={onOpenSettings}>Settings</button>
                <button className="ghost-button" type="button" onClick={onOpenDeploy}>Deploy</button>
                <div className="sidebar-status">{status}</div>
            </div>
            <div className="process-list" role="listbox" aria-label="PM2 processes">
                {processes.length === 0 && offlineDeployments.length === 0 && (
                    <div className="empty-card compact"><p>No PM2 processes found.</p></div>
                )}
                {processes.map((proc) => {
                    const isSelected = String(proc.id ?? proc.name) === String(selectedProcessId);
                    const monitoredClass = proc.isMonitored ? 'monitored' : '';
                    const orphanClass = proc.isOrphan ? 'orphan' : '';
                    return (
                        <div
                            className={`process-item ${isSelected ? 'active' : ''} ${monitoredClass} ${orphanClass}`.trim()}
                            key={proc.name}
                            role="option"
                            aria-selected={isSelected}
                            tabIndex={0}
                            onClick={() => onSelect(proc.id ?? proc.name)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onSelect(proc.id ?? proc.name);
                                }
                            }}
                        >
                            <div className="process-item-top">
                                <span className="process-item-title">{proc.name}</span>
                                <span className="process-item-controls">
                                    {proc.isMonitored && (
                                        <button
                                            className={`bell-btn${proc.alertsEnabled === false ? ' bell-disabled' : ''}`}
                                            title={proc.alertsEnabled === false
                                                ? 'Alerts muted - click to enable'
                                                : 'Alerts active - click to mute'}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onToggleAlert(proc.name, proc.alertsEnabled ?? true);
                                            }}
                                            aria-label="Toggle alerts"
                                        >
                                            {'\uD83D\uDCE2'}
                                        </button>
                                    )}
                                    <span
                                            className={`status-indicator ${getStatusTone(proc.status)}`}
                                            title={statusTooltip(proc.status)}
                                        />
                                </span>
                            </div>
                            {(proc.isMonitored || deployedNames.has(proc.name)) && (
                                <div className="monitor-tag-row">
                                    {proc.isMonitored && (
                                        <span className="monitor-tag" title="Hawkeye is collecting and storing CPU/memory metrics and log entries for this process. History is available even after restarts.">
                                            <span className="monitor-tag-dot"/>
                                            Monitored
                                        </span>
                                    )}
                                    {deployedNames.has(proc.name) && (
                                        <button
                                            className="edit-deploy-btn"
                                            title="Edit configuration or trigger a redeploy"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onEditDeployment(proc.name);
                                            }}
                                        >
                                            Edit / Redeploy
                                        </button>
                                    )}
                                </div>
                            )}
                            <span className="process-item-status">
                                {proc.isOrphan
                                    ?   <button
                                            className="process-item-orphan"
                                            title="This process is no longer running in PM2, but Hawkeye still has a monitoring record for it. Click to remove the record."
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onRemoveOrphan(proc.name);
                                            }}
                                        >
                                            Orphan (Remove)
                                        </button>
                                    : <span title={statusTooltip(proc.status)}>{`${proc.status} \u00b7 ${proc.cpu}% CPU \u00b7 ${formatBytes(proc.memory)}`}</span>}
                            </span>
                        </div>
                    );
                })}
                {offlineDeployments.length > 0 && (
                    <div className="offline-deployments-section">
                        <div className="offline-deployments-header">Offline deployments</div>
                        {offlineDeployments.map((dep) => (
                            <div className="offline-deployment-item" key={dep.id}>
                                <div className="offline-deployment-top">
                                    <span className="process-item-title">{dep.pm2_name}</span>
                                    <span
                                        className={`offline-deploy-badge offline-deploy-badge--${dep.displayStatus}`}
                                        title={
                                            dep.displayStatus === 'deploying'
                                                ? 'A deployment is currently in progress for this app.'
                                                : dep.displayStatus === 'broken'
                                                    ? 'The initial deployment failed before the process ever ran successfully. Edit the configuration and redeploy to fix it.'
                                                    : 'This app was successfully deployed before, but is no longer running in PM2. It may have been stopped or removed manually.'
                                        }
                                    >
                                        {dep.displayStatus === 'deploying' && 'Deploying\u2026'}
                                        {dep.displayStatus === 'broken' && 'Broken'}
                                        {dep.displayStatus === 'offline' && 'Not running in PM2'}
                                    </span>
                                </div>
                                <div className="offline-deployment-actions">
                                    <button
                                        className="edit-deploy-btn"
                                        title="Edit configuration or trigger a redeploy"
                                        onClick={() => onEditDeployment(dep.pm2_name)}
                                    >
                                        Edit / Redeploy
                                    </button>
                                    <button
                                        className="offline-deploy-delete-btn"
                                        title="Delete this deployment record"
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

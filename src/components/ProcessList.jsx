/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";
import {formatBytes, getStatusTone} from "../services/format.js";

/**
 * Sidebar process list.
 *
 * Each process row shows its status, CPU/memory, and a read-only monitoring
 * tag.  Rows are rendered as divs (not buttons) so nested interactive elements
 * are valid HTML.  Monitored processes are visually distinguished; orphaned
 * ones (monitored but absent from PM2) receive a warning tint.
 *
 * @param {{
 *   processes: object[],
 *   selectedProcessId: string | null,
 *   status: string,
 *   onSelect: (id: string) => void,
 *   onRefresh: () => void,
 * }} props
 */
export default function ProcessList({processes, selectedProcessId, status, onSelect, onRefresh}) {
    return (
        <aside className="sidebar section-shell">
            <div className="brand-card">
                <p className="eyebrow">PM2 Inventory</p>
                <h1>Command Center</h1>
                <p className="subtle">Monitor processes, inspect logs, and restart services.</p>
            </div>
            <div className="sidebar-toolbar">
                <button className="ghost-button" type="button" onClick={onRefresh}>Refresh</button>
                <div className="sidebar-status">{status}</div>
            </div>
            <div className="process-list" role="listbox" aria-label="PM2 processes">
                {processes.length ? processes.map((proc) => {
                    const isSelected = String(proc.id ?? proc.name) === String(selectedProcessId);
                    const monitoredClass = proc.isMonitored ? "monitored" : "";
                    const orphanClass = proc.isOrphan ? "orphan" : "";
                    return (
                        <div
                            className={`process-item ${isSelected ? "active" : ""} ${monitoredClass} ${orphanClass}`.trim()}
                            key={proc.name}
                            role="option"
                            aria-selected={isSelected}
                            tabIndex={0}
                            onClick={() => onSelect(proc.id ?? proc.name)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelect(proc.id ?? proc.name);
                                }
                            }}
                        >

                            <div className="process-item-top">
                                <span className="process-title">{proc.name}</span>
                                <span className="process-item-controls">
                                    <span className={`status-indicator ${getStatusTone(proc.status)}`}/>
                                </span>
                            </div>
                            {proc.isMonitored && (
                                <div className="monitor-tag-row">
                                    <span className="monitor-tag" title="Metrics and logs are being stored">
                                        <span className="monitor-tag-dot"/>
                                        Monitored
                                    </span>
                                </div>
                            )}
                            <span className="process-status">
                                {proc.isOrphan
                                    ? "orphan \u00b7 not in PM2"
                                    : `${proc.status} \u00b7 ${proc.cpu}% CPU \u00b7 ${formatBytes(proc.memory)}`}
                            </span>
                        </div>
                    );
                }) : (
                    <div className="empty-card compact"><p>No PM2 processes found.</p></div>
                )}
            </div>
        </aside>
    );
}

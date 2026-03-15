/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";
import { formatBytes, getStatusTone } from "../services/format.js";

export default function ProcessList({ processes, selectedProcessId, status, onSelect, onRefresh }) {
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
        {processes.length ? processes.map((proc) => (
          <button
            className={`process-item ${String(proc.id) === String(selectedProcessId) ? "active" : ""}`.trim()}
            type="button"
            key={proc.id}
            onClick={() => onSelect(proc.id)}
          >
            <span className="process-item-top">
              <span className="process-title">{proc.name}</span>
              <span className={`status-indicator ${getStatusTone(proc.status)}`} />
            </span>
            <span className="process-status">
              {`${proc.status} · ${proc.cpu}% CPU · ${formatBytes(proc.memory)}`}
            </span>
          </button>
        )) : (
          <div className="empty-card compact"><p>No PM2 processes found.</p></div>
        )}
      </div>
    </aside>
  );
}

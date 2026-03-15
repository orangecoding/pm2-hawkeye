/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";
import { formatBytes, formatRelativeTime, formatDate } from "../services/format.js";

export default function StatsGrid({ details, error }) {
  const items = details
    ? [
        { label: "CPU", value: `${details.process.cpu}%` },
        { label: "Memory", value: formatBytes(details.process.memory) },
        { label: "Restarts", value: String(details.process.restarts) },
        { label: "Uptime", value: formatRelativeTime(details.process.uptime), sub: formatDate(details.process.uptime) },
      ]
    : null;

  return (
    <section className="panel section-shell stats-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h3>Runtime metrics</h3>
        </div>
        <p className="subtle">Live CPU, memory, uptime, and restart telemetry.</p>
      </div>
      <div className={`stats-grid ${details ? "" : "empty-state"}`.trim()}>
        {items ? items.map((item) => (
          <div className="stat-card" key={item.label}>
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
            {item.sub ? <span className="stat-sub">{item.sub}</span> : null}
          </div>
        )) : (
          <div className="empty-card"><p>{error || "No process metrics loaded yet."}</p></div>
        )}
      </div>
    </section>
  );
}

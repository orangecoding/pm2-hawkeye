/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from "react";
import { formatBytes, formatRelativeTime, formatDate } from "../services/format.js";
import Sparkline from "./Sparkline.jsx";

/**
 * Runtime metrics dashboard.
 *
 * Shows CPU, memory, restart count, and uptime for the selected process.
 * When `metricsHistory` contains at least two samples, CPU and memory stat
 * cards render a time-proportional step-function sparkline with a hover
 * tooltip.  When the process is not monitored, a placeholder hint is shown in
 * the sparkline area instead.
 *
 * @param {{ details: object | null, error: string, metricsHistory: object[], isMonitored: boolean }} props
 */
export default function StatsGrid({ details, error, metricsHistory = [], isMonitored = false }) {
  const items = details
    ? [
        { label: "CPU", value: `${details.process.cpu}%`, sparklineKey: "cpu" },
        { label: "Memory", value: formatBytes(details.process.memory), sparklineKey: "memory" },
        { label: "Restarts", value: String(details.process.restarts) },
        { label: "Uptime", value: formatRelativeTime(details.process.uptime), sub: formatDate(details.process.uptime) },
      ]
    : null;

  const cpuSamples = metricsHistory.map((s) => ({ t: s.sampled_at, v: s.cpu }));
  const memorySamples = metricsHistory.map((s) => ({ t: s.sampled_at, v: s.memory }));

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
            {item.sparklineKey === "cpu" && cpuSamples.length >= 2 && (
              <Sparkline
                samples={cpuSamples}
                formatValue={(v) => `${v.toFixed(1)}%`}
                color="var(--accent)"
              />
            )}
            {item.sparklineKey === "cpu" && !isMonitored && (
              <div className="sparkline-placeholder">
                <span>Enable monitoring for trend history</span>
              </div>
            )}
            {item.sparklineKey === "memory" && memorySamples.length >= 2 && (
              <Sparkline
                samples={memorySamples}
                formatValue={formatBytes}
                color="var(--success)"
              />
            )}
            {item.sparklineKey === "memory" && !isMonitored && (
              <div className="sparkline-placeholder">
                <span>Enable monitoring for trend history</span>
              </div>
            )}
          </div>
        )) : (
          <div className="empty-card"><p>{error || "No process metrics loaded yet."}</p></div>
        )}
      </div>
    </section>
  );
}

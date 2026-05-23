/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useState } from 'react';
import Sparkline from './Sparkline.jsx';

/**
 * Format a percentage value as a compact string.
 *
 * @param {number|null|undefined} pct
 * @returns {string}
 */
function fmtPct(pct) {
  return pct != null ? `${pct.toFixed(1)}%` : '--';
}

/**
 * Minimal inline sparkline rendered as an SVG polyline.
 * No interactivity - just shows the trend shape for the topbar.
 *
 * @param {{ samples: number[], color: string }} props
 */
function MiniSpark({ samples, color }) {
  if (!samples || samples.length < 2) return <svg className="topbar-stat-spark" />;
  const w = 56;
  const h = 14;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  const pts = samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="topbar-stat-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Condensed host metrics block rendered inside the top bar.
 *
 * Each metric (CPU, RAM, Disk) is a button: clicking it opens a popover with a
 * large interactive Sparkline (hover tooltip), mirroring the expandable process
 * MetricChips. Only one metric is expanded at a time.
 *
 * @param {{
 *   samples: { sampled_at: number, cpu: number, ram: number, disk: number }[],
 *   current?: {
 *     cpu: number|null,
 *     ram: number|null,
 *     disk: number|null,
 *   } | null,
 * }} props
 */
export default function HostMetrics({ samples = [], current = null }) {
  /** @type {[string|null, React.Dispatch<string|null>]} id of the expanded metric, or null */
  const [expanded, setExpanded] = useState(null);

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const cpuPct = current?.cpu ?? latest?.cpu ?? null;
  const ramPct = current?.ram ?? latest?.ram ?? null;
  const diskPct = current?.disk ?? latest?.disk ?? null;

  const stats = [
    { id: 'cpu', label: 'CPU', value: fmtPct(cpuPct), series: samples.map((s) => ({ t: s.sampled_at, v: s.cpu })), color: 'var(--accent)' },
    { id: 'ram', label: 'RAM', value: fmtPct(ramPct), series: samples.map((s) => ({ t: s.sampled_at, v: s.ram })), color: 'var(--success)' },
    { id: 'disk', label: 'Disk', value: fmtPct(diskPct), series: samples.map((s) => ({ t: s.sampled_at, v: s.disk })), color: 'var(--info)' },
  ];

  const active = stats.find((s) => s.id === expanded) || null;

  return (
    <div className="topbar-host">
      <span className="topbar-host-label">Host</span>
      {stats.map((stat) => (
        <button
          key={stat.id}
          type="button"
          className={`topbar-host-stat${expanded === stat.id ? ' active' : ''}`}
          onClick={() => setExpanded(expanded === stat.id ? null : stat.id)}
          aria-expanded={expanded === stat.id}
        >
          <span className="topbar-stat-label">{stat.label}</span>
          <span className="topbar-stat-value">{stat.value}</span>
          <MiniSpark samples={stat.series.map((p) => p.v)} color={stat.color} />
        </button>
      ))}
      {active && (
        <>
          <div className="host-popover-backdrop" onClick={() => setExpanded(null)} />
          <div className="host-popover" role="dialog" aria-label={`Host ${active.label} history`}>
            <div className="host-popover-head">
              <span className="host-popover-label">Host {active.label}</span>
              <strong className="host-popover-value">{active.value}</strong>
            </div>
            <div className="host-popover-spark">
              {active.series.length >= 2 ? (
                <Sparkline
                  samples={active.series}
                  formatValue={(v) => `${v.toFixed(1)}%`}
                  color={active.color}
                  height="100%"
                />
              ) : (
                <span className="metric-chip-no-data">No history yet</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

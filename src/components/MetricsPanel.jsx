/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import Sparkline from './Sparkline.jsx';
import { formatBytes } from '../services/format.js';

/**
 * One metric with its history drawn underneath.
 *
 * @param {{
 *   label: string,
 *   value: string,
 *   samples: { t: number, v: number }[],
 *   formatValue: (v: number) => string,
 *   color: string,
 *   note?: string,
 *   loading?: boolean,
 * }} props
 */
function MetricCard({ label, value, samples, formatValue, color, note, loading = false }) {
  return (
    <div className="metric-card">
      <div className="metric-card-head">
        <span className="metric-card-label">{label}</span>
        <span className="metric-card-value">{value}</span>
      </div>
      {loading ? (
        <div className="metric-card-skeleton" />
      ) : samples.length >= 2 ? (
        <div className="metric-card-chart">
          <Sparkline samples={samples} formatValue={formatValue} color={color} height="100%" />
        </div>
      ) : (
        <div className="metric-card-nodata">Not enough history yet</div>
      )}
      {note && <span className="metric-card-foot">{note}</span>}
    </div>
  );
}

/**
 * Metrics tab.
 *
 * Shows process history and host history side by side, every chart drawn at
 * once. Host CPU, RAM and disk used to sit in the top bar as three small
 * buttons whose charts opened in transient popovers, which made them easy to
 * miss and impossible to compare against the process they belong to.
 *
 * @param {{
 *   details: object | null,
 *   metricsHistory: object[],
 *   hostSamples: object[],
 *   hostCurrent: object | null,
 *   isMonitored: boolean,
 *   onEnableMonitoring: () => void,
 * }} props
 */
export default function MetricsPanel({
  details,
  metricsHistory = [],
  hostSamples = [],
  hostCurrent = null,
  isMonitored,
  onEnableMonitoring,
}) {
  const pct = (v) => `${v.toFixed(1)}%`;
  const latestHost = hostSamples.length > 0 ? hostSamples[hostSamples.length - 1] : null;

  const hostStats = [
    { label: 'Host CPU', current: hostCurrent?.cpu ?? latestHost?.cpu, key: 'cpu', color: 'var(--accent)' },
    { label: 'Host RAM', current: hostCurrent?.ram ?? latestHost?.ram, key: 'ram', color: 'var(--success)' },
    { label: 'Host disk', current: hostCurrent?.disk ?? latestHost?.disk, key: 'disk', color: 'var(--info)' },
  ];

  return (
    <div className="metrics-panel fade-in">
      <section>
        <div className="metrics-group-head">
          <h2 className="manage-section-title">This process</h2>
          <span className="hint">{isMonitored ? 'Sampled every 20 s, kept for 24 hours' : 'Live values only'}</span>
        </div>

        {!isMonitored && (
          <div className="metrics-notice">
            <p className="hint">History is not stored for this process, so these charts stay empty.</p>
            <button type="button" className="btn btn--sm" onClick={onEnableMonitoring}>
              Turn on monitoring
            </button>
          </div>
        )}

        <div className="metrics-grid">
          <MetricCard
            label="CPU"
            value={details ? `${details.process.cpu}%` : '--'}
            samples={metricsHistory.map((s) => ({ t: s.sampled_at, v: s.cpu }))}
            formatValue={pct}
            color="var(--accent)"
          />
          <MetricCard
            label="Memory"
            value={details ? formatBytes(details.process.memory) : '--'}
            samples={metricsHistory.map((s) => ({ t: s.sampled_at, v: s.memory }))}
            formatValue={formatBytes}
            color="var(--success)"
          />
        </div>
      </section>

      <section>
        <div className="metrics-group-head">
          <h2 className="manage-section-title">Host</h2>
          <span className="hint">The machine this process runs on</span>
        </div>

        <div className="metrics-grid">
          {hostStats.map((stat) => (
            <MetricCard
              key={stat.key}
              label={stat.label}
              value={stat.current != null ? pct(stat.current) : '--'}
              samples={hostSamples.map((s) => ({ t: s.sampled_at, v: s[stat.key] }))}
              formatValue={pct}
              color={stat.color}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

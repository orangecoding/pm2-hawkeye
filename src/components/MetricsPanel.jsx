/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import Sparkline from './Sparkline.jsx';
import { formatBytes, formatDuration, formatMetricValue } from '../services/format.js';

/**
 * One metric with its history drawn underneath.
 *
 * The `id` is the scroll target for the matching readout in the top bar or the
 * process header, which are shortcuts into this panel rather than second homes
 * for the chart.
 *
 * @param {{
 *   id?: string,
 *   label: string,
 *   value: string,
 *   samples: { t: number, v: number }[],
 *   formatValue: (v: number) => string,
 *   color: string,
 * }} props
 */
function MetricCard({ id, label, value, samples, formatValue, color }) {
  return (
    <div className="metric-card" id={id}>
      <div className="metric-card-head">
        <span className="metric-card-label">{label}</span>
        <span className="metric-card-value">{value}</span>
      </div>
      {samples.length >= 2 ? (
        <div className="metric-card-chart">
          <Sparkline samples={samples} formatValue={formatValue} color={color} height="100%" />
        </div>
      ) : (
        <div className="metric-card-nodata">Not enough history yet</div>
      )}
    </div>
  );
}

/**
 * Extend a stored series with the live value at `now`.
 *
 * The scheduler skips samples whose value did not change, so a steady metric
 * can sit on a single stored sample for hours and never reach the two points
 * a chart needs. Appending the live reading lets the step line run up to the
 * present. Without history, or without a live value, the series is unchanged.
 *
 * @param {{ t: number, v: number }[]} samples - Stored samples, oldest first.
 * @param {number | null | undefined} liveValue
 * @param {number} now - Current time in ms.
 * @returns {{ t: number, v: number }[]}
 */
function withLivePoint(samples, liveValue, now) {
  const lastT = samples.at(-1)?.t;
  if (lastT == null || liveValue == null || now <= lastT) return samples;
  return [...samples, { t: now, v: liveValue }];
}

/**
 * Combine the live application metrics from the details push with their
 * stored history into one list, sorted by name.
 *
 * A metric can be live without history (monitoring off, or just registered)
 * or have history without a live value (the process restarted and has not
 * reported it again yet), so the names of both sides are merged. The live
 * value wins; otherwise the newest stored sample stands in.
 *
 * @param {{ name: string, value: number, unit: string | null }[]} live
 * @param {{ name: string, unit: string | null, samples: { sampled_at: number, value: number }[] }[]} history
 * @param {number} now - Current time in ms.
 * @returns {{ name: string, unit: string | null, current: number | null, samples: { t: number, v: number }[] }[]}
 */
function mergeAppMetrics(live, history, now) {
  const byName = new Map();
  for (const series of history) {
    byName.set(series.name, {
      name: series.name,
      unit: series.unit,
      current: series.samples.at(-1)?.value ?? null,
      samples: series.samples.map((s) => ({ t: s.sampled_at, v: s.value })),
    });
  }
  for (const metric of live) {
    const entry = byName.get(metric.name) ?? { name: metric.name, samples: [] };
    byName.set(metric.name, {
      ...entry,
      unit: metric.unit,
      current: metric.value,
      samples: withLivePoint(entry.samples, metric.value, now),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Metrics tab.
 *
 * Shows process history and host history side by side, every chart drawn at
 * once. Host CPU, RAM and disk used to sit in the top bar as three small
 * buttons whose charts opened in transient popovers, which made them easy to
 * miss and impossible to compare against the process they belong to.
 *
 * Between the two sits one chart per application metric the process reports
 * through tx2 or @pm2/io: live values from `details.customMetrics`, history
 * from `customMetricsHistory`.
 *
 * @param {{
 *   details: object | null,
 *   metricsHistory: object[],
 *   customMetricsHistory?: { name: string, unit: string | null, samples: { sampled_at: number, value: number }[] }[],
 *   hostSamples: object[],
 *   hostCurrent: object | null,
 *   isMonitored: boolean,
 *   metricsRetentionMs?: number,
 *   onEnableMonitoring: () => void,
 * }} props
 */
export default function MetricsPanel({
  details,
  metricsHistory = [],
  customMetricsHistory = [],
  hostSamples = [],
  hostCurrent = null,
  isMonitored,
  metricsRetentionMs = 24 * 60 * 60 * 1000,
  onEnableMonitoring,
}) {
  const pct = (v) => `${v.toFixed(1)}%`;
  const retention = formatDuration(metricsRetentionMs);
  const latestHost = hostSamples.length > 0 ? hostSamples[hostSamples.length - 1] : null;
  const now = Date.now();
  const appMetrics = mergeAppMetrics(details?.customMetrics ?? [], customMetricsHistory, now);
  const cpuSamples = withLivePoint(
    metricsHistory.map((s) => ({ t: s.sampled_at, v: s.cpu })),
    details?.process.cpu,
    now,
  );
  const memorySamples = withLivePoint(
    metricsHistory.map((s) => ({ t: s.sampled_at, v: s.memory })),
    details?.process.memory,
    now,
  );

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
          <span className="hint">{isMonitored ? `Sampled every 20 s, kept for ${retention}` : 'Live values only'}</span>
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
            id="metric-cpu"
            label="CPU"
            value={details ? `${details.process.cpu}%` : '--'}
            samples={cpuSamples}
            formatValue={pct}
            color="var(--accent)"
          />
          <MetricCard
            id="metric-mem"
            label="Memory"
            value={details ? formatBytes(details.process.memory) : '--'}
            samples={memorySamples}
            formatValue={formatBytes}
            color="var(--success)"
          />
        </div>
      </section>

      <section>
        <div className="metrics-group-head">
          <h2 className="manage-section-title">Application metrics</h2>
          <span className="hint">Reported by the process through tx2 or @pm2/io</span>
        </div>

        {appMetrics.length > 0 ? (
          <div className="metrics-grid">
            {appMetrics.map((metric) => (
              <MetricCard
                key={metric.name}
                label={metric.name}
                value={metric.current != null ? formatMetricValue(metric.current, metric.unit) : '--'}
                samples={metric.samples}
                formatValue={(v) => formatMetricValue(v, metric.unit)}
                color="var(--info)"
              />
            ))}
          </div>
        ) : (
          <p className="hint">
            {details
              ? 'This process reports no metrics. Register some with tx2.metric() or @pm2/io to chart them here.'
              : 'Waiting for the first reading.'}
          </p>
        )}
      </section>

      <section>
        <div className="metrics-group-head">
          <h2 className="manage-section-title">Host</h2>
          <span className="hint">The machine this process runs on, last {retention}</span>
        </div>

        <div className="metrics-grid">
          {hostStats.map((stat) => (
            <MetricCard
              key={stat.key}
              id={`metric-host-${stat.key}`}
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

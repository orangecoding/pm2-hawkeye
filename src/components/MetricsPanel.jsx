/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import TimeSeriesChart from './TimeSeriesChart.jsx';
import { Info } from './Icon.jsx';
import { byteAxisUnit, findPeak, formatClock, niceCeil } from '../services/chart.js';
import { formatBytes, formatMetricValue, formatShortDuration, parseMemorySize } from '../services/format.js';

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
 * Cut a comparison series down to the window of the series it is compared
 * with. The sample in force at the window start is kept, moved to the start,
 * so the step line begins at the left edge.
 *
 * @param {{ t: number, v: number }[]} samples
 * @param {number | undefined} from - Window start, Unix ms.
 * @returns {{ t: number, v: number }[]}
 */
function clipToWindow(samples, from) {
  if (from == null) return samples;
  const before = samples.filter((s) => s.t <= from).at(-1);
  const inside = samples.filter((s) => s.t > from);
  return before ? [{ t: from, v: before.v }, ...inside] : inside;
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
 * One process chart: label and peak, the current value, a legend when it
 * compares series, then the chart. The `id` is the scroll target of the
 * matching readout in the process header.
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   value: string,
 *   peak: string | null,
 *   series: { name: string, color: string, dashed?: boolean }[],
 *   children: React.ReactNode,
 * }} props - `peak` is the formatted "24 h peak" line, or null without history.
 */
function ProcessChartCard({ id, label, value, peak, series, children }) {
  return (
    <div className="chart-card" id={id}>
      <div className="chart-card-head">
        <span className="chart-card-label">{label}</span>
        {peak && <span className="chart-card-peak">{peak}</span>}
      </div>
      <span className="chart-card-value">{value}</span>
      {series.length > 1 && (
        <div className="chart-card-legend">
          {series.map((s) => (
            <span key={s.name}>
              <span
                className="chart-card-legend-key"
                style={{ borderTopColor: s.color, borderTopStyle: s.dashed ? 'dashed' : 'solid' }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="chart-card-plot">{children}</div>
    </div>
  );
}

/**
 * Metrics tab: the process's CPU and memory, then one small chart per
 * application metric it reports through tx2 or @pm2/io.
 *
 * Host CPU is drawn into the CPU chart for comparison; host RAM and disk live
 * on the Overview, since they do not belong to any one process.
 *
 * @param {{
 *   processName: string,
 *   details: object | null,
 *   metricsHistory: object[],
 *   customMetricsHistory?: { name: string, unit: string | null, samples: { sampled_at: number, value: number }[] }[],
 *   hostSamples: { sampled_at: number, cpu: number }[],
 *   isMonitored: boolean,
 *   metricsRetentionMs?: number,
 *   memoryLimit?: string | number | null,
 *   onEnableMonitoring: () => void,
 *   onShowHost: () => void,
 * }} props - `memoryLimit` is the deployment's `max_memory_restart`, drawn
 *   as a threshold on the memory chart.
 */
export default function MetricsPanel({
  processName,
  details,
  metricsHistory = [],
  customMetricsHistory = [],
  hostSamples = [],
  isMonitored,
  metricsRetentionMs = 24 * 60 * 60 * 1000,
  memoryLimit = null,
  onEnableMonitoring,
  onShowHost,
}) {
  const pct = (v) => `${Math.round(v * 10) / 10}%`;
  const windowLabel = formatShortDuration(metricsRetentionMs);
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
  const hostCpuSamples = clipToWindow(
    hostSamples.filter((s) => s.cpu != null).map((s) => ({ t: s.sampled_at, v: s.cpu })),
    cpuSamples[0]?.t,
  );

  const cpuSeries = [
    { name: processName, color: 'var(--accent)', samples: cpuSamples },
    { name: 'Host CPU', color: 'var(--muted)', samples: hostCpuSamples, dashed: true },
  ];
  const memorySeries = [{ name: processName, color: 'var(--success)', samples: memorySamples }];

  // Memory is labelled in one binary unit picked from the larger of the data
  // and the restart limit, so the ticks read 0 / 200 / 400 MB, not raw bytes.
  const limitBytes = parseMemorySize(memoryLimit);
  const memoryTop = Math.max(0, ...memorySamples.map((s) => s.v), limitBytes ?? 0);
  const memoryUnit = byteAxisUnit(memoryTop);
  const memoryMax = niceCeil(memoryTop / memoryUnit.unit) * memoryUnit.unit;

  /**
   * The "24 h peak" line of a series, or null without samples.
   *
   * @param {{ t: number, v: number }[]} samples
   * @param {(v: number) => string} format
   */
  const peakLine = (samples, format) => {
    const peak = findPeak(samples);
    return peak ? (
      <>
        {windowLabel} peak <span className="num">{format(peak.v)}</span> at {formatClock(peak.t)}
      </>
    ) : null;
  };

  return (
    <div className="metrics-panel fade-in">
      <section className="metrics-section" aria-labelledby="metrics-process">
        <div className="section-head">
          <h2 id="metrics-process" className="card-title">
            This process
          </h2>
          <span className="hint">
            {isMonitored ? `Sampled every 20 s, kept for ${windowLabel}.` : 'Live values only.'} Hover a chart for exact
            values.
          </span>
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
          <ProcessChartCard
            id="metric-cpu"
            label="CPU"
            value={details ? `${details.process.cpu}%` : '--'}
            peak={peakLine(cpuSamples, pct)}
            series={cpuSeries}
          >
            <TimeSeriesChart
              series={cpuSeries}
              height={160}
              axisWidth={44}
              formatValue={pct}
              formatTick={(v) => `${v}%`}
              label={`CPU of ${processName} and of the host over the last ${windowLabel}`}
            />
          </ProcessChartCard>
          <ProcessChartCard
            id="metric-mem"
            label="Memory"
            value={details ? formatBytes(details.process.memory) : '--'}
            peak={peakLine(memorySamples, formatBytes)}
            series={memorySeries}
          >
            <TimeSeriesChart
              series={memorySeries}
              height={160}
              axisWidth={44}
              max={memoryMax}
              ticks={[0, memoryMax / 2, memoryMax]}
              formatValue={formatBytes}
              formatTick={(v) => `${v / memoryUnit.unit} ${memoryUnit.label}`}
              threshold={
                limitBytes ? { value: limitBytes, label: `PM2 restarts it above ${formatBytes(limitBytes)}` } : null
              }
              label={`Memory of ${processName} over the last ${windowLabel}${
                limitBytes ? `. PM2 restarts it above ${formatBytes(limitBytes)}` : ''
              }`}
            />
          </ProcessChartCard>
        </div>
      </section>

      <section className="metrics-section" aria-labelledby="metrics-app">
        <div className="section-head">
          <h2 id="metrics-app" className="card-title">
            Application metrics
          </h2>
          <span className="hint">Reported by the process through tx2 or @pm2/io</span>
        </div>

        {appMetrics.length > 0 ? (
          <div className="metrics-grid metrics-grid--small">
            {appMetrics.map((metric) => {
              const format = (v) => formatMetricValue(v, metric.unit);
              const value = metric.current != null ? format(metric.current) : '--';
              return (
                <div className="chart-card chart-card--small" key={metric.name}>
                  <div className="chart-card-head">
                    <span className="chart-card-label">{metric.name}</span>
                    <span className="chart-card-value chart-card-value--small">{value}</span>
                  </div>
                  <TimeSeriesChart
                    series={[{ name: metric.name, color: 'var(--info)', samples: metric.samples }]}
                    height={56}
                    compact
                    formatValue={format}
                    label={`${metric.name} over the last ${windowLabel}`}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="hint">
            {details
              ? 'This process reports no metrics. Register some with tx2.metric() or @pm2/io to chart them here.'
              : 'Waiting for the first reading.'}
          </p>
        )}
      </section>

      <p className="metrics-host-note">
        <Info size={14} />
        Host RAM and disk live on the Overview.
        <a
          href="#host"
          onClick={(e) => {
            e.preventDefault();
            onShowHost();
          }}
        >
          Open host metrics
        </a>
      </p>
    </div>
  );
}

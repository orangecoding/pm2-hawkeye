/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import TimeSeriesChart from './TimeSeriesChart.jsx';
import { pressure } from './HostMetrics.jsx';
import { CheckCircle, Warning, WarningCircle } from './Icon.jsx';
import { findPeak, formatClock } from '../services/chart.js';
import { formatBytesOf, formatShortDuration } from '../services/format.js';

/**
 * Format a host percentage, rounded like the top bar readout.
 *
 * @param {number} v
 * @returns {string}
 */
const pct = (v) => `${Math.round(v)}%`;

/**
 * One host chart card: label and pressure tag, the current value with what it
 * means in absolute terms, the peak of the stored window, then the chart.
 *
 * The value itself is never coloured; the tag carries the pressure, using the
 * same thresholds as the top bar.
 *
 * @param {{
 *   label: string,
 *   color: string,
 *   samples: { t: number, v: number }[],
 *   current: number | null,
 *   sub: string,
 *   windowLabel: string,
 * }} props
 */
function HostCard({ label, color, samples, current, sub, windowLabel }) {
  const level = pressure(current);
  const peak = findPeak(samples);
  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <span className="chart-card-label">{label}</span>
        {level !== 'normal' && (
          <span className={`tag ${level === 'critical' ? 'tag--critical' : 'tag--warning'}`}>
            <WarningCircle size={11} weight="fill" />
            {level === 'critical' ? 'Critical' : 'High'}
          </span>
        )}
      </div>
      <div className="chart-card-reading">
        <span className="chart-card-value">{current != null ? pct(current) : '--'}</span>
        <span className="hint">{sub}</span>
      </div>
      {peak && (
        <p className="chart-card-peak">
          {windowLabel} peak <span className="num">{pct(peak.v)}</span> at {formatClock(peak.t)}
        </p>
      )}
      <div className="chart-card-plot">
        <TimeSeriesChart
          series={[{ name: `Host ${label}`, color, samples }]}
          height={120}
          max={100}
          ticks={[0, 50, 100]}
          formatValue={pct}
          label={`Host ${label} over the last ${windowLabel}`}
        />
      </div>
    </div>
  );
}

/**
 * The home screen, shown while nothing is selected: what needs attention, then
 * the host charts. There is deliberately no process table; the sidebar is the
 * only process list.
 *
 * @param {{
 *   processes: { status: string }[],
 *   offlineCount: number,
 *   attentionItems: ReturnType<typeof import('../services/attention.js').buildAttentionItems>,
 *   hostSamples: { sampled_at: number, cpu: number, ram: number, disk: number }[],
 *   hostCurrent: { cpu: number|null, ram: number|null, disk: number|null,
 *     ramUsed?: number|null, ramTotal?: number|null, diskUsed?: number|null, diskTotal?: number|null } | null,
 *   metricsRetentionMs?: number,
 *   onOpenLogs: (processKey: number|string) => void,
 *   onOpenDeployment: (deploymentId: string) => void,
 *   onShowHost: () => void,
 * }} props - `offlineCount` is the number of deployments without a PM2
 *   process, counted as not running.
 */
export default function Overview({
  processes,
  offlineCount,
  attentionItems,
  hostSamples,
  hostCurrent,
  metricsRetentionMs = 24 * 60 * 60 * 1000,
  onOpenLogs,
  onOpenDeployment,
  onShowHost,
}) {
  const total = processes.length + offlineCount;
  const running = processes.filter((p) => String(p.status ?? '').toLowerCase() === 'online').length;
  const windowLabel = formatShortDuration(metricsRetentionMs);
  const latest = hostSamples.at(-1) ?? null;
  const series = (key) => hostSamples.map((s) => ({ t: s.sampled_at, v: s[key] })).filter((s) => s.v != null);
  const used = (usedKey, totalKey) =>
    hostCurrent?.[usedKey] != null && hostCurrent?.[totalKey] != null
      ? `${formatBytesOf(hostCurrent[usedKey], hostCurrent[totalKey])} used`
      : '';

  /**
   * Run the action of an attention row.
   *
   * @param {{ kind: string, processKey?: number|string, deploymentId?: string }} action
   */
  const act = (action) => {
    if (action.kind === 'logs') onOpenLogs(action.processKey);
    else if (action.kind === 'deployment') onOpenDeployment(action.deploymentId);
    else onShowHost();
  };

  return (
    <div className="overview fade-in">
      <div>
        <h1 className="overview-title">Overview</h1>
        <p className="overview-sub">
          {total} {total === 1 ? 'process' : 'processes'}. {running} running, {total - running} not running.
        </p>
      </div>

      <section className="card" aria-labelledby="attention-title">
        <div className="attention-head">
          <h2 id="attention-title" className="card-title">
            Needs attention
          </h2>
          {attentionItems.length > 0 && <span className="tag tag--critical num">{attentionItems.length}</span>}
        </div>
        <ul className="attention-list">
          {attentionItems.length === 0 ? (
            <li className="attention-row">
              <CheckCircle size={16} weight="fill" className="attention-icon" data-level="ok" aria-hidden="true" />
              <div className="attention-text">
                <p className="attention-title">Nothing needs attention</p>
                <p className="attention-detail">Stopped processes are not counted.</p>
              </div>
            </li>
          ) : (
            attentionItems.map((item) => (
              <li className="attention-row" key={item.key}>
                {item.level === 'critical' ? (
                  <WarningCircle
                    size={16}
                    weight="fill"
                    className="attention-icon"
                    data-level="critical"
                    aria-label="Critical"
                  />
                ) : (
                  <Warning
                    size={16}
                    weight="fill"
                    className="attention-icon"
                    data-level="warning"
                    aria-label="Warning"
                  />
                )}
                <div className="attention-text">
                  <p className="attention-title">{item.title}</p>
                  <p className="attention-detail">{item.detail}</p>
                </div>
                <button type="button" className="btn btn--sm btn--sunken" onClick={() => act(item.action)}>
                  {item.action.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section id="host" className="overview-host" aria-labelledby="host-title">
        <div className="section-head">
          <h2 id="host-title" className="card-title">
            Host
          </h2>
          <span className="hint">
            This machine. Sampled every 20 s, kept for {windowLabel}. Hover a chart for exact values.
          </span>
        </div>
        <div className="host-grid">
          <HostCard
            label="CPU"
            color="var(--accent)"
            samples={series('cpu')}
            current={hostCurrent?.cpu ?? latest?.cpu ?? null}
            sub="average across all cores"
            windowLabel={windowLabel}
          />
          <HostCard
            label="RAM"
            color="var(--success)"
            samples={series('ram')}
            current={hostCurrent?.ram ?? latest?.ram ?? null}
            sub={used('ramUsed', 'ramTotal')}
            windowLabel={windowLabel}
          />
          <HostCard
            label="Disk"
            color="var(--info)"
            samples={series('disk')}
            current={hostCurrent?.disk ?? latest?.disk ?? null}
            sub={used('diskUsed', 'diskTotal')}
            windowLabel={windowLabel}
          />
        </div>
      </section>
    </div>
  );
}

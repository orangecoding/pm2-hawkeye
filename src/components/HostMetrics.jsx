/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';

/**
 * Classify a utilisation percentage so the number can carry its own warning.
 *
 * @param {number|null|undefined} pct
 * @returns {'normal'|'warn'|'critical'}
 */
function pressure(pct) {
  if (pct == null) return 'normal';
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warn';
  return 'normal';
}

/**
 * Host health readout in the top bar.
 *
 * States the three numbers. These used to be three buttons, each opening its
 * own popover chart from the top bar, which put a chart surface in the least
 * expected place in the app. The charts live in the Metrics tab now, next to
 * the process charts they should be compared against, and each number is a
 * shortcut that jumps to its chart there rather than drawing its own.
 *
 * Without `onShowMetrics` (no process selected, so there is no Metrics tab to
 * jump to) the numbers render as plain text instead of dead buttons.
 *
 * @param {{
 *   samples: { sampled_at: number, cpu: number, ram: number, disk: number }[],
 *   current?: { cpu: number|null, ram: number|null, disk: number|null } | null,
 *   onShowMetrics?: ((chartId: string) => void) | null,
 * }} props
 */
export default function HostMetrics({ samples = [], current = null, onShowMetrics = null }) {
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const stats = [
    { label: 'CPU', value: current?.cpu ?? latest?.cpu ?? null, chartId: 'metric-host-cpu' },
    { label: 'RAM', value: current?.ram ?? latest?.ram ?? null, chartId: 'metric-host-ram' },
    { label: 'Disk', value: current?.disk ?? latest?.disk ?? null, chartId: 'metric-host-disk' },
  ];

  return (
    <div className="host-readout">
      <span className="host-readout-label">Host</span>
      {stats.map((stat) => {
        const body = (
          <>
            <span className="host-stat-label">{stat.label}</span>
            <span className="host-stat-value" data-level={pressure(stat.value)}>
              {stat.value != null ? `${stat.value.toFixed(0)}%` : '--'}
            </span>
          </>
        );

        return onShowMetrics ? (
          <button
            type="button"
            className="host-stat host-stat--link"
            key={stat.label}
            title={`Show host ${stat.label} history in Metrics`}
            onClick={() => onShowMetrics(stat.chartId)}
          >
            {body}
          </button>
        ) : (
          <span className="host-stat" key={stat.label}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

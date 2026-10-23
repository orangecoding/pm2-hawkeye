/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';

/**
 * Classify a utilisation percentage so the number can carry its own warning.
 * The Overview host cards use the same thresholds for their High and
 * Critical tags.
 *
 * @param {number|null|undefined} pct
 * @returns {'normal'|'warn'|'critical'}
 */
export function pressure(pct) {
  if (pct == null) return 'normal';
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warn';
  return 'normal';
}

/**
 * Host health readout in the top bar.
 *
 * States the three numbers and is one link to the Overview's host section,
 * where they are charted. It works the same from every screen: the host is
 * not a property of the selected process, so it no longer jumps into a
 * process's Metrics tab.
 *
 * @param {{
 *   samples: { sampled_at: number, cpu: number, ram: number, disk: number }[],
 *   current?: { cpu: number|null, ram: number|null, disk: number|null } | null,
 *   onShowHost: () => void,
 * }} props
 */
export default function HostMetrics({ samples = [], current = null, onShowHost }) {
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const stats = [
    { label: 'CPU', value: current?.cpu ?? latest?.cpu ?? null },
    { label: 'RAM', value: current?.ram ?? latest?.ram ?? null },
    { label: 'Disk', value: current?.disk ?? latest?.disk ?? null },
  ];

  return (
    <a
      className="host-readout"
      href="#host"
      title="Host CPU, RAM and disk on the Overview"
      onClick={(e) => {
        e.preventDefault();
        onShowHost();
      }}
    >
      <span className="host-readout-label">Host</span>
      {stats.map((stat) => (
        <span className="host-stat" key={stat.label}>
          <span className="host-stat-label">{stat.label}</span>
          <span className="host-stat-value" data-level={pressure(stat.value)}>
            {stat.value != null ? `${stat.value.toFixed(0)}%` : '--'}
          </span>
        </span>
      ))}
    </a>
  );
}

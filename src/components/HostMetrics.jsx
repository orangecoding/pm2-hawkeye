/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import Sparkline from './Sparkline.jsx';

/**
 * Format a byte count as a compact gigabyte string.
 *
 * Values of 10 GB or more are rounded to whole numbers (e.g. "16", "460");
 * smaller values keep one decimal (e.g. "6.2") so low usage stays legible.
 *
 * @param {number|null|undefined} bytes
 * @returns {string|null} Formatted GB number, or null when input is unusable.
 */
function formatGb(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes)) return null;
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1);
}

/**
 * Build the big-number label for a memory/disk card: used/total GB plus the
 * percentage in parentheses, e.g. "10GB/16GB used (62.8%)". Falls back to the
 * plain percentage (or an em dash) when absolute byte values are unavailable.
 *
 * @param {number|null|undefined} used   - Used bytes.
 * @param {number|null|undefined} total  - Total bytes.
 * @param {number|null|undefined} percent - Usage percentage.
 * @returns {string}
 */
function byteValue(used, total, percent) {
  const usedGb = formatGb(used);
  const totalGb = formatGb(total);
  if (usedGb == null || totalGb == null) {
    return percent != null ? `${percent.toFixed(1)}%` : '—';
  }
  const pct = percent != null ? ` (${percent.toFixed(1)}%)` : '';
  return `${usedGb}GB/${totalGb}GB used${pct}`;
}

/**
 * Host-level metrics section showing CPU load, RAM usage, and Disk usage.
 *
 * Rendered unconditionally in the top-right grid cell (same row as the
 * sidebar-header) so server health is always visible regardless of which
 * process is selected.
 *
 * Each metric is displayed using the same .stat-card / .stat-label /
 * .stat-value / Sparkline pattern used in the per-process Runtime metrics
 * panel, so both sections have a consistent visual language.  The sparklines
 * always chart percentages; RAM and Disk additionally show absolute used/total
 * GB in the big-number line, sourced from the live `current` reading.
 *
 * @param {{
 *   samples: { sampled_at: number, cpu: number, ram: number, disk: number }[],
 *   current?: {
 *     cpu: number|null,
 *     ram: number|null, ramUsed: number|null, ramTotal: number|null,
 *     disk: number|null, diskUsed: number|null, diskTotal: number|null,
 *   } | null,
 * }} props
 */
export default function HostMetrics({ samples = [], current = null }) {
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const cpuPct = current?.cpu ?? latest?.cpu ?? null;
  const ramPct = current?.ram ?? latest?.ram ?? null;
  const diskPct = current?.disk ?? latest?.disk ?? null;

  /** @type {{ label: string, value: string, samples: {t:number,v:number}[], color: string, formatValue: (v:number) => string }[]} */
  const cards = [
    {
      label: 'CPU',
      value: cpuPct != null ? `${cpuPct.toFixed(1)}%` : '—',
      samples: samples.map((s) => ({ t: s.sampled_at, v: s.cpu })),
      color: 'var(--accent)',
      formatValue: (v) => `${v.toFixed(1)}%`,
    },
    {
      label: 'RAM',
      value: byteValue(current?.ramUsed, current?.ramTotal, ramPct),
      samples: samples.map((s) => ({ t: s.sampled_at, v: s.ram })),
      color: 'var(--success)',
      formatValue: (v) => `${v.toFixed(1)}%`,
    },
    {
      label: 'Disk',
      value: byteValue(current?.diskUsed, current?.diskTotal, diskPct),
      samples: samples.map((s) => ({ t: s.sampled_at, v: s.disk })),
      color: 'var(--info)',
      formatValue: (v) => `${v.toFixed(1)}%`,
    },
  ];

  return (
    <div className="host-metrics-bar">
      <p className="eyebrow">Host</p>
      <div className="host-metrics-cards">
        {cards.map((card) => (
          <div className="stat-card" key={card.label}>
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
            {card.samples.length >= 2 ? (
              <Sparkline samples={card.samples} formatValue={card.formatValue} color={card.color} height="100%" />
            ) : (
              <div className="sparkline-placeholder">
                <span>No data yet</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

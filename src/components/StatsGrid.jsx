/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';
import { formatBytes, formatRelativeTime, formatDate } from '../services/format.js';
import Sparkline from './Sparkline.jsx';

/**
 * Single expandable metric chip.
 *
 * Collapsed: shows label + value in a small pill button.
 * Expanded: shows label + value + inline sparkline.
 * Only one chip can be expanded at a time (controlled externally via expandedChip/onExpandChip).
 *
 * @param {{
 *   label: string,
 *   value: string,
 *   sub?: string,
 *   samples?: { t: number, v: number }[],
 *   formatValue?: (v: number) => string,
 *   color?: string,
 *   isExpanded: boolean,
 *   onToggle: () => void,
 * }} props
 */
function MetricChip({ label, value, sub, samples = [], formatValue, color = 'var(--accent)', isExpanded, onToggle }) {
  const hasSpark = samples.length >= 2;

  return (
    <button
      className={`metric-chip${isExpanded ? ' metric-chip--expanded' : ''}`}
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
    >
      <span className="metric-chip-head">
        <span className="metric-chip-label">{label}</span>
        <strong className="metric-chip-value">{value}</strong>
        {sub && !isExpanded && <span className="metric-chip-sub">{sub}</span>}
      </span>
      {isExpanded && (
        <div className="metric-chip-spark">
          {hasSpark ? (
            <Sparkline samples={samples} formatValue={formatValue || String} color={color} height="100%" />
          ) : (
            <span className="metric-chip-no-data">No history yet</span>
          )}
        </div>
      )}
      {isExpanded && sub && <span className="metric-chip-sub metric-chip-sub--expanded">{sub}</span>}
    </button>
  );
}

/**
 * Row of expandable MetricChips for CPU, Memory, Restarts, and Uptime.
 *
 * Clicking a chip expands it to show a sparkline; clicking again (or another
 * chip) collapses it. Only one chip is expanded at a time.
 *
 * @param {{
 *   details: object | null,
 *   error: string,
 *   metricsHistory: object[],
 *   expandedChip: string | null,
 *   onExpandChip: (id: string | null) => void,
 * }} props
 */
export default function StatsGrid({ details, error, metricsHistory = [], expandedChip, onExpandChip }) {
  const cpuSamples = metricsHistory.map((s) => ({ t: s.sampled_at, v: s.cpu }));
  const memorySamples = metricsHistory.map((s) => ({ t: s.sampled_at, v: s.memory }));

  const chips = details
    ? [
        {
          id: 'cpu',
          label: 'CPU',
          value: `${details.process.cpu}%`,
          samples: cpuSamples,
          formatValue: (v) => `${v.toFixed(1)}%`,
          color: 'var(--accent)',
        },
        {
          id: 'mem',
          label: 'Memory',
          value: formatBytes(details.process.memory),
          samples: memorySamples,
          formatValue: formatBytes,
          color: 'var(--success)',
        },
        {
          id: 'restarts',
          label: 'Restarts',
          value: String(details.process.restarts),
        },
        {
          id: 'uptime',
          label: 'Uptime',
          value: formatRelativeTime(details.process.uptime),
          sub: formatDate(details.process.uptime),
        },
      ]
    : null;

  if (!chips) {
    return (
      <div className="metric-chips-row">
        <div className="empty-card compact">
          <p>{error || 'No process metrics loaded yet.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="metric-chips-row">
      {chips.map((chip) => (
        <MetricChip
          key={chip.id}
          {...chip}
          isExpanded={expandedChip === chip.id}
          onToggle={() => onExpandChip(expandedChip === chip.id ? null : chip.id)}
        />
      ))}
    </div>
  );
}

/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useRef, useState } from 'react';

/**
 * SVG sparkline with time-proportional X axis and hover tooltip.
 *
 * X positions are based on the actual `t` (Unix ms) timestamp of each sample.
 * Since metrics are stored only when values change (deduplication), the chart
 * renders as a step function: each stored value is held flat until the next
 * stored sample, then jumps sharply.  This accurately represents stable periods
 * rather than implying a gradual change.  On hover the nearest original data
 * point is highlighted and a tooltip shows the formatted value plus the sample
 * timestamp.
 *
 * @param {{
 *   samples: { t: number, v: number }[],
 *   width?: number,
 *   height?: number,
 *   color?: string,
 *   formatValue?: (v: number) => string,
 * }} props
 */
export default function Sparkline({ samples, width = 120, height = 32, color = 'var(--accent)', formatValue }) {
  const wrapperRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);

  if (!samples || samples.length < 2) return null;

  const tMin = samples[0].t;
  const tMax = samples[samples.length - 1].t;
  const tRange = tMax - tMin || 1;

  const vals = samples.map((s) => s.v);
  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const vRange = vMax - vMin || 1;

  /**
   * Map a timestamp to an SVG X coordinate.
   * @param {number} t
   */
  function xPos(t) {
    return ((t - tMin) / tRange) * width;
  }

  /**
   * Map a value to an SVG Y coordinate (inverted: high value → low Y).
   * @param {number} v
   */
  function yPos(v) {
    return height - ((v - vMin) / vRange) * (height - 2) - 1;
  }

  /**
   * Convert sparse samples into step-function rendering points.
   *
   * For each sample, a hold point is inserted at the next sample's timestamp
   * but with the current sample's value.  This produces a horizontal segment
   * followed by a vertical jump at each change point.
   *
   * @param {{ t: number, v: number }[]} samps
   * @returns {{ t: number, v: number }[]}
   */
  function toStepPoints(samps) {
    const result = [];
    for (let i = 0; i < samps.length; i++) {
      result.push(samps[i]);
      if (i < samps.length - 1) {
        result.push({ t: samps[i + 1].t, v: samps[i].v });
      }
    }
    return result;
  }

  const stepPoints = toStepPoints(samples);
  const points = stepPoints.map((s) => `${xPos(s.t).toFixed(2)},${yPos(s.v).toFixed(2)}`).join(' ');
  const lastX = xPos(stepPoints[stepPoints.length - 1].t).toFixed(2);
  const areaPoints = `${points} ${lastX},${height} 0,${height}`;

  /** Find the sample closest to a given SVG X coordinate. */
  function nearestSample(svgX) {
    let best = samples[0];
    let bestDist = Math.abs(xPos(samples[0].t) - svgX);
    for (const s of samples) {
      const d = Math.abs(xPos(s.t) - svgX);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  function handleMouseMove(e) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const svgX = pct * width;
    const s = nearestSample(svgX);
    const sPct = xPos(s.t) / width;
    setTooltip({ pct: sPct, svgX: xPos(s.t), svgY: yPos(s.v), v: s.v, t: s.t });
  }

  function handleMouseLeave() {
    setTooltip(null);
  }

  const displayValue = tooltip
    ? (formatValue ? formatValue(tooltip.v) : tooltip.v.toFixed(1))
    : null;

  const displayTime = tooltip
    ? new Date(tooltip.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  // Shift tooltip left when near the right edge to keep it in view.
  const tooltipShift = tooltip && tooltip.pct > 0.65 ? 'translateX(-100%)' : 'translateX(-50%)';

  return (
    <div
      ref={wrapperRef}
      className="sparkline-wrapper"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        className="sparkline"
        style={{ display: 'block', width: '100%', height: `${height}px` }}
      >
        <polygon points={areaPoints} fill={color} opacity="0.12" />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {tooltip && (
          <>
            <line
              x1={tooltip.svgX.toFixed(2)}
              y1="0"
              x2={tooltip.svgX.toFixed(2)}
              y2={height}
              stroke={color}
              strokeWidth="0.75"
              strokeDasharray="2 2"
              opacity="0.5"
            />
            <circle cx={tooltip.svgX.toFixed(2)} cy={tooltip.svgY.toFixed(2)} r="2.5" fill={color} />
          </>
        )}
      </svg>
      {tooltip && (
        <div
          className="sparkline-tooltip"
          style={{ left: `${(tooltip.pct * 100).toFixed(1)}%`, transform: tooltipShift }}
        >
          <span className="sparkline-tooltip-value">{displayValue}</span>
          <span className="sparkline-tooltip-time">{displayTime}</span>
        </div>
      )}
    </div>
  );
}

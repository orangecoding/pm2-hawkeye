/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * SVG sparkline with time-proportional X axis and hover tooltip.
 *
 * The chart is drawn in a viewBox that matches the wrapper's measured pixel
 * size (1:1), so it always fills the full width and height with no aspect-ratio
 * letterboxing, and the hover mapping lines up exactly with the rendered chart.
 * A ResizeObserver keeps the measured size current as the layout changes.
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
 *   height?: number | string,
 *   color?: string,
 *   formatValue?: (v: number) => string,
 * }} props
 */
export default function Sparkline({ samples, height = 32, color = 'var(--accent)', formatValue }) {
  const wrapperRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Track the wrapper's rendered pixel size so the SVG coordinate space matches
  // the screen 1:1. useLayoutEffect + ResizeObserver re-measures on any layout
  // change (window resize, responsive breakpoints, flex reflow).
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setDims((prev) => (prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const heightStyle = typeof height === 'number' ? `${height}px` : height;

  if (!samples || samples.length < 2) return null;

  const w = dims.w;
  const h = dims.h;
  const ready = w > 1 && h > 1;

  const tMin = samples[0].t;
  const tMax = samples[samples.length - 1].t;
  const tRange = tMax - tMin || 1;

  const vals = samples.map((s) => s.v);
  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const vRange = vMax - vMin || 1;

  /**
   * Map a timestamp to an SVG X coordinate (in measured pixels).
   * @param {number} t
   */
  function xPos(t) {
    return ((t - tMin) / tRange) * w;
  }

  /**
   * Map a value to an SVG Y coordinate (inverted: high value → low Y).
   * @param {number} v
   */
  function yPos(v) {
    return h - ((v - vMin) / vRange) * (h - 2) - 1;
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
  const areaPoints = `${points} ${lastX},${h} 0,${h}`;

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
    const el = wrapperRef.current;
    if (!el || !ready) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const svgX = pct * w;
    const s = nearestSample(svgX);
    setTooltip({ pct: xPos(s.t) / w, svgX: xPos(s.t), svgY: yPos(s.v), v: s.v, t: s.t });
  }

  function handleMouseLeave() {
    setTooltip(null);
  }

  const displayValue = tooltip ? (formatValue ? formatValue(tooltip.v) : tooltip.v.toFixed(1)) : null;

  const displayTime = tooltip
    ? new Date(tooltip.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  // Shift tooltip left when near the right edge to keep it in view.
  const tooltipShift = tooltip && tooltip.pct > 0.65 ? 'translateX(-100%)' : 'translateX(-50%)';

  return (
    <div ref={wrapperRef} className="sparkline-wrapper" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
      <svg
        width="100%"
        height={heightStyle}
        viewBox={`0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="sparkline"
        style={{ display: 'block', width: '100%', height: heightStyle }}
      >
        {ready && (
          <>
            <polygon points={areaPoints} fill={color} opacity="0.12" />
            <polyline
              points={points}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {tooltip && (
              <>
                <line
                  x1={tooltip.svgX.toFixed(2)}
                  y1="0"
                  x2={tooltip.svgX.toFixed(2)}
                  y2={h}
                  stroke={color}
                  strokeWidth="0.75"
                  strokeDasharray="2 2"
                  opacity="0.5"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={tooltip.svgX.toFixed(2)} cy={tooltip.svgY.toFixed(2)} r="2.5" fill={color} />
              </>
            )}
          </>
        )}
      </svg>
      {ready && tooltip && (
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

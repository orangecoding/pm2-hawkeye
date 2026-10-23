/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { formatChartTime, hourTicks, niceCeil, sampleAt } from '../services/chart.js';

/** Space kept free above the highest and below the lowest value, in px. */
const PAD = 4;

/** Past this share of the width the tooltip flips to the left of the crosshair. */
const FLIP_AT = 0.62;

/**
 * Turn sparse samples into the corner points of a step line: every value is
 * held flat until the next sample, then jumps.
 *
 * The metrics scheduler skips unchanged samples, so joining samples with
 * straight segments would invent values that were never measured.
 *
 * @param {{ t: number, v: number }[]} samples
 * @returns {{ t: number, v: number }[]}
 */
function toStepPoints(samples) {
  const points = [];
  samples.forEach((sample, i) => {
    points.push(sample);
    if (i < samples.length - 1) points.push({ t: samples[i + 1].t, v: sample.v });
  });
  return points;
}

/**
 * Index of the sample whose time lies closest to `t`.
 *
 * @param {{ t: number }[]} samples
 * @param {number} t
 * @returns {number}
 */
function nearestIndex(samples, t) {
  let best = 0;
  samples.forEach((sample, i) => {
    if (Math.abs(sample.t - t) < Math.abs(samples[best].t - t)) best = i;
  });
  return best;
}

/**
 * A short coloured line, the key of a series in the tooltip.
 *
 * @param {{ color: string, dashed?: boolean }} props
 */
function LineKey({ color, dashed }) {
  return <span className="ts-key" style={{ borderTopColor: color, borderTopStyle: dashed ? 'dashed' : 'solid' }} />;
}

/**
 * Time-series chart with axes, hover and keyboard reading.
 *
 * The SVG is drawn in a coordinate space measured with a ResizeObserver, so it
 * maps 1:1 to pixels and strokes stay crisp at any width. Lines are step
 * functions (see {@link toStepPoints}).
 *
 * Hovering snaps to the nearest sample of the first series and shows one
 * tooltip for all series; the others report the sample at or before that
 * time. The plot is focusable: focus selects the newest sample and the left
 * and right arrow keys step through the samples.
 *
 * In `compact` mode there are no axes, only a baseline, and the tooltip sits
 * above the plot.
 *
 * @param {{
 *   series: { name: string, color: string, samples: { t: number, v: number }[], dashed?: boolean, area?: boolean }[],
 *   height: number,
 *   max?: number,
 *   ticks?: number[],
 *   formatValue: (v: number) => string,
 *   formatTick?: (v: number) => string,
 *   threshold?: { value: number, label: string } | null,
 *   compact?: boolean,
 *   axisWidth?: number,
 *   label: string,
 * }} props - `height` in px (120 host, 160 process, 56 compact). Without
 *   `max` the Y axis ends at a nice ceiling of the data (and threshold); it
 *   always starts at 0. Without `ticks` a full chart labels 0, half and max.
 *   `area` defaults to true unless the series is dashed. `axisWidth` is the
 *   px width of the Y label column: 32 fits percentages, 44 fits sizes such
 *   as `400 MB`. `label` is the
 *   accessible name, e.g. 'Host CPU over the last 24 hours'.
 */
export default function TimeSeriesChart({
  series,
  height,
  max,
  ticks,
  formatValue,
  formatTick = formatValue,
  threshold = null,
  compact = false,
  axisWidth = 32,
  label,
}) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  /** Index into the first series' samples, or null when nothing is hovered. */
  const [hover, setHover] = useState(null);
  const primary = series[0]?.samples ?? [];
  const hasData = primary.length >= 2;

  // Measure the plot so the SVG coordinate space equals its pixel size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasData]);

  if (!hasData) {
    return (
      <div className="ts-nodata" style={{ height }}>
        Not enough history yet
      </div>
    );
  }

  const all = series.flatMap((s) => s.samples);
  const t0 = Math.min(...series.filter((s) => s.samples.length).map((s) => s.samples[0].t));
  const t1 = Math.max(...all.map((s) => s.t));
  const span = t1 - t0 || 1;
  const top = max ?? niceCeil(Math.max(...all.map((s) => s.v), threshold?.value ?? 0));
  const yTicks = compact ? [] : (ticks ?? [0, top / 2, top]);

  const xPx = (t) => ((t - t0) / span) * width;
  const xPct = (t) => ((t - t0) / span) * 100;
  const yPx = (v) => height - PAD - (Math.min(Math.max(v, 0), top) / top) * (height - 2 * PAD);

  const index = hover == null ? null : Math.min(hover, primary.length - 1);
  const hoverT = index == null ? null : primary[index].t;
  const hoverPct = hoverT == null ? 0 : xPct(hoverT);
  const rows =
    hoverT == null
      ? []
      : series
          .map((s) => ({ ...s, sample: s === series[0] ? primary[index] : sampleAt(s.samples, hoverT) }))
          .filter((s) => s.sample);

  const current = primary.at(-1).v;
  const ariaLabel = `${label}, now ${formatValue(current)}. Use the arrow keys to read values.`;

  /**
   * Snap the hover to the sample nearest the pointer.
   *
   * @param {React.PointerEvent<HTMLDivElement>} e
   */
  const onPointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const share = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
    setHover(nearestIndex(primary, t0 + share * span));
  };

  /**
   * Step through samples with the arrow keys.
   *
   * @param {React.KeyboardEvent<HTMLDivElement>} e
   */
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const from = index ?? primary.length - 1;
    const next = from + (e.key === 'ArrowLeft' ? -1 : 1);
    setHover(Math.max(0, Math.min(primary.length - 1, next)));
  };

  let tooltipStyle;
  if (compact) {
    const share = hoverPct / 100;
    const shift = share > 0.7 ? '-100%' : share < 0.3 ? '0' : '-50%';
    tooltipStyle = { left: `${hoverPct}%`, transform: `translateX(${shift})` };
  } else {
    const shift = hoverPct / 100 > FLIP_AT ? 'calc(-100% - var(--s-3))' : 'var(--s-3)';
    tooltipStyle = { left: `${hoverPct}%`, transform: `translateX(${shift})` };
  }

  const plot = (
    <div className="ts-plot-wrap" ref={wrapRef} style={{ height }}>
      <div
        className="ts-plot"
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover(primary.length - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        {width > 0 && (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {compact ? (
              <line className="ts-grid ts-grid--base" x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} />
            ) : (
              yTicks.map((tick) => (
                <line
                  key={tick}
                  className={tick === 0 ? 'ts-grid ts-grid--base' : 'ts-grid'}
                  x1="0"
                  x2={width}
                  y1={Math.round(yPx(tick)) + 0.5}
                  y2={Math.round(yPx(tick)) + 0.5}
                />
              ))
            )}
            {series.map((s) => {
              if (s.samples.length === 0) return null;
              const points = toStepPoints(s.samples)
                .map((p) => `${xPx(p.t).toFixed(1)},${yPx(p.v).toFixed(1)}`)
                .join(' ');
              const showArea = s.area ?? !s.dashed;
              const firstX = xPx(s.samples[0].t).toFixed(1);
              const lastX = xPx(s.samples.at(-1).t).toFixed(1);
              return (
                <g key={s.name}>
                  {showArea && (
                    <polygon
                      className="ts-area"
                      points={`${firstX},${height} ${points} ${lastX},${height}`}
                      style={{ fill: s.color }}
                    />
                  )}
                  <polyline
                    className="ts-line"
                    points={points}
                    style={{ stroke: s.color }}
                    strokeDasharray={s.dashed ? '4 4' : undefined}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {threshold && threshold.value <= top && (
        <div className="ts-threshold" style={{ top: yPx(threshold.value) }} aria-hidden="true">
          <span className="ts-threshold-label">{threshold.label}</span>
        </div>
      )}

      {index == null ? (
        series.map(
          (s) =>
            s.samples.length > 0 && (
              <span
                key={s.name}
                className="ts-dot"
                aria-hidden="true"
                style={{ left: `${xPct(s.samples.at(-1).t)}%`, top: yPx(s.samples.at(-1).v), background: s.color }}
              />
            ),
        )
      ) : (
        <>
          <span className="ts-crosshair" style={{ left: `${hoverPct}%` }} aria-hidden="true" />
          {rows.map((s) => (
            <span
              key={s.name}
              className="ts-dot"
              aria-hidden="true"
              style={{ left: `${hoverPct}%`, top: yPx(s.sample.v), background: s.color }}
            />
          ))}
          <div className={compact ? 'ts-tooltip ts-tooltip--above' : 'ts-tooltip'} role="status" style={tooltipStyle}>
            {rows.map((s) =>
              compact ? (
                <div key={s.name} className="ts-tooltip-value">
                  {formatValue(s.sample.v)}
                </div>
              ) : (
                <div key={s.name} className="ts-tooltip-row">
                  <LineKey color={s.color} dashed={s.dashed} />
                  <span className="ts-tooltip-value">{formatValue(s.sample.v)}</span>
                  <span className="ts-tooltip-name">{s.name}</span>
                </div>
              ),
            )}
            <div className="ts-tooltip-time">{formatChartTime(hoverT)}</div>
          </div>
        </>
      )}
    </div>
  );

  if (compact) return <div className="ts-chart ts-chart--compact">{plot}</div>;

  return (
    <div className="ts-chart" style={{ gridTemplateColumns: `minmax(0, 1fr) ${axisWidth / 16}rem` }}>
      {plot}
      <div className="ts-y" style={{ height }} aria-hidden="true">
        {yTicks.map((tick) => (
          <span key={tick} style={{ top: yPx(tick) }}>
            {formatTick(tick)}
          </span>
        ))}
      </div>
      <div className="ts-x" aria-hidden="true">
        {hourTicks(t0, t1, width).map((tick) => (
          <span key={`${tick.label}-${tick.pct}`} data-align={tick.align} style={{ left: `${tick.pct}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

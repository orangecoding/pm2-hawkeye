/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Pure helpers behind TimeSeriesChart: Y ranges, time ticks, step lookups and
 * the 24 h peak shown above each chart. Kept free of React so they can be unit
 * tested and shared by the Overview and the Metrics tab.
 */

const HOUR_MS = 3_600_000;

/** Hour spacings the X axis may use, finest first. */
const HOUR_STEPS = [1, 3, 6, 12, 24];

/** Most X labels a chart shows, `now` included. */
const MAX_X_TICKS = 5;

/** Hour ticks closer than this to `now` would collide with its label. */
const NOW_GAP_MS = 90 * 60_000;

/**
 * Hour labels are centred on their tick, so one closer than this to the left
 * edge would hang out of the plot, and one closer than this to the right edge
 * would run into the `now` label. In px of the plot width.
 */
const LEFT_EDGE_PX = 16;
const RIGHT_EDGE_PX = 44;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Pad a clock component to two digits.
 *
 * @param {number} n
 * @returns {string}
 */
function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Local wall-clock time as `HH:MM`.
 *
 * @param {number} t - Unix ms.
 * @returns {string}
 */
export function formatClock(t) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Tooltip timestamp, e.g. `23 Oct, 09:50`.
 *
 * @param {number} t - Unix ms.
 * @returns {string}
 */
export function formatChartTime(t) {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${formatClock(t)}`;
}

/**
 * Round a value up to a "nice" axis maximum whose half is nice as well, so a
 * chart can label 0, half and max: 1, 2, 4 or 5 times a power of ten.
 *
 * @param {number} value
 * @returns {number} At least 1.
 */
export function niceCeil(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exp;
  const nice = [1, 2, 4, 5, 10].find((step) => fraction <= step + 1e-9) ?? 10;
  return nice * exp;
}

/**
 * Pick the binary unit a byte axis is labelled in, from its maximum.
 *
 * @param {number} maxBytes
 * @returns {{ unit: number, label: string }}
 */
export function byteAxisUnit(maxBytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (maxBytes >= 1024 ** (i + 1) && i < units.length - 1) i += 1;
  return { unit: 1024 ** i, label: units[i] };
}

/**
 * Hour ticks for a time window, plus `now` at the right edge.
 *
 * Uses full local hours at the finest spacing (1, 3, 6, 12 or 24 h) that keeps
 * the axis to at most five labels. Ticks within 90 minutes of `now` are left
 * out so they do not collide with its label; on a narrow plot, ticks too close
 * to either edge for their label to fit are left out as well.
 *
 * @param {number} t0 - Window start, Unix ms.
 * @param {number} t1 - Window end ("now"), Unix ms.
 * @param {number} [widthPx] - Plot width, for the edge checks; without it
 *   only the 90 minute rule applies.
 * @returns {{ label: string, pct: number, align: 'center' | 'end' }[]}
 */
export function hourTicks(t0, t1, widthPx) {
  const span = t1 - t0;
  const now = { label: 'now', pct: 100, align: 'end' };
  if (!(span > 0)) return [now];

  const minPct = widthPx > 0 ? (LEFT_EDGE_PX / widthPx) * 100 : 0;
  const maxPct = widthPx > 0 ? 100 - (RIGHT_EDGE_PX / widthPx) * 100 : 100;
  const first = new Date(t0);
  first.setMinutes(0, 0, 0);
  const candidates = [];
  for (let t = first.getTime() + HOUR_MS; t < t1 - NOW_GAP_MS; t += HOUR_MS) {
    const pct = ((t - t0) / span) * 100;
    if (pct >= minPct && pct <= maxPct) candidates.push({ t, pct });
  }

  for (const step of HOUR_STEPS) {
    const ticks = candidates.filter(({ t }) => new Date(t).getHours() % step === 0);
    if (ticks.length + 1 <= MAX_X_TICKS || step === HOUR_STEPS.at(-1)) {
      return [...ticks.map(({ t, pct }) => ({ label: formatClock(t), pct, align: 'center' })), now];
    }
  }
  return [now];
}

/**
 * The sample a step series shows at time `t`: the last one at or before it.
 *
 * @param {{ t: number, v: number }[]} samples - Oldest first.
 * @param {number} t
 * @returns {{ t: number, v: number } | null} Null before the first sample.
 */
export function sampleAt(samples, t) {
  let found = null;
  for (const sample of samples) {
    if (sample.t > t) break;
    found = sample;
  }
  return found;
}

/**
 * The highest value of a series and when it was reached (its first
 * occurrence), for the "24 h peak" line above a chart.
 *
 * @param {{ t: number, v: number }[]} samples
 * @returns {{ t: number, v: number } | null} Null for an empty series.
 */
export function findPeak(samples) {
  let peak = null;
  for (const sample of samples) {
    if (sample.v == null) continue;
    if (!peak || sample.v > peak.v) peak = sample;
  }
  return peak;
}

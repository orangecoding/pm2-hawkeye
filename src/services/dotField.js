/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The dot field behind the sign-in panel: a square grid of small dots that
 * fades out from an ellipse around the panel, where some dots slowly light up
 * and dim again. Kept free of the canvas so the maths can be unit tested.
 */

/** Grid pitch in CSS pixels. */
export const DOT_SPACING = 14;

/** Edge length of one square dot in CSS pixels. */
export const DOT_SIZE = 2;

/** Share of dots that light up now and then; the rest only glow faintly. */
const TWINKLE_SHARE = 0.22;

/** Dots fainter than this at their brightest are not drawn at all. */
const MIN_FALLOFF = 0.02;

/**
 * @typedef {object} Dot
 * @property {number} x - Left edge in CSS pixels.
 * @property {number} y - Top edge in CSS pixels.
 * @property {number} falloff - 1 at the centre of the ellipse, towards 0 at its rim.
 * @property {number} base - Resting opacity before the falloff.
 * @property {number} amp - Extra opacity at the peak of a pulse; 0 for dots that never light up.
 * @property {number} speed - Angular speed of the pulse in radians per second.
 * @property {number} phase - Where in its pulse the dot starts, in radians.
 */

/**
 * Lay out the dots for a viewport. The grid is centred, and only dots inside
 * the ellipse around the upper middle, where the panel sits, are kept.
 *
 * @param {number} width - Viewport width in CSS pixels.
 * @param {number} height - Viewport height in CSS pixels.
 * @param {() => number} [random] - Source of numbers in [0, 1), injectable for tests.
 * @returns {Dot[]}
 */
export function buildDotField(width, height, random = Math.random) {
  const dots = [];
  const cx = width * 0.5;
  const cy = height * 0.45;
  // A floor on the radii keeps the field from shrinking to a spot on phones.
  const rx = Math.max(width * 0.62, 320);
  const ry = Math.max(height * 0.72, 320);
  const startX = ((width % DOT_SPACING) + DOT_SPACING - DOT_SIZE) / 2;
  const startY = ((height % DOT_SPACING) + DOT_SPACING - DOT_SIZE) / 2;

  for (let y = startY; y < height; y += DOT_SPACING) {
    for (let x = startX; x < width; x += DOT_SPACING) {
      const distance = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const falloff = Math.max(0, 1 - distance);
      if (falloff < MIN_FALLOFF) continue;
      const twinkles = random() < TWINKLE_SHARE;
      dots.push({
        x,
        y,
        falloff,
        base: 0.16 + 0.12 * random(),
        amp: twinkles ? 0.4 + 0.45 * random() : 0,
        speed: 0.25 + 0.6 * random(),
        phase: random() * Math.PI * 2,
      });
    }
  }
  return dots;
}

/**
 * Opacity of one dot at time `t`. The pulse is the positive half of a sine
 * wave, cubed, so a dot spends most of its cycle dark and lights up briefly.
 *
 * @param {Dot} dot
 * @param {number} t - Time in seconds.
 * @returns {number} Opacity from 0 to 1.
 */
export function dotAlpha(dot, t) {
  const wave = Math.max(0, Math.sin(t * dot.speed + dot.phase));
  return dot.falloff * (dot.base + dot.amp * wave ** 3);
}

/** Radius around the pointer, in CSS pixels, within which dots feel its pull. */
export const PULL_RADIUS = 220;

/** Furthest a dot moves towards the pointer, in CSS pixels; under one grid pitch. */
const MAX_PULL = 10;

/** Opacity a dot gains right next to the pointer, before its own falloff. */
const MAX_BOOST = 0.28;

/**
 * Where a dot is drawn while the pointer hovers nearby, and how much brighter
 * it gets: the pointer acts like a mass whose gravity pulls the surrounding
 * dots a few pixels towards it. The pull fades with distance and ends at
 * {@link PULL_RADIUS}, and a dot never passes the pointer, so the grid bends
 * like a lens instead of collapsing into a point.
 *
 * @param {Dot} dot
 * @param {{ x: number, y: number } | null} pointer - Smoothed pointer position, or null.
 * @param {number} strength - 0 with no pointer, easing to 1 while it hovers.
 * @returns {{ x: number, y: number, boost: number }} Draw position and extra opacity.
 */
export function pullTowards(dot, pointer, strength) {
  if (!pointer || strength <= 0) return { x: dot.x, y: dot.y, boost: 0 };
  const dx = pointer.x - dot.x;
  const dy = pointer.y - dot.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= PULL_RADIUS) return { x: dot.x, y: dot.y, boost: 0 };
  const reach = (1 - distance / PULL_RADIUS) ** 2;
  const boost = MAX_BOOST * reach * strength;
  if (distance === 0) return { x: dot.x, y: dot.y, boost };
  const pull = Math.min(MAX_PULL * reach * strength, distance * 0.5);
  return { x: dot.x + (dx / distance) * pull, y: dot.y + (dy / distance) * pull, boost };
}

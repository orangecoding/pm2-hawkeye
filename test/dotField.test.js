/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect } from 'chai';
import { DOT_SPACING, PULL_RADIUS, buildDotField, dotAlpha, pullTowards } from '../src/services/dotField.js';

/**
 * A repeatable stand-in for Math.random.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('login dot field', () => {
  it('keeps only dots inside the ellipse, on the grid, brightest in the middle', () => {
    const dots = buildDotField(1440, 900, seeded(1));
    expect(dots.length).to.be.greaterThan(1000);
    for (const dot of dots) {
      expect(dot.falloff).to.be.within(0.02, 1);
      expect(dot.x).to.be.within(0, 1440);
      expect(dot.y).to.be.within(0, 900);
    }
    const xs = [...new Set(dots.map((d) => d.x))].sort((a, b) => a - b);
    expect(xs[1] - xs[0]).to.be.closeTo(DOT_SPACING, 1e-9);

    const centre = dots.reduce((best, d) => (d.falloff > best.falloff ? d : best));
    expect(Math.abs(centre.x - 720)).to.be.below(DOT_SPACING);
    expect(Math.abs(centre.y - 405)).to.be.below(DOT_SPACING);
    // Barely anything in the corners, which the vignette darkens anyway.
    const corner = dots.filter((d) => d.x < 60 && d.y < 60);
    expect(corner.every((d) => d.falloff < 0.1)).to.equal(true);
  });

  it('lights up only some dots, and only briefly', () => {
    const dots = buildDotField(1440, 900, seeded(2));
    const twinkling = dots.filter((d) => d.amp > 0);
    expect(twinkling.length / dots.length).to.be.within(0.1, 0.3);

    const dot = { falloff: 1, base: 0.1, amp: 0.4, speed: 1, phase: 0 };
    expect(dotAlpha(dot, Math.PI / 2)).to.be.closeTo(0.5, 1e-9);
    expect(dotAlpha(dot, (3 * Math.PI) / 2)).to.be.closeTo(0.1, 1e-9);
    // Cubing the wave keeps a dot near its resting glow for most of the cycle.
    expect(dotAlpha(dot, Math.PI / 6)).to.be.below(0.16);
    expect(dotAlpha({ ...dot, falloff: 0.5 }, Math.PI / 2)).to.be.closeTo(0.25, 1e-9);
  });

  it('pulls nearby dots towards the pointer without passing it', () => {
    const dot = { x: 100, y: 100, falloff: 1, base: 0.1, amp: 0, speed: 1, phase: 0 };

    expect(pullTowards(dot, null, 1)).to.deep.equal({ x: 100, y: 100, boost: 0 });
    expect(pullTowards(dot, { x: 160, y: 100 }, 0)).to.deep.equal({ x: 100, y: 100, boost: 0 });
    expect(pullTowards(dot, { x: 100 + PULL_RADIUS, y: 100 }, 1)).to.deep.equal({ x: 100, y: 100, boost: 0 });

    const near = pullTowards(dot, { x: 160, y: 100 }, 1);
    expect(near.x).to.be.above(100);
    expect(near.x).to.be.below(112);
    expect(near.y).to.equal(100);
    expect(near.boost).to.be.above(0);

    // Further away, the pull and the glow are weaker.
    const far = pullTowards(dot, { x: 260, y: 100 }, 1);
    expect(far.x - 100).to.be.below(near.x - 100);
    expect(far.boost).to.be.below(near.boost);

    // Right next to the pointer a dot stops halfway instead of overshooting.
    const close = pullTowards(dot, { x: 104, y: 100 }, 1);
    expect(close.x).to.be.closeTo(102, 1e-9);

    // Half strength, half the pull, while the effect eases in or out.
    const half = pullTowards(dot, { x: 160, y: 100 }, 0.5);
    expect(half.x - 100).to.be.closeTo((near.x - 100) / 2, 1e-9);
  });
});

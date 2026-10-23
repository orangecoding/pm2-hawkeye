/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useRef } from 'react';
import { DOT_SIZE, buildDotField, dotAlpha, pullTowards } from '../services/dotField.js';

/** Redraws per second while only the pulses move; they take seconds. */
const IDLE_FPS = 24;

/** Redraws per second while the pointer bends the field, so it follows smoothly. */
const POINTER_FPS = 60;

/** The field fades in once, over this long, when the page loads. */
const INTRO_MS = 1600;

/** How quickly the pull centre catches up with the pointer, per second. Lower lags more. */
const FOLLOW_RATE = 7;

/** How quickly the pull builds up on hover and fades after the pointer leaves, per second. */
const STRENGTH_RATE = 3;

/**
 * What the sign-in panel sits on: a coral glow and a grid of small dots in
 * the accent colour, where single dots slowly light up and dim again. It stays
 * faint on purpose; the frosted glass of the panel blurs the brightest part
 * into a soft light.
 *
 * The mouse acts like a small mass: dots around it lean a few pixels towards
 * it and brighten a little (see `pullTowards`). The pull centre trails the
 * pointer slightly, and the pull eases in on hover and out when the pointer
 * leaves the window, so the grid never jumps. Touch input is ignored, since
 * there is nothing to hover.
 *
 * Drawn on a canvas, since a few thousand animated elements would be heavy as
 * DOM nodes. The animation pauses with the tab (requestAnimationFrame does),
 * and with `prefers-reduced-motion` the field is drawn once, stays still and
 * does not react to the pointer.
 */
export default function LoginBackdrop() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fd8c66';
    const start = performance.now();
    // `x`/`y` is the smoothed pull centre, `targetX`/`targetY` the pointer itself.
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, seen: false, hovering: false, strength: 0 };
    let dots = [];
    let frame = 0;
    let lastDraw = 0;

    /** Match the canvas to the viewport at device resolution and lay out the dots again. */
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      dots = buildDotField(window.innerWidth, window.innerHeight);
    };

    /**
     * Move the pull centre towards the pointer and the strength towards its
     * target, frame-rate independent.
     *
     * @param {number} dt - Seconds since the last frame.
     */
    const ease = (dt) => {
      const follow = 1 - Math.exp(-FOLLOW_RATE * dt);
      pointer.x += (pointer.targetX - pointer.x) * follow;
      pointer.y += (pointer.targetY - pointer.y) * follow;
      const target = pointer.hovering ? 1 : 0;
      pointer.strength += (target - pointer.strength) * (1 - Math.exp(-STRENGTH_RATE * dt));
      if (!pointer.hovering && pointer.strength < 0.001) pointer.strength = 0;
    };

    /** @param {number} now - Timestamp in ms, as requestAnimationFrame passes it. */
    const draw = (now) => {
      const progress = still ? 1 : Math.min(1, (now - start) / INTRO_MS);
      const intro = 1 - (1 - progress) ** 3;
      const centre = pointer.strength > 0 ? pointer : null;
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      context.fillStyle = color;
      for (const dot of dots) {
        const { x, y, boost } = pullTowards(dot, centre, pointer.strength);
        const alpha = dotAlpha(dot, now / 1000) + boost * Math.sqrt(dot.falloff);
        context.globalAlpha = Math.min(1, alpha) * intro;
        context.fillRect(x, y, DOT_SIZE, DOT_SIZE);
      }
      context.globalAlpha = 1;
    };

    /** @param {number} now */
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      const fps = pointer.hovering || pointer.strength > 0 ? POINTER_FPS : IDLE_FPS;
      // A little slack, so a 60 Hz display does not skip every other frame.
      if (now - lastDraw < 1000 / fps - 2) return;
      ease(Math.min(0.1, (now - lastDraw) / 1000));
      lastDraw = now;
      draw(now);
    };

    /** @param {PointerEvent} event */
    const onPointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      pointer.targetX = event.clientX;
      pointer.targetY = event.clientY;
      if (!pointer.seen) {
        // Start the pull where the pointer is, not at the top left corner.
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.seen = true;
      }
      pointer.hovering = true;
    };

    const onPointerGone = () => {
      pointer.hovering = false;
    };

    /** @param {MouseEvent} event - Fires with no related target when the pointer leaves the window. */
    const onMouseOut = (event) => {
      if (!event.relatedTarget) onPointerGone();
    };

    const onResize = () => {
      resize();
      if (still) draw(performance.now());
    };

    resize();
    window.addEventListener('resize', onResize);
    if (still) {
      draw(start);
    } else {
      frame = requestAnimationFrame(tick);
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.addEventListener('mouseout', onMouseOut);
      window.addEventListener('blur', onPointerGone);
    }

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('blur', onPointerGone);
    };
  }, []);

  return (
    <div className="login-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

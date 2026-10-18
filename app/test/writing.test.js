// Tests writing mode: the precision curve, the lazy brush, the curve fit on lift, and how the
// motion module applies them in pointer mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precisionGain, lazyFollow, smoothStroke, simplify } from '../src/ink/writing.js';
import { createMotion, DEFAULT_CONFIG } from '../src/motion/index.js';

test('precision curve: slow turning moves much less than fast, and never more than the writing gain', function () {
  const config = { writingGain: 0.5, writingCurve: 0.8, writingMidDps: 25 };
  const tremor = precisionGain(2, config);
  const writing = precisionGain(25, config);
  assert.equal(writing, 0.5);
  assert.equal(precisionGain(200, config), 0.5, 'a flick is capped');
  assert.ok(tremor < writing / 5, 'tremor at 2 deg/s gets under a fifth: ' + tremor);
  assert.ok(precisionGain(0, config) > 0, 'a slow careful stroke still draws a little');
  assert.equal(precisionGain(2, Object.assign({}, config, { writingCurve: 0 })), 0.5, 'curve 0 is a plain gain');
  assert.ok(DEFAULT_CONFIG.writingGain < 1, 'lower overall gain than pointer mode');
});

test('lazy brush: movement inside the string never moves the ink', function () {
  const brush = { x: 100, y: 100 };
  assert.equal(lazyFollow(brush, { x: 106, y: 104 }, 10), brush);
  const pulled = lazyFollow(brush, { x: 130, y: 100 }, 10);
  assert.deepEqual(pulled, { x: 120, y: 100 }, 'dragged until the string is tight');
  // A shaky hand wobbling around a straight line: the ink comes out flatter than the cursor.
  let b = { x: 0, y: 0 };
  let worst = 0;
  for (let i = 1; i <= 200; i++) {
    b = lazyFollow(b, { x: i * 2, y: Math.sin(i * 1.7) * 6 }, 10);
    worst = Math.max(worst, Math.abs(b.y));
  }
  assert.ok(worst < 3, 'cursor wobbles 6 px, the ink ' + worst.toFixed(2));
});

function zigzagLine(n, amplitude) {
  const points = [];
  for (let i = 0; i <= n; i++) {
    points.push({ x: i * 3, y: 100 + (i % 2 === 0 ? amplitude : -amplitude) * (i > 0 && i < n ? 1 : 0) });
  }
  return points;
}

function wiggle(points) {
  let turning = 0;
  for (let i = 2; i < points.length; i++) {
    const h1 = Math.atan2(points[i - 1].y - points[i - 2].y, points[i - 1].x - points[i - 2].x);
    const h2 = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turning += Math.abs(d);
  }
  return turning;
}

test('curve fit: a jittery line comes out smoother, ends stay put', function () {
  const raw = zigzagLine(60, 1.5);
  const smooth = smoothStroke(raw);
  assert.deepEqual(smooth[0], raw[0]);
  assert.deepEqual(smooth[smooth.length - 1], raw[raw.length - 1]);
  assert.ok(wiggle(smooth) < wiggle(raw) / 4, 'turning ' + wiggle(raw).toFixed(1) + ' to ' + wiggle(smooth).toFixed(1));
  for (const p of smooth) {
    assert.ok(Math.abs(p.y - 100) < 1.6, 'no overshoot ' + p.y);
  }
});

test('curve fit: corners and curves keep their shape, dots are left alone', function () {
  // An L: the corner should still be near (0, 100).
  const L = [];
  for (let i = 0; i <= 20; i++) L.push({ x: 0, y: i * 5 });
  for (let i = 1; i <= 20; i++) L.push({ x: i * 5, y: 100 });
  const smooth = smoothStroke(L);
  const nearest = Math.min(...smooth.map((p) => Math.hypot(p.x, p.y - 100)));
  assert.ok(nearest < 3, 'corner kept within ' + nearest.toFixed(2) + ' px');
  const dot = [{ x: 1, y: 1 }, { x: 2, y: 1 }];
  assert.equal(smoothStroke(dot), dot);
  assert.equal(simplify(L, 1).length, 3, 'an L simplifies to its two ends and the corner');
});

// Pointer mode with the pen held flat: turning about gz is left and right, so a negative gz
// rate turns right. range 20 means 10 degrees right is x = 0.5.
function feed(motion, state, seconds, gz, pen) {
  let last = null;
  for (let i = 0; i < Math.round(seconds * 100); i++) {
    last = motion.update({ t: state.t, gx: 0, gy: 0, gz: gz, ax: 0, ay: 0, az: 1, pen: pen }, pen === 1);
    state.t += 10;
  }
  return last;
}

function writingMotion(overrides) {
  return createMotion(Object.assign({ calibrationMs: 0, penAxis: [0, 1, 0], pointerSmoothing: 0, writingMode: true }, overrides));
}

test('writing mode: strokes draw at the writing gain, tremor barely moves the ink', function () {
  const motion = writingMotion();
  const state = { t: 0 };
  feed(motion, state, 0.2, 0, 0);
  // A 10 degree stroke right at writing speed.
  const stroke = feed(motion, state, 0.4, -25, 1);
  assert.ok(Math.abs(stroke.x - 0.25) < 0.01, 'half of the pointer move: ' + stroke.x);
  // Then a slow 1 degree drift, like a shaky hand.
  const drift = feed(motion, state, 0.5, -2, 1);
  assert.ok(drift.x - stroke.x < 0.01, 'a 0.05 pointer drift moves the ink ' + (drift.x - stroke.x).toFixed(4));

  const off = writingMotion({ writingMode: false });
  const offState = { t: 0 };
  feed(off, offState, 0.2, 0, 0);
  assert.ok(Math.abs(feed(off, offState, 0.4, -25, 1).x - 0.5) < 0.01, 'off: the plain pointer');
});

test('writing mode: the gap after a letter matches it, then the cursor glides back to the pen', function () {
  const motion = writingMotion();
  const state = { t: 0 };
  feed(motion, state, 0.2, 0, 0);
  const letter = feed(motion, state, 0.4, -25, 1);
  // Moving on to the next letter right after lifting is scaled the same way.
  const gap = feed(motion, state, 0.2, -25, 0);
  assert.ok(Math.abs(gap.x - letter.x - 0.125) < 0.01, 'gap at writing scale: ' + (gap.x - letter.x));
  // After a pause, it's back where the pen points (15 degrees right, x = 0.75).
  const rested = feed(motion, state, 2, 0, 0);
  assert.ok(Math.abs(rested.x - 0.75) < 0.01, 'back to the pointer: ' + rested.x);
  motion.recenter();
  const centered = feed(motion, state, 0.1, 0, 0);
  assert.ok(Math.abs(centered.x) < 1e-6, 'recenter clears the offset');
});

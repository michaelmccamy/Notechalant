// Tests the motion settings the tuning panel changes: calibration, direction vectors, learning
// them from sweeps, smoothing, deadzone, and the settings sanitizer used for localStorage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, sanitizeConfig, DEFAULT_CONFIG } from '../src/motion/index.js';

// Feeds `seconds` of 100 Hz samples, each built by rates(i), and returns every update result.
function run(motion, seconds, rates, startT) {
  const results = [];
  const steps = Math.round(seconds * 100);
  for (let i = 0; i < steps; i++) {
    const r = rates(i);
    const sample = { t: startT + i * 10, gx: r.gx || 0, gy: r.gy || 0, gz: r.gz || 0, ax: 0, ay: 0, az: 1, pen: 0 };
    results.push(motion.update(sample));
  }
  return results;
}

function total(results) {
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < results.length; i++) {
    dx += results[i].dx;
    dy += results[i].dy;
  }
  return { dx: dx, dy: dy };
}

const BIAS = { gx: 0.3, gy: -0.4, gz: 0.6 };

test('calibration holds movement back, measures the bias, then removes it', function () {
  const motion = createMotion();
  const still = run(motion, 2.01, function () {
    return BIAS;
  }, 0);
  assert.ok(still.every(function (r) { return !r.ready && r.dx === 0; }), 'not ready while calibrating');

  const state = motion.getState();
  assert.equal(state.calibrating, false);
  assert.ok(Math.abs(state.bias.gz - BIAS.gz) < 1e-9);
  assert.ok(Math.abs(state.bias.gy - BIAS.gy) < 1e-9);

  // Holding still after calibration doesn't drift.
  const after = total(run(motion, 3, function () {
    return BIAS;
  }, 2010));
  assert.ok(Math.abs(after.dx) < 1e-6 && Math.abs(after.dy) < 1e-6, 'no drift ' + JSON.stringify(after));

  motion.reset();
  assert.equal(motion.getState().calibrating, true);
  assert.equal(motion.getState().bias, null);
});

test('direction vectors and sensitivity are read live from config', function () {
  const motion = createMotion({ calibrationMs: 0, xVector: [1, 0, 0], yVector: [0, 0, 1], pixelsPerDegree: 10 });
  // 10 deg/s on gx for one second at 10 px per degree is 100 px.
  let moved = total(run(motion, 1.01, function () {
    return { gx: 10, gz: 5 };
  }, 0));
  assert.ok(Math.abs(moved.dx - 100) < 1e-6, 'dx ' + moved.dx);
  assert.ok(Math.abs(moved.dy - 50) < 1e-6, 'dy ' + moved.dy);

  motion.config.xVector = [-1, 0, 0]; // what Invert does to a single axis
  motion.config.pixelsPerDegree = 20;
  moved = total(run(motion, 1, function () {
    return { gx: 10 };
  }, 1010));
  assert.ok(Math.abs(moved.dx - -200) < 1e-6, 'inverted and doubled, dx ' + moved.dx);
});

test('deadzone ignores tremor and starts from zero speed above it', function () {
  const motion = createMotion({ calibrationMs: 0, deadzone: 2, xVector: [0, 0, 1], yVector: [0, 1, 0] });
  const tremor = total(run(motion, 1, function (i) {
    return { gz: i % 2 === 0 ? 1.5 : -1.5, gy: 1 };
  }, 0));
  assert.equal(tremor.dx, 0);
  assert.equal(tremor.dy, 0);

  // 12 deg/s with a 2 deg/s deadzone moves like 10 deg/s, at 12 px per degree.
  const motion2 = createMotion({ calibrationMs: 0, deadzone: 2, xVector: [0, 0, 1], yVector: [0, 1, 0] });
  const moved = total(run(motion2, 1.01, function () {
    return { gz: 12 };
  }, 0));
  assert.ok(Math.abs(moved.dx - 120) < 1e-6, 'dx ' + moved.dx);
});

test('smoothing reduces jitter but still gets to a steady speed', function () {
  // Alternating noise around a steady 20 deg/s.
  function noisy(i) {
    return { gz: 20 + (i % 2 === 0 ? 4 : -4) };
  }
  function jitter(results) {
    let sum = 0;
    for (let i = 101; i < results.length; i++) {
      sum += Math.abs(results[i].dx - results[i - 1].dx);
    }
    return sum;
  }
  const axes = { calibrationMs: 0, xVector: [0, 0, 1], yVector: [0, 1, 0] };
  const raw = run(createMotion(Object.assign({ smoothing: 0 }, axes)), 2, noisy, 0);
  const smooth = run(createMotion(Object.assign({ smoothing: 0.6 }, axes)), 2, noisy, 0);
  assert.ok(jitter(smooth) < jitter(raw) * 0.3, 'jitter ' + jitter(smooth) + ' vs ' + jitter(raw));

  const last = smooth[smooth.length - 1].dx;
  const steady = 20 * 0.01 * DEFAULT_CONFIG.pixelsPerDegree;
  assert.ok(Math.abs(last - steady) < steady * 0.2, 'settles near ' + steady + ', got ' + last);
});

// A sensor tilted like the real pen: sweeping right turns about RIGHT, down about DOWN.
const RIGHT = [0.47, -0.43, 0.77];
const DOWN = [-0.8, -0.55, 0.23];

function sweep(direction, degPerSec) {
  return function () {
    return { gx: direction[0] * degPerSec, gy: direction[1] * degPerSec, gz: direction[2] * degPerSec };
  };
}

function still() {
  return {};
}

test('axis wizard measures a tilted sensor: still, then tilt right, then tilt up', function () {
  const UP = [-DOWN[0], -DOWN[1], -DOWN[2]];
  const motion = createMotion({ xVector: [0, 0, 1], yVector: [0, -1, 0] });
  const messages = [];
  motion.startAxisWizard(function (m) {
    messages.push(m);
  });
  // A bias the wizard has to measure in step 1, added to every sample.
  function withBias(rates) {
    return function (i) {
      const r = rates(i);
      return { gx: (r.gx || 0) + BIAS.gx, gy: (r.gy || 0) + BIAS.gy, gz: (r.gz || 0) + BIAS.gz };
    };
  }
  // 2 s still, then each tilt: 0.5 s of turning at 40 deg/s inside its 2 s window, then held.
  function tiltThenHold(direction) {
    return withBias(function (i) {
      return i < 50 ? sweep(direction, 40)() : {};
    });
  }
  let results = run(motion, 2.01, withBias(still), 0);
  results = results.concat(run(motion, 2.01, tiltThenHold(RIGHT), 2010));
  results = results.concat(run(motion, 2.01, tiltThenHold(UP), 4020));

  const steps = messages.map(function (m) { return m.step; });
  assert.deepEqual(steps.filter(function (s, i) { return s !== steps[i - 1]; }), ['still', 'right', 'up', 'done']);
  // Allows for rounding: the last sample comes after the wizard ends, with the bias removed.
  assert.ok(results.every(function (r) { return Math.abs(r.dx) < 1e-9 && Math.abs(r.dy) < 1e-9; }), 'cursor frozen throughout');

  const done = messages[messages.length - 1];
  assert.equal(done.result.right.dominant.axis, 'gz');
  assert.equal(done.result.right.dominant.sign, 1);
  assert.equal(done.result.up.dominant.axis, 'gx');
  assert.equal(done.result.up.dominant.sign, 1);
  assert.ok(Math.abs(done.result.right.degrees - 20) < 0.5, 'right tilt ' + done.result.right.degrees);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(motion.config.xVector[i] - RIGHT[i]) < 0.01, 'x ' + motion.config.xVector);
    assert.ok(Math.abs(motion.config.yVector[i] - DOWN[i]) < 0.06, 'y ' + motion.config.yVector);
  }

  // Afterwards a right turn only moves right and a down turn only moves down.
  const right = total(run(motion, 0.5, withBias(sweep(RIGHT, 40)), 6030));
  assert.ok(right.dx > 200 && Math.abs(right.dy) < 1, 'right ' + JSON.stringify(right));
  const down = total(run(motion, 0.5, withBias(sweep(DOWN, 40)), 6530));
  assert.ok(down.dy > 200 && Math.abs(down.dx) < 10, 'down ' + JSON.stringify(down));
});

test('axis wizard fails instead of guessing when the pen never tilts', function () {
  const motion = createMotion({ calibrationMs: 0 });
  const before = motion.config.xVector;
  const messages = [];
  motion.startAxisWizard(function (m) {
    messages.push(m);
  });
  run(motion, 2.5, still, 0);
  assert.equal(messages[messages.length - 1].step, 'failed');
  assert.equal(motion.config.xVector, before, 'settings untouched');
});

test('reset cancels the axis wizard', function () {
  const motion = createMotion();
  const steps = [];
  motion.startAxisWizard(function (m) {
    steps.push(m.step);
  });
  motion.reset();
  assert.deepEqual(steps, ['still', 'cancelled']);
});

test('sanitizeConfig keeps good saved values and drops bad ones', function () {
  const clean = sanitizeConfig({
    xVector: [0, 0, 2], // normalized to length 1
    yVector: [0, 0], // wrong length
    pixelsPerDegree: 20,
    deadzone: -1, // negative
    smoothing: NaN,
    extra: 5,
  });
  assert.deepEqual(clean.xVector, [0, 0, 1]);
  assert.deepEqual(clean.yVector, DEFAULT_CONFIG.yVector);
  assert.deepEqual(sanitizeConfig({ xVector: [0, 0, 0] }).xVector, DEFAULT_CONFIG.xVector, 'zero vector');
  assert.equal(clean.pixelsPerDegree, 20);
  assert.equal(clean.deadzone, DEFAULT_CONFIG.deadzone);
  assert.equal(clean.smoothing, DEFAULT_CONFIG.smoothing);
  assert.equal('extra' in clean, false);
  assert.deepEqual(sanitizeConfig(null), DEFAULT_CONFIG);
});

// Tests the motion settings the tuning panel changes: calibration, direction vectors, learning
// them from sweeps, smoothing, deadzone, and the settings sanitizer used for localStorage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, sanitizeConfig, accelerationGain, DEFAULT_CONFIG } from '../src/motion/index.js';

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

// Everything in this file before the pointer tests is about relative mode.
function relativeMotion(overrides) {
  return createMotion(Object.assign({ pointerMode: false }, overrides || {}));
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
  const motion = relativeMotion();
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

test('calibration starts over if the pen moves, so movement never becomes the bias', function () {
  const motion = relativeMotion();
  // 1 s still, then a wobble, then holding still for the full 2 s.
  run(motion, 1, function () { return BIAS; }, 0);
  run(motion, 1.5, function (i) {
    const wobble = 20 * Math.sin(i / 5);
    return { gx: BIAS.gx, gy: BIAS.gy + wobble, gz: BIAS.gz };
  }, 1000);
  assert.equal(motion.getState().calibrating, true, 'wobbly window rejected');
  assert.equal(motion.getState().moved, true);
  // The rejected windows overlapped the wobble, so a full fresh window of stillness is needed.
  run(motion, 4.5, function () { return BIAS; }, 2500);
  const state = motion.getState();
  assert.equal(state.calibrating, false);
  assert.equal(state.moved, false);
  assert.ok(Math.abs(state.bias.gy - BIAS.gy) < 1e-9, 'bias from the still part only, gy ' + state.bias.gy);
});

test('direction vectors and sensitivity are read live from config', function () {
  const motion = relativeMotion({ rollCompensation: false, acceleration: 0, calibrationMs: 0, xVector: [1, 0, 0], yVector: [0, 0, 1], pixelsPerDegree: 10 });
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
  const motion = relativeMotion({ rollCompensation: false, acceleration: 0, calibrationMs: 0, deadzone: 2, xVector: [0, 0, 1], yVector: [0, 1, 0] });
  const tremor = total(run(motion, 1, function (i) {
    return { gz: i % 2 === 0 ? 1.5 : -1.5, gy: 1 };
  }, 0));
  assert.equal(tremor.dx, 0);
  assert.equal(tremor.dy, 0);

  // 12 deg/s with a 2 deg/s deadzone moves like 10 deg/s, at 12 px per degree.
  const motion2 = relativeMotion({ rollCompensation: false, acceleration: 0, calibrationMs: 0, deadzone: 2, xVector: [0, 0, 1], yVector: [0, 1, 0] });
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
  const axes = { rollCompensation: false, calibrationMs: 0, xVector: [0, 0, 1], yVector: [0, 1, 0] };
  const raw = run(relativeMotion(Object.assign({ smoothing: 0 }, axes)), 2, noisy, 0);
  const smooth = run(relativeMotion(Object.assign({ smoothing: 0.6 }, axes)), 2, noisy, 0);
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

test('axis wizard measures a tilted sensor: still, then a line right, then a line down', function () {
  const motion = relativeMotion({ rollCompensation: false, acceleration: 0, xVector: [0, 0, 1], yVector: [0, -1, 0] });
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
  // 2 s still, then each line: 0.5 s of turning at 40 deg/s inside its 2 s window, then held.
  function tiltThenHold(direction) {
    return withBias(function (i) {
      return i < 50 ? sweep(direction, 40)() : {};
    });
  }
  let results = run(motion, 2.01, withBias(still), 0);
  results = results.concat(run(motion, 2.01, tiltThenHold(RIGHT), 2010));
  results = results.concat(run(motion, 2.01, tiltThenHold(DOWN), 4020));

  const steps = messages.map(function (m) { return m.step; });
  assert.deepEqual(steps.filter(function (s, i) { return s !== steps[i - 1]; }), ['still', 'right', 'down', 'done']);
  // Allows for rounding: the last sample comes after the wizard ends, with the bias removed.
  assert.ok(results.every(function (r) { return Math.abs(r.dx) < 1e-9 && Math.abs(r.dy) < 1e-9; }), 'cursor frozen throughout');

  const done = messages[messages.length - 1];
  assert.equal(done.result.right.dominant.axis, 'gz');
  assert.equal(done.result.right.dominant.sign, 1);
  assert.equal(done.result.down.dominant.axis, 'gx');
  assert.equal(done.result.down.dominant.sign, -1);
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
  const motion = relativeMotion({ calibrationMs: 0 });
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
  const motion = relativeMotion();
  const steps = [];
  motion.startAxisWizard(function (m) {
    steps.push(m.step);
  });
  motion.reset();
  assert.deepEqual(steps, ['still', 'cancelled']);
});

// Rotates vector v around unit axis k by angle a (Rodrigues), to turn a whole sensor frame.
function rotate(v, k, a) {
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => v[i] * c + cr[i] * sn + k[i] * kv * (1 - c));
}

// A pen pointing along PEN, held level, rolled by `roll` radians around its own axis. Turning
// right is turning around -UP (clockwise from above), and drawing down turns around UP x PEN.
const PEN = [0.31, 0.89, -0.34];
function heldPen(roll) {
  const len = Math.hypot(...PEN);
  const pen = PEN.map((n) => n / len);
  // Some up direction at right angles to the pen.
  const raw = [1, 0, 0];
  const along = raw[0] * pen[0];
  const up0 = [raw[0] - along * pen[0], -along * pen[1], -along * pen[2]];
  const ul = Math.hypot(...up0);
  const up = rotate(up0.map((n) => n / ul), pen, roll);
  const sideways = [up[1] * pen[2] - up[2] * pen[1], up[2] * pen[0] - up[0] * pen[2], up[0] * pen[1] - up[1] * pen[0]];
  return { up: up, turnRight: up.map((n) => -n), turnDown: sideways };
}

// One 10 ms sample of the pen turning about rateAxis. The accelerometer reads pen.up, which
// then turns the opposite way, as gravity does in the sensor's frame when the pen turns.
function penSamples(pen, rateAxis, degPerSec) {
  return function () {
    const sample = {
      gx: rateAxis[0] * degPerSec,
      gy: rateAxis[1] * degPerSec,
      gz: rateAxis[2] * degPerSec,
      ax: pen.up[0],
      ay: pen.up[1],
      az: pen.up[2],
    };
    const w = rateAxis.map((n) => (n * degPerSec * Math.PI) / 180);
    const turn = [w[1] * pen.up[2] - w[2] * pen.up[1], w[2] * pen.up[0] - w[0] * pen.up[2], w[0] * pen.up[1] - w[1] * pen.up[0]];
    const next = pen.up.map((n, i) => n - turn[i] * 0.01);
    const length = Math.hypot(...next);
    pen.up = next.map((n) => n / length);
    return sample;
  };
}

// run() fixes the accelerometer at az = 1, so these tests build samples with gravity themselves.
function runPen(motion, seconds, rates, startT) {
  const results = [];
  for (let i = 0; i < Math.round(seconds * 100); i++) {
    const r = rates(i);
    results.push(motion.update({ t: startT + i * 10, gx: r.gx, gy: r.gy, gz: r.gz, ax: r.ax, ay: r.ay, az: r.az, pen: 0 }));
  }
  return total(results);
}

test('roll compensation: right is right and down is down however the pen is rolled', function () {
  for (const roll of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const pen = heldPen(roll);
    const motion = relativeMotion({ calibrationMs: 0, penAxis: PEN });
    runPen(motion, 0.2, penSamples(pen, [0, 0, 0], 0), 0);
    const right = runPen(motion, 1, penSamples(pen, pen.turnRight, 20), 200);
    const down = runPen(motion, 1, penSamples(pen, pen.turnDown, 20), 1200);
    const label = 'roll ' + Math.round((roll * 180) / Math.PI) + ' deg';
    assert.ok(Math.abs(right.dx - 240) < 1 && Math.abs(right.dy) < 1, label + ' right ' + JSON.stringify(right));
    assert.ok(Math.abs(down.dy - 240) < 1 && Math.abs(down.dx) < 1, label + ' down ' + JSON.stringify(down));
  }
});

test('fixed vectors mix up and down with sideways once the pen is rolled', function () {
  const flat = heldPen(0);
  const rolled = heldPen(Math.PI / 4);
  const motion = relativeMotion({ calibrationMs: 0, rollCompensation: false, xVector: flat.turnRight, yVector: flat.turnDown });
  const down = runPen(motion, 1, penSamples(rolled, rolled.turnDown, 20), 0);
  assert.ok(Math.abs(down.dx) > 100, 'a down stroke drifts sideways, dx ' + down.dx);
});

test('the axis wizard learns which way the pen points and the left-right sign', function () {
  const pen = heldPen(Math.PI / 3);
  const motion = relativeMotion({ penAxis: [0, 0, 1], horizontalSign: -1 });
  let done = null;
  motion.startAxisWizard(function (m) {
    if (m.step === 'done') done = m;
  });
  runPen(motion, 2.02, penSamples(pen, [0, 0, 0], 0), 0);
  runPen(motion, 2.01, function (i) { return penSamples(pen, pen.turnRight, i < 50 ? 40 : 0)(); }, 2020);
  runPen(motion, 2.01, function (i) { return penSamples(pen, pen.turnDown, i < 50 ? 40 : 0)(); }, 4030);
  assert.ok(done !== null, 'wizard finished');
  assert.equal(motion.config.horizontalSign, 1);
  const len = Math.hypot(...PEN);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(motion.config.penAxis[i] - PEN[i] / len) < 0.01, 'pen axis ' + motion.config.penAxis);
  }
  // And with that, a different roll still maps straight, once gravity has caught up with the
  // new roll (it settles over about a second, and this roll jumps 105 degrees at once).
  const other = heldPen(-Math.PI / 4);
  runPen(motion, 5, penSamples(other, [0, 0, 0], 0), 6040);
  const down = runPen(motion, 1, penSamples(other, other.turnDown, 20), 11040);
  assert.ok(Math.abs(down.dy - 240) < 3 && Math.abs(down.dx) < 3, 'down after re-roll ' + JSON.stringify(down));
});

test('acceleration: slow aiming is finer, fast moves go further, writing speed is unchanged', function () {
  assert.equal(accelerationGain(20, 0.5, 20), 1);
  assert.ok(Math.abs(accelerationGain(5, 0.5, 20) - 0.5) < 1e-9);
  assert.ok(Math.abs(accelerationGain(80, 0.5, 20) - 2) < 1e-9);
  assert.equal(accelerationGain(0, 0.5, 20), 0, 'no speed, no movement');
  assert.equal(accelerationGain(5000, 1, 20), 4, 'capped');
  assert.equal(accelerationGain(5, 0, 20), 1, 'off means constant gain');

  // Through the motion module: the same 10 degree turn, slow and fast.
  function turn(degPerSec) {
    const motion = relativeMotion({ rollCompensation: false, calibrationMs: 0, xVector: [0, 0, 1], yVector: [0, 1, 0] });
    const seconds = 10 / degPerSec;
    return total(run(motion, seconds + 0.01, function () { return { gz: degPerSec }; }, 0)).dx;
  }
  assert.ok(Math.abs(turn(20) - 120) < 1, 'writing speed: 10 deg at 12 px/deg');
  assert.ok(turn(5) < 70, 'slow: finer, ' + turn(5));
  assert.ok(turn(80) > 200, 'fast: further, ' + turn(80));
});

test('the cursor moves slower while drawing than while moving to a spot', function () {
  const config = { rollCompensation: false, acceleration: 0, calibrationMs: 0, xVector: [0, 0, 1], yVector: [0, 1, 0] };
  function moved(penDown) {
    const motion = relativeMotion(config);
    let dx = 0;
    for (let i = 0; i <= 100; i++) {
      dx += motion.update({ t: i * 10, gx: 0, gy: 0, gz: 10, ax: 0, ay: 0, az: 1, pen: 0 }, penDown).dx;
    }
    return dx;
  }
  assert.ok(Math.abs(moved(undefined) - 120) < 1e-6, 'no pen state given: plain gain');
  assert.ok(Math.abs(moved(true) - 120 * DEFAULT_CONFIG.drawingGain) < 1e-6);
  // Acceleration is ignored while drawing, so a slow stroke keeps its proportions.
  const accelerated = relativeMotion(Object.assign({}, config, { acceleration: 1 }));
  let slowDx = 0;
  for (let i = 0; i <= 100; i++) {
    slowDx += accelerated.update({ t: i * 10, gx: 0, gy: 0, gz: 2, ax: 0, ay: 0, az: 1, pen: 1 }, true).dx;
  }
  assert.ok(Math.abs(slowDx - 24 * DEFAULT_CONFIG.drawingGain) < 1e-6, 'slow drawing not shrunk, ' + slowDx);
  assert.ok(Math.abs(moved(false) - 120 * DEFAULT_CONFIG.travelGain) < 1e-6);
});

// Pointer mode: the last sample's position after a run, x and y from -1 to 1 across the page.
function pointAfter(motion, pen, steps, startT) {
  let t = startT;
  let last = null;
  for (const [seconds, axis, dps] of steps) {
    const next = penSamples(pen, axis, dps);
    for (let i = 0; i < Math.round(seconds * 100); i++) {
      const r = next();
      last = motion.update({ t: t, gx: r.gx, gy: r.gy, gz: r.gz, ax: r.ax, ay: r.ay, az: r.az, pen: 0 });
      t += 10;
    }
  }
  return { at: last, t: t };
}

test('pointer mode: the cursor goes where the pen points, however it is rolled', function () {
  for (const roll of [0, Math.PI / 3, Math.PI]) {
    const label = 'roll ' + Math.round((roll * 180) / Math.PI) + ' deg';
    const pen = heldPen(roll);
    const motion = createMotion({ calibrationMs: 0, penAxis: PEN, pointerSmoothing: 0 });
    let r = pointAfter(motion, pen, [[0.2, [0, 0, 0], 0]], 0);
    assert.equal(r.at.absolute, true);
    assert.ok(Math.abs(r.at.x) < 1e-6 && Math.abs(r.at.y) < 1e-6, label + ' starts in the middle');
    // 10 degrees right is halfway to the right edge (range 20).
    r = pointAfter(motion, pen, [[0.5, pen.turnRight, 20], [0.5, [0, 0, 0], 0]], r.t);
    assert.ok(Math.abs(r.at.x - 0.5) < 0.02 && Math.abs(r.at.y) < 0.02, label + ' right ' + JSON.stringify(r.at));
    // 6 degrees down is halfway to the bottom (range 12).
    r = pointAfter(motion, pen, [[0.3, pen.turnDown, 20], [0.5, [0, 0, 0], 0]], r.t);
    assert.ok(Math.abs(r.at.x - 0.5) < 0.03 && Math.abs(r.at.y - 0.5) < 0.03, label + ' then down ' + JSON.stringify(r.at));
  }
});

test('pointer mode: holding still stays put, and recenter makes here the middle', function () {
  const pen = heldPen(0);
  const motion = createMotion({ calibrationMs: 0, penAxis: PEN });
  let r = pointAfter(motion, pen, [[0.2, [0, 0, 0], 0], [0.4, pen.turnRight, 20], [3, [0, 0, 0], 0]], 0);
  const settled = r.at;
  r = pointAfter(motion, pen, [[3, [0, 0, 0], 0]], r.t);
  assert.ok(Math.abs(r.at.x - settled.x) < 0.005 && Math.abs(r.at.y - settled.y) < 0.005, 'no drift ' + JSON.stringify(r.at));
  assert.ok(Math.abs(r.at.x - 0.4) < 0.02, 'smoothing settles on the true spot ' + r.at.x);
  motion.recenter();
  r = pointAfter(motion, pen, [[0.5, [0, 0, 0], 0]], r.t);
  assert.ok(Math.abs(r.at.x) < 0.005 && Math.abs(r.at.y) < 0.005, 'recentered ' + JSON.stringify(r.at));
});

// Drives a pointer-mode motion with a physical pen: turn right/left (deg), turn up/down (deg),
// hold, and tap the pad. press holds the pad down through the step's turns, then lifts.
// Returns the last update.
function penScript(motion, pen, steps) {
  let t = 0;
  let last = null;
  function sample(axis, dps, penDown) {
    const r = penSamples(pen, axis, dps)();
    last = motion.update({ t: t, gx: r.gx, gy: r.gy, gz: r.gz, ax: r.ax, ay: r.ay, az: r.az, pen: penDown ? 1 : 0 }, penDown);
    t += 10;
  }
  // Turning right is around the room's vertical (gravity), and up and down is around the pen's
  // current sideways axis, as a hand does it. Both change as the pen moves, so they're worked
  // out fresh for every sample.
  const len = Math.hypot(...PEN);
  const forward = PEN.map((n) => n / len);
  function rightAxis() {
    return pen.up.map((n) => -n);
  }
  function downAxis() {
    const u = pen.up;
    const c = [u[1] * forward[2] - u[2] * forward[1], u[2] * forward[0] - u[0] * forward[2], u[0] * forward[1] - u[1] * forward[0]];
    const l = Math.hypot(...c);
    return c.map((n) => n / l);
  }
  for (const step of steps) {
    const press = step.press === true;
    if (step.right) {
      for (let i = 0; i < Math.abs(step.right) * 5; i++) sample(rightAxis(), Math.sign(step.right) * 20, press);
    }
    if (step.up) {
      for (let i = 0; i < Math.abs(step.up) * 5; i++) sample(downAxis(), -Math.sign(step.up) * 20, press);
    }
    if (press) {
      for (let i = 0; i < 20; i++) sample([0, 0, 0], 0, false);
    }
    for (let i = 0; i < (step.hold || 0) * 100; i++) sample([0, 0, 0], 0, false);
    if (step.tap) {
      for (let i = 0; i < 5; i++) sample([0, 0, 0], 0, true);
      for (let i = 0; i < 20; i++) sample([0, 0, 0], 0, false);
    }
  }
  return last;
}

test('corner calibration: point at four corners, and the page fills exactly that area', function () {
  const pen = heldPen(Math.PI / 5);
  const motion = createMotion({ calibrationMs: 0, penAxis: PEN, pointerSmoothing: 0 });
  penScript(motion, pen, [{ hold: 0.3 }]);
  const steps = [];
  motion.startScreenCalibration(function (m) {
    steps.push(m.step === 'corner' ? 'corner ' + m.index : m.step);
  });
  const during = penScript(motion, pen, [{ hold: 0.05 }]);
  assert.equal(during.ready, false, 'nothing moves or draws while calibrating');
  // The page spans 15 degrees either side and 9 up and down, around the middle.
  penScript(motion, pen, [
    { right: -15, up: 9, hold: 0.3, tap: true },
    { right: 30, hold: 0.3, tap: true },
    { up: -18, hold: 0.3, tap: true },
    { right: -30, hold: 0.3, tap: true },
  ]);
  assert.deepEqual(steps, ['corner 0', 'corner 1', 'corner 2', 'corner 3', 'done']);
  assert.ok(motion.config.screenMapping !== null);

  // Back to the bottom left corner the user last pointed at, then to other spots.
  let at = penScript(motion, pen, [{ hold: 0.1 }]);
  assert.ok(Math.abs(at.x - -1) < 0.03 && Math.abs(at.y - 1) < 0.03, 'bottom left ' + JSON.stringify(at));
  at = penScript(motion, pen, [{ right: 15, up: 9, hold: 0.1 }]);
  assert.ok(Math.abs(at.x) < 0.03 && Math.abs(at.y) < 0.03, 'middle ' + JSON.stringify(at));
  at = penScript(motion, pen, [{ right: 7.5, hold: 0.1 }]);
  assert.ok(Math.abs(at.x - 0.5) < 0.04 && Math.abs(at.y) < 0.03, 'halfway right ' + JSON.stringify(at));

  // Recentering pointing 5 degrees off to the right makes that the middle across, but leaves up
  // and down alone, since that comes from gravity and doesn't drift.
  penScript(motion, pen, [{ right: -2.5, up: 4.5 }]);
  motion.recenter();
  at = penScript(motion, pen, [{ hold: 0.1 }]);
  assert.ok(Math.abs(at.x) < 0.03, 'recentered across ' + JSON.stringify(at));
  assert.ok(Math.abs(at.y - -0.5) < 0.05, 'still half way up ' + JSON.stringify(at));
});

test('corner calibration also learns the pen direction, so a remounted sensor needs nothing else', function () {
  const pen = heldPen(-Math.PI / 3);
  // Settings left over from before the sensor moved: wrong direction and wrong sign.
  const motion = createMotion({ calibrationMs: 0, penAxis: [0, 0, 1], horizontalSign: -1, pointerSmoothing: 0 });
  penScript(motion, pen, [{ hold: 0.3 }]);
  let done = null;
  motion.startScreenCalibration(function (m) {
    if (m.step === 'done') done = m;
  });
  penScript(motion, pen, [
    { right: -15, up: 9, hold: 0.3, tap: true },
    { right: 30, hold: 0.3, tap: true },
    { up: -18, hold: 0.3, tap: true },
    { right: -30, hold: 0.3, tap: true },
  ]);
  assert.ok(done !== null && done.learnedPenAxis, 'calibrated and learned the pen');
  assert.equal(motion.config.horizontalSign, 1);
  const len = Math.hypot(...PEN);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(motion.config.penAxis[i] - PEN[i] / len) < 0.02, 'pen axis ' + motion.config.penAxis);
  }
  // Straight down the middle stays in the middle across: no slant.
  let at = penScript(motion, pen, [{ right: 15, up: 9, hold: 0.1 }]);
  assert.ok(Math.abs(at.x) < 0.03 && Math.abs(at.y) < 0.03, 'middle ' + JSON.stringify(at));
  at = penScript(motion, pen, [{ up: -7, hold: 0.1 }]);
  assert.ok(Math.abs(at.x) < 0.03 && at.y > 0.6, 'straight down ' + JSON.stringify(at));
});

test('corner calibration refuses corners tapped without moving, and Enter also captures', function () {
  const pen = heldPen(0);
  const motion = createMotion({ calibrationMs: 0, penAxis: PEN, pointerSmoothing: 0 });
  penScript(motion, pen, [{ hold: 0.3 }]);
  let result = null;
  motion.startScreenCalibration(function (m) {
    result = m;
  });
  for (let i = 0; i < 4; i++) {
    motion.captureCorner();
  }
  assert.equal(result.step, 'failed');
  assert.equal(motion.config.screenMapping, null);
});

test('relative mode is still there behind pointerMode: false', function () {
  const motion = createMotion({ pointerMode: false, calibrationMs: 0 });
  const result = motion.update({ t: 0, gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 1, pen: 0 });
  assert.equal(result.absolute, undefined);
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
  assert.equal(sanitizeConfig({ horizontalSign: -1 }).horizontalSign, -1);
  assert.equal(sanitizeConfig({ horizontalSign: 0.5 }).horizontalSign, DEFAULT_CONFIG.horizontalSign);
  assert.equal(sanitizeConfig({ rollCompensation: false }).rollCompensation, false);
});

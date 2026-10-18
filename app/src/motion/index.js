// Owned by CpE 2. Replace the inside freely, but keep the exported shape so the rest of
// the app keeps working. See motion/README.md for the contract.
//
// Per sample: gyro rates -> subtract bias -> screen directions -> One Euro filter ->
// deadzone -> acceleration curve -> pen up or down gain -> pixels. The bias is the average of the first calibrationMs of samples, while the
// user holds the pen still. Every setting is read from `config` on each sample, so the debug
// panel (D key) can change them live.
//
// Two modes:
//   Pointer (default). Like a laser pointer: the cursor goes where the pen points. Pitch comes
//   from gravity and the pen axis, yaw from the gyro integrated around gravity, and both map
//   straight to a spot on the page (pointerRangeXDeg either side fills the width). Recenter()
//   makes wherever the pen points now the middle. After corner calibration
//   (startScreenCalibration, motion/screenMap.js) the four corners the user pointed at map
//   exactly onto the page's corners instead, and recentering only corrects yaw drift. update() returns { absolute: true, x, y }
//   with x and y from -1 to 1 across the page.
//   Relative. Turning speed moves the cursor, like a mouse. The rest of this comment is about it.
//
// Writing mode (writingMode, the toolbar's Write toggle) works in both. While the pen is down,
// movement is scaled by writingGain (and precisionGain in ink/writing.js, if writingCurve is
// set). The lazy brush and the curve fit happen in the ink canvas.
//
// In pointer mode, Write works like a mouse rather than a laser pointer: the ink moves by how
// much the pen turns, not to where it points. Writing along a line in pointer mode meant
// twisting the wrist further and further, which changed how the hand wrote (and the slant) as
// it went. Now the hand stays in one comfortable place. With the pen up the cursor moves like a
// mouse with acceleration: slow moves go a little (on to the next letter, or easing the wrist
// back to where it's comfortable), fast moves go far (across the page). Recenter (a double tap)
// puts the cursor where the pen points again. An earlier version ignored fast moves with the pen
// up, as a way to reset the wrist, but aiming on the real pen is 30 to 150 deg/s, so the cursor
// hardly moved (debug recording 00-11-09).
// Turning is turned into page units with the corner calibration's scale at the middle of the
// page, so the same turn draws the same size anywhere.
//
// No slant correction: a version learned one from a line drawn at the end of corner
// calibration, but those lines never matched the writing (one leaned 20 degrees where the
// writing leaned 4, debug recording 00-14-41), since the hand is still twisted towards the last
// corner. Writing like a mouse, the hand stays put and down strokes came out nearly upright.
//
// Screen directions in relative mode, two ways:
//   Roll compensation (default). The accelerometer gives "up" (gravity), tracked as the pen
//   moves. Left and right is turning around up, and up and down is turning around the
//   sideways axis, up x penAxis, where penAxis is the way the pen points in sensor axes.
//   Both follow gravity, so rolling the pen in the hand doesn't mix them up.
//   Fixed vectors. xVector and yVector are fixed directions in sensor axes. Simpler, but
//   correct only for the grip they were measured with.
// startAxisWizard() measures penAxis and horizontalSign, and the fixed vectors too.

import { toPlane, fromPlane, applyHomography, invertHomography, mappingFromCorners } from './screenMap.js';
import { precisionGain } from '../ink/writing.js';

export const AXES = ['gx', 'gy', 'gz'];

export const DEFAULT_CONFIG = {
  pointerMode: true,
  pointerRangeXDeg: 20, // pointing this far left or right of center reaches the page edge
  pointerRangeYDeg: 12, // and this far up or down
  pointerSmoothing: 0.5, // One Euro filter on the pointing angles, 0 is off
  pointerBeta: 0.3, // how quickly it opens up for fast movement, so it doesn't lag
  // From corner calibration: 9 numbers mapping pointing to the page, or null for the ranges above.
  screenMapping: null,
  rollCompensation: true,
  // Roll compensation: the way the pen points, as a unit vector in sensor axes (gx, gy, gz),
  // and 1 or -1 to flip left and right. Measured on the breadboard pen from a down stroke.
  penAxis: [0.31, 0.89, -0.34],
  horizontalSign: 1,
  // Fixed vectors: unit vectors (gx, gy, gz) for the rotation that moves the cursor right,
  // and down. Measured on the real pen from left, right, up, and down sweeps.
  xVector: [0.47, -0.43, 0.77],
  yVector: [-0.8, -0.55, 0.23],
  pixelsPerDegree: 12, // sensitivity
  smoothing: 0, // 0 is off, 1 is heaviest. Sets the One Euro filter's minimum cutoff
  smoothingBeta: 0.02, // how quickly the filter opens up for fast movement
  deadzone: 0, // degrees per second of rotation ignored as hand tremor
  // Pointer acceleration while the pen is up, 0 (off) to 1. Gain scales with
  // (speed / accelerationMidDps) to this power: slow aiming gets finer and fast moves get
  // bigger. Never while drawing, where it would shrink slow strokes more than fast ones
  // (an H's crossbar came out half size) and bend letters out of shape.
  acceleration: 0.5,
  accelerationMidDps: 20, // writing speed on the real pen, where the gain is pixelsPerDegree
  // Multipliers on top while the pen is down (writing) and up (moving to a spot).
  drawingGain: 0.8,
  travelGain: 1.3,
  writingMode: false,
  writingGain: 0.6, // writing mode: movement while drawing, as a share of pointer movement
  // How much slower turning is shrunk, 0 is a plain gain. Off by default: on a recording of
  // "hello notes" any curve bent letters more than it steadied them.
  writingCurve: 0,
  writingMidDps: 6, // turning speed that gets the full writing gain
  writingString: 4, // lazy brush string length in px, 0 is off
  calibrationMs: 2000, // how long to average the gyro for bias after a reset
  maxGapMs: 50, // ignore time gaps longer than this so a dropped packet can't fling the cursor
};

// Smoothing 0 to 1 maps to a minimum cutoff from 10 Hz (barely filtered at 100 Hz sampling)
// down to 0.5 Hz (heavy). 0 bypasses the filter.
const MAX_CUTOFF_HZ = 10;
const MIN_CUTOFF_HZ = 0.5;
const DERIVATIVE_CUTOFF_HZ = 1;

export function smoothingToCutoff(smoothing) {
  return MAX_CUTOFF_HZ * Math.pow(MIN_CUTOFF_HZ / MAX_CUTOFF_HZ, smoothing);
}

function lowPassAlpha(cutoffHz, dt) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

// One Euro filter (Casiez et al. 2012): a low pass whose cutoff rises with speed,
// so slow movement is smooth and fast movement doesn't lag.
export function createOneEuro() {
  let value = null;
  let derivative = 0;

  function filter(x, dt, minCutoff, beta) {
    if (value === null) {
      value = x;
      return x;
    }
    const rawDerivative = (x - value) / dt;
    derivative += lowPassAlpha(DERIVATIVE_CUTOFF_HZ, dt) * (rawDerivative - derivative);
    const cutoff = minCutoff + beta * Math.abs(derivative);
    value += lowPassAlpha(cutoff, dt) * (x - value);
    return value;
  }

  function reset() {
    value = null;
    derivative = 0;
  }

  return { filter, reset };
}

// Calibration only accepts a window where the pen was really still: every axis must stay
// within this standard deviation, or the window starts over. A still pen measures about
// 0.4 deg/s, while a moving one measured from 3 up to 18 deg/s off as bias and made the cursor drift.
const STILL_MAX_STD_DPS = 2.5;

// Axis wizard: each line step lasts WIZARD_STEP_MS, and a line turning the pen less than
// MIN_TILT_DEG means the user didn't move, so the wizard fails instead of guessing.
const WIZARD_STEP_MS = 2000;
const MIN_TILT_DEG = 5;

// Gravity is a complementary filter: the gyro turns the last estimate as the pen turns, and the
// accelerometer pulls it back over about this long, so drift can't build up while the hand's
// own acceleration while writing averages out. Readings far from 1 g are mostly hand
// acceleration and are skipped.
const GRAVITY_SMOOTHING_MS = 800;
const GRAVITY_MIN_G = 0.8;
const GRAVITY_MAX_G = 1.2;
// When the pen points almost straight up or down, the sideways axis is undefined. Below this,
// up and down falls back to the fixed vector.
const MIN_SIDEWAYS = 0.2;

// Acceleration never multiplies the gain by more than this, so a flick can't throw the
// cursor off the page.
const MAX_ACCELERATION_GAIN = 4;

// The acceleration curve on its own, for the debug panel and tests.
export function accelerationGain(speedDps, acceleration, midDps) {
  if (acceleration <= 0 || speedDps <= 0) {
    return acceleration <= 0 ? 1 : 0;
  }
  return Math.min(MAX_ACCELERATION_GAIN, Math.pow(speedDps / midDps, acceleration));
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

// Which single axis a rotation is mostly about, and its sign, for showing the user.
export function dominantAxis(v) {
  let best = 0;
  for (let i = 1; i < 3; i++) {
    if (Math.abs(v[i]) > Math.abs(v[best])) {
      best = i;
    }
  }
  return { axis: AXES[best], sign: v[best] < 0 ? -1 : 1, share: Math.abs(v[best]) / Math.hypot(v[0], v[1], v[2]) };
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Corner calibration takes the pointing from this many samples before the tap (about 0.1 s),
// averaged over CORNER_AVERAGE, so pressing the pad doesn't nudge the reading.
const CORNER_LOOKBACK = 10;
const CORNER_AVERAGE = 6;

// Writing mode in pointer mode. The speed is smoothed at this cutoff, so a letter slowing down
// round a curve isn't treated as slow, while tremor (8 to 12 Hz) is averaged away. With the pen
// up, the gain is writingGain times travelGain, times speed over accelerationMidDps (capped at
// MAX_ACCELERATION_GAIN), so at 5 deg/s it's a quarter and at 80 deg/s four times.
const WRITING_SPEED_CUTOFF_HZ = 4;
const WRITING_TRAVEL_ACCELERATION = 1;
// With corners set, pointing past the edge of the calibrated area runs off towards infinity (and
// beyond the horizon of a desk, back round the other side). The cursor stays within this.
const POINTER_LIMIT = 1.5;

export function createMotion(overrides) {
  const config = Object.assign({}, DEFAULT_CONFIG, overrides || {});
  const filterX = createOneEuro();
  const filterY = createOneEuro();
  let lastT = null;
  let calibrationStartT = null;
  let sums = { gx: 0, gy: 0, gz: 0 };
  let squares = { gx: 0, gy: 0, gz: 0 };
  let accelSums = [0, 0, 0];
  let count = 0;
  let bias = null;
  let movedDuringCalibration = false;
  let wizard = null;
  // Unit vector pointing up (away from gravity) in sensor axes, or null until calibrated.
  let up = null;
  // Pointer mode: yaw is the integrated turn around up, in degrees. center is the yaw and pitch
  // the pen pointed at when last recentered, or null to recenter on the next sample.
  let yaw = 0;
  let center = null;
  let lastPointer = null;
  // Corner calibration: degrees added to "right" so the mapping's frame lines up after yaw
  // drift or a reset, the recent pointing for picking a corner, and the calibration in progress.
  let rightShift = 0;
  // Raw readings from the last few samples: { yaw, up, turn }, where turn is the gyro summed
  // since pointer mode started, in sensor axes. Corner calibration picks from these.
  let recentPointing = [];
  let turnSum = [0, 0, 0];
  let corners = null;
  let wasPenDown = false;
  const filterPointX = createOneEuro();
  const filterPointY = createOneEuro();
  // Writing mode in pointer mode: where the ink goes in page units (-1 to 1), or null to start
  // where the pen points, plus the last pointing angles and their smoothed speed.
  let writePos = null;
  let lastWriteAngles = null;
  let writeVelocity = [0, 0];
  // Page units per degree of turn at the middle of the page, for the mapping it was worked out from.
  let scaleCache = { mapping: undefined, scale: null };

  function calibrate(sample) {
    if (calibrationStartT === null) {
      calibrationStartT = sample.t;
    }
    // The window is complete once this sample falls outside it. This sample isn't part of it,
    // so movement that starts right after holding still can't spoil the window.
    if (sample.t - calibrationStartT < config.calibrationMs || count === 0) {
      for (let i = 0; i < AXES.length; i++) {
        sums[AXES[i]] += sample[AXES[i]];
        squares[AXES[i]] += sample[AXES[i]] * sample[AXES[i]];
      }
      accelSums = [accelSums[0] + sample.ax, accelSums[1] + sample.ay, accelSums[2] + sample.az];
      count++;
      return;
    }
    const mean = { gx: sums.gx / count, gy: sums.gy / count, gz: sums.gz / count };
    for (let i = 0; i < AXES.length; i++) {
      const variance = squares[AXES[i]] / count - mean[AXES[i]] * mean[AXES[i]];
      if (Math.sqrt(Math.max(0, variance)) > STILL_MAX_STD_DPS) {
        // The pen moved. Throw the window away and start a new one from the next sample.
        calibrationStartT = null;
        sums = { gx: 0, gy: 0, gz: 0 };
        squares = { gx: 0, gy: 0, gz: 0 };
        accelSums = [0, 0, 0];
        count = 0;
        movedDuringCalibration = true;
        return;
      }
    }
    bias = mean;
    up = unitOrNull(accelSums);
    // Pointer mode centers on wherever the pen points once calibration is done.
    center = null;
    movedDuringCalibration = false;
  }

  // Follows gravity as the pen turns and rolls.
  // rate is in deg/s with the bias removed.
  function trackGravity(sample, rate, dt) {
    const accel = [sample.ax, sample.ay, sample.az];
    const g = Math.hypot(accel[0], accel[1], accel[2]);
    if (up === null) {
      up = unitOrNull(accel);
      return;
    }
    // A direction fixed in the room turns the opposite way to the pen: up -= (w x up) dt.
    const w = [(rate[0] * Math.PI) / 180, (rate[1] * Math.PI) / 180, (rate[2] * Math.PI) / 180];
    const turn = cross(w, up);
    let next = [up[0] - turn[0] * dt, up[1] - turn[1] * dt, up[2] - turn[2] * dt];
    if (g >= GRAVITY_MIN_G && g <= GRAVITY_MAX_G) {
      const k = Math.min(1, (dt * 1000) / GRAVITY_SMOOTHING_MS);
      next = [next[0] + k * (accel[0] / g - next[0]), next[1] + k * (accel[1] / g - next[1]), next[2] + k * (accel[2] / g - next[2])];
    }
    up = unitOrNull(next) || up;
  }

  // Where the pen points: yaw (left positive, integrated) and pitch (up positive), in degrees.
  function pointing() {
    const axis = unitOrNull(config.penAxis);
    const lift = Math.max(-1, Math.min(1, dot(axis, up)));
    return { yaw: yaw, pitch: (Math.asin(lift) * 180) / Math.PI };
  }

  // Makes wherever the pen points now the middle of the page.
  function recenter() {
    center = null;
    clearWriting();
  }

  function clearWriting() {
    writePos = null;
    lastWriteAngles = null;
    writeVelocity = [0, 0];
  }

  // [a, b, c, d]: page x = a * right + b * above, page y = c * right + d * above, for small
  // turns (degrees) around the middle of the page.
  function pageScale() {
    const mapping = config.screenMapping;
    if (mapping === null) {
      return [1 / config.pointerRangeXDeg, 0, 0, -1 / config.pointerRangeYDeg];
    }
    if (scaleCache.mapping !== mapping) {
      const middle = applyHomography(invertHomography(mapping), [0, 0]);
      const [r0, a0] = fromPlane(middle[0], middle[1]);
      const at = (r, a) => applyHomography(mapping, toPlane(r, a));
      const e = 0.5;
      const [px, mx, py, my] = [at(r0 + e, a0), at(r0 - e, a0), at(r0, a0 + e), at(r0, a0 - e)];
      scaleCache = { mapping: mapping, scale: [(px[0] - mx[0]) / (2 * e), (py[0] - my[0]) / (2 * e), (px[1] - mx[1]) / (2 * e), (py[1] - my[1]) / (2 * e)] };
    }
    return scaleCache.scale;
  }

  // A turn in degrees, [right, above], in page units.
  function turnToPage(turn) {
    const s = pageScale();
    return [s[0] * turn[0] + s[1] * turn[1], s[2] * turn[0] + s[3] * turn[1]];
  }

  // Writing mode: where the ink goes, moved by this sample's turn. (x, y) is where the pen
  // points, used to start from.
  function applyWriting(x, y, right, above, dt, penDown) {
    if (!config.writingMode) {
      clearWriting();
      return [x, y];
    }
    if (writePos === null) {
      writePos = { x: x, y: y };
    }
    const previous = lastWriteAngles || { right: right, above: above };
    lastWriteAngles = { right: right, above: above };
    const turn = [right - previous.right, above - previous.above];
    const k = lowPassAlpha(WRITING_SPEED_CUTOFF_HZ, dt);
    writeVelocity = [writeVelocity[0] + k * (turn[0] / dt - writeVelocity[0]), writeVelocity[1] + k * (turn[1] / dt - writeVelocity[1])];
    const speed = Math.hypot(writeVelocity[0], writeVelocity[1]);
    const gain =
      penDown === true
        ? precisionGain(speed, config)
        : config.writingGain * config.travelGain * accelerationGain(speed, WRITING_TRAVEL_ACCELERATION, config.accelerationMidDps);
    const [dx, dy] = turnToPage(turn);
    writePos = {
      x: Math.max(-1, Math.min(1, writePos.x + gain * dx)),
      y: Math.max(-1, Math.min(1, writePos.y + gain * dy)),
    };
    return [writePos.x, writePos.y];
  }

  function pointerUpdate(rate, dt, penDown) {
    yaw += dot(rate, up) * dt;
    turnSum = [turnSum[0] + rate[0] * dt, turnSum[1] + rate[1] * dt, turnSum[2] + rate[2] * dt];
    recentPointing.push({ yaw: yaw, up: up, turn: turnSum });
    if (recentPointing.length > CORNER_LOOKBACK + CORNER_AVERAGE) {
      recentPointing.shift();
    }
    const now = pointing();
    // Degrees right of and above the reference the yaw started from.
    let right = -now.yaw * config.horizontalSign;
    let above = now.pitch;
    if (config.pointerSmoothing > 0) {
      const minCutoff = smoothingToCutoff(config.pointerSmoothing);
      right = filterPointX.filter(right, dt, minCutoff, config.pointerBeta);
      above = filterPointY.filter(above, dt, minCutoff, config.pointerBeta);
    }

    if (corners !== null) {
      if (penDown === true && !wasPenDown) {
        captureCorner();
      }
      wasPenDown = penDown === true;
      return { dx: 0, dy: 0, ready: false };
    }
    wasPenDown = penDown === true;

    const mapping = config.screenMapping;
    if (center === null) {
      if (mapping !== null) {
        // Pointing now is the middle: line the mapping's frame up with it, left and right only.
        // Up and down comes from gravity, which doesn't drift.
        const middle = applyHomography(invertHomography(mapping), [0, 0]);
        rightShift = right - fromPlane(middle[0], middle[1])[0];
      }
      center = { right: right, above: above };
    }
    let x;
    let y;
    if (mapping !== null) {
      [x, y] = applyHomography(mapping, toPlane(right - rightShift, above));
    } else {
      x = (right - center.right) / config.pointerRangeXDeg;
      y = -(above - center.above) / config.pointerRangeYDeg;
    }
    x = Number.isFinite(x) ? Math.max(-POINTER_LIMIT, Math.min(POINTER_LIMIT, x)) : 0;
    y = Number.isFinite(y) ? Math.max(-POINTER_LIMIT, Math.min(POINTER_LIMIT, y)) : 0;
    [x, y] = applyWriting(x, y, right, above, dt, penDown);
    // dx and dy are for the debug graph only: the change, as if the page were 1000 px wide.
    const previous = lastPointer || { x: x, y: y };
    lastPointer = { x: x, y: y };
    return { absolute: true, x: x, y: y, dx: (x - previous.x) * 500, dy: (y - previous.y) * 500, ready: true };
  }

  // ---- Corner calibration ----
  //
  // The user points at each corner of the page in turn (top left, top right, bottom right,
  // bottom left) and taps the pad, or presses Enter, which calls captureCorner(). The cursor
  // stays put and nothing is drawn meanwhile. onProgress gets { step: 'corner', index } for each
  // corner, then { step: 'done' }, { step: 'failed', reason }, or { step: 'cancelled' }.
  function startScreenCalibration(onProgress) {
    cancelScreenCalibration();
    corners = { angles: [], onProgress: onProgress };
    onProgress({ step: 'corner', index: 0 });
  }

  function cancelScreenCalibration() {
    if (corners !== null) {
      const onProgress = corners.onProgress;
      corners = null;
      onProgress({ step: 'cancelled' });
    }
  }

  function captureCorner() {
    if (corners === null || recentPointing.length < CORNER_AVERAGE) {
      return;
    }
    const beforeTap = recentPointing.slice(0, Math.max(CORNER_AVERAGE, recentPointing.length - CORNER_LOOKBACK)).slice(-CORNER_AVERAGE);
    const upSum = [0, 1, 2].map((i) => beforeTap.reduce((sum, p) => sum + p.up[i], 0));
    corners.angles.push({
      yaw: beforeTap.reduce((sum, p) => sum + p.yaw, 0) / beforeTap.length,
      up: unitOrNull(upSum),
      turn: beforeTap[beforeTap.length - 1].turn,
    });
    if (corners.angles.length < 4) {
      corners.onProgress({ step: 'corner', index: corners.angles.length });
      return;
    }
    const readings = corners.angles;
    const onProgress = corners.onProgress;
    corners = null;

    // Top left to top right was a move right, and top right to bottom right a move down: the
    // same two motions the axis wizard measures. So they also give the left-right sign and the
    // way the pen points, and remounting the sensor needs nothing more than this calibration.
    let sign = config.horizontalSign;
    let penAxis = config.penAxis;
    const moveRight = readings[1].turn.map((n, i) => n - readings[0].turn[i]);
    const moveDown = readings[2].turn.map((n, i) => n - readings[1].turn[i]);
    const learned = Math.hypot(...moveRight) >= MIN_TILT_DEG && Math.hypot(...moveDown) >= MIN_TILT_DEG;
    if (learned) {
      sign = dot(moveRight, readings[0].up) <= 0 ? 1 : -1;
      // Up halfway down the right edge, where the pen is about level, so the pen's own tilt
      // at the top doesn't skew its direction.
      const levelUp = unitOrNull(readings[1].up.map((n, i) => n + readings[2].up[i]));
      const pointing = cross(normalize(moveDown), levelUp);
      if (Math.hypot(pointing[0], pointing[1], pointing[2]) >= MIN_SIDEWAYS) {
        penAxis = normalize(pointing);
      }
    }
    const axis = unitOrNull(penAxis);
    const angles = readings.map(function (r) {
      const lift = Math.max(-1, Math.min(1, dot(axis, r.up)));
      return [-r.yaw * sign, (Math.asin(lift) * 180) / Math.PI];
    });
    const result = mappingFromCorners(angles);
    if (result.mapping === null) {
      onProgress({ step: 'failed', reason: result.reason });
      return;
    }
    config.screenMapping = result.mapping;
    config.horizontalSign = sign;
    config.penAxis = penAxis;
    rightShift = 0;
    filterPointX.reset();
    filterPointY.reset();
    clearWriting();
    onProgress({ step: 'done', learnedPenAxis: learned });
  }

  function clearScreenMapping() {
    config.screenMapping = null;
    center = null;
  }

  // Rotation rates (deg/s, bias removed) to cursor rates, right and down positive.
  function screenRates(rate) {
    if (config.rollCompensation && up !== null) {
      const rateX = -dot(rate, up) * config.horizontalSign;
      const sideways = cross(up, config.penAxis);
      const length = Math.hypot(sideways[0], sideways[1], sideways[2]);
      const rateY = length >= MIN_SIDEWAYS ? dot(rate, sideways) / length : dot(rate, config.yVector);
      return [rateX, rateY];
    }
    return [dot(rate, config.xVector), dot(rate, config.yVector)];
  }

  // Takes one sample, returns how far to move the cursor in pixels.
  // ready is false while calibrating, and the app ignores movement until it's true.
  // penDown (optional) says whether the app is drawing, which picks drawingGain or travelGain.
  function update(sample, penDown) {
    if (bias === null) {
      if (config.calibrationMs <= 0) {
        bias = { gx: 0, gy: 0, gz: 0 };
      } else {
        calibrate(sample);
        lastT = sample.t;
        if (wizard !== null) {
          wizard.onProgress({ step: 'still', progress: getState().progress });
        }
        return { dx: 0, dy: 0, ready: false };
      }
    }

    if (lastT === null) {
      lastT = sample.t;
      return { dx: 0, dy: 0, ready: true };
    }
    const dtMs = sample.t - lastT;
    lastT = sample.t;
    if (dtMs <= 0 || dtMs > config.maxGapMs) {
      return { dx: 0, dy: 0, ready: true };
    }
    const dt = dtMs / 1000;

    const rate = [sample.gx - bias.gx, sample.gy - bias.gy, sample.gz - bias.gz];
    trackGravity(sample, rate, dt);
    if (wizard !== null) {
      wizardStep(rate, sample.t, dt);
      return { dx: 0, dy: 0, ready: false };
    }
    if (config.pointerMode && up !== null) {
      return pointerUpdate(rate, dt, penDown);
    }
    lastPointer = null;
    let [rateX, rateY] = screenRates(rate);

    if (config.smoothing > 0) {
      const minCutoff = smoothingToCutoff(config.smoothing);
      rateX = filterX.filter(rateX, dt, minCutoff, config.smoothingBeta);
      rateY = filterY.filter(rateY, dt, minCutoff, config.smoothingBeta);
    } else {
      filterX.reset();
      filterY.reset();
    }

    // Shrinks the rotation by the deadzone instead of cutting it off, so leaving the
    // deadzone starts from zero speed rather than jumping.
    const speed = Math.hypot(rateX, rateY);
    if (config.deadzone > 0) {
      const scale = speed > config.deadzone ? (speed - config.deadzone) / speed : 0;
      rateX *= scale;
      rateY *= scale;
    }

    let gain = config.pixelsPerDegree;
    if (penDown === true) {
      gain *= config.writingMode ? precisionGain(Math.hypot(rateX, rateY), config) : config.drawingGain;
    } else {
      gain *= accelerationGain(Math.hypot(rateX, rateY), config.acceleration, config.accelerationMidDps);
      if (penDown === false) {
        gain *= config.travelGain;
      }
    }
    return {
      dx: rateX * dt * gain,
      dy: rateY * dt * gain,
      ready: true,
    };
  }

  // Measures the screen directions in three timed steps, with the cursor frozen throughout:
  //   still  hold still while the bias is measured (calibrationMs)
  //   right  draw a line to the right, the way you write, within WIZARD_STEP_MS
  //   down   draw a line down, the way you write, within WIZARD_STEP_MS
  // It measures drawing, not pointing, because on the real pen the two turn the hand differently:
  // pointing up and drawing down came out far from opposite, so down strokes slanted.
  // onProgress gets { step, progress } as it goes, progress being 0 to 1 within the step,
  // then { step: 'done', result }, { step: 'failed', reason }, or { step: 'cancelled' }.
  // On done the new vectors are already in config. result.right and result.down each hold the
  // measured vector, its size in degrees, and the dominant single axis and sign.
  function startAxisWizard(onProgress) {
    cancelAxisWizard();
    restartCalibration();
    wizard = { step: 'still', onProgress: onProgress, startT: null, sum: [0, 0, 0], startUp: null, right: null };
    onProgress({ step: 'still', progress: 0 });
  }

  function cancelAxisWizard() {
    if (wizard !== null) {
      const onProgress = wizard.onProgress;
      wizard = null;
      onProgress({ step: 'cancelled' });
    }
  }

  function finishWizard(message) {
    const onProgress = wizard.onProgress;
    wizard = null;
    onProgress(message);
  }

  // Runs once calibration is done, on every sample until the wizard ends.
  function wizardStep(rate, t, dt) {
    if (wizard.step === 'still') {
      wizard.step = 'right';
      wizard.startT = t;
      wizard.startUp = up;
    }
    for (let i = 0; i < 3; i++) {
      wizard.sum[i] += rate[i] * dt;
    }
    const elapsed = t - wizard.startT;
    if (elapsed < WIZARD_STEP_MS) {
      wizard.onProgress({ step: wizard.step, progress: elapsed / WIZARD_STEP_MS });
      return;
    }

    const tilt = wizard.sum;
    const degrees = Math.hypot(tilt[0], tilt[1], tilt[2]);
    if (degrees < MIN_TILT_DEG) {
      finishWizard({ step: 'failed', reason: 'No ' + wizard.step + ' line seen. Draw a longer line and try again' });
      return;
    }
    // up is gravity from the start of the step, while the pen was still level: drawing the
    // line tips it, and an average would skew the pen axis by about half the tilt.
    const measured = { vector: normalize(tilt), degrees: degrees, dominant: dominantAxis(tilt), up: wizard.startUp };
    if (wizard.step === 'right') {
      wizard.right = measured;
      wizard.step = 'down';
      wizard.startT = t;
      wizard.sum = [0, 0, 0];
      wizard.startUp = up;
      wizard.onProgress({ step: 'down', progress: 0 });
      return;
    }

    // Any part of the down line that's really sideways is removed, so the two directions are
    // independent and a pure sideways line can't nudge the cursor up or down.
    const right = wizard.right.vector;
    const down = measured.vector;
    const along = dot(down, right);
    const offRight = Math.abs(along);
    if (offRight > 0.7) {
      finishWizard({ step: 'failed', reason: 'The right and down lines turned the pen the same way. Try again' });
      return;
    }
    config.xVector = right;
    config.yVector = normalize([down[0] - along * right[0], down[1] - along * right[1], down[2] - along * right[2]]);
    // Roll compensation: turning right is turning around up, so its sign says which way round.
    // The pen points along down x up, since drawing down turns it around the sideways axis.
    if (wizard.right.up !== null && measured.up !== null) {
      config.horizontalSign = dot(wizard.right.vector, wizard.right.up) <= 0 ? 1 : -1;
      const pointing = cross(down, measured.up);
      if (Math.hypot(pointing[0], pointing[1], pointing[2]) >= MIN_SIDEWAYS) {
        config.penAxis = normalize(pointing);
      }
    }
    finishWizard({ step: 'done', result: { right: wizard.right, down: measured } });
  }

  function restartCalibration() {
    lastT = null;
    calibrationStartT = null;
    sums = { gx: 0, gy: 0, gz: 0 };
    squares = { gx: 0, gy: 0, gz: 0 };
    accelSums = [0, 0, 0];
    count = 0;
    bias = null;
    up = null;
    yaw = 0;
    center = null;
    lastPointer = null;
    clearWriting();
    recentPointing = [];
    turnSum = [0, 0, 0];
    filterPointX.reset();
    filterPointY.reset();
    movedDuringCalibration = false;
    filterX.reset();
    filterY.reset();
  }

  // Called when the user presses R or reconnects. Starts calibration over.
  function reset() {
    cancelAxisWizard();
    cancelScreenCalibration();
    restartCalibration();
  }

  // For the debug panel. progress is 0 to 1 while calibrating, bias is null until done, and
  // moved is true if calibration had to start over because the pen moved.
  function getState() {
    let progress = 1;
    if (bias === null) {
      progress = calibrationStartT === null ? 0 : Math.min(1, (lastT - calibrationStartT) / config.calibrationMs);
    }
    return { calibrating: bias === null, progress: progress, bias: bias, moved: movedDuringCalibration, up: up };
  }

  return {
    update,
    reset,
    recenter,
    getState,
    startAxisWizard,
    cancelAxisWizard,
    startScreenCalibration,
    cancelScreenCalibration,
    captureCorner,
    clearScreenMapping,
    config,
  };
}

// Turns stored or pasted settings into a safe config: unknown keys are dropped, and values
// of the wrong type, or axes that don't exist, fall back to the default.
export function sanitizeConfig(raw) {
  const clean = Object.assign({}, DEFAULT_CONFIG);
  if (raw === null || typeof raw !== 'object') {
    return clean;
  }
  const keys = Object.keys(DEFAULT_CONFIG);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = raw[key];
    const expected = typeof DEFAULT_CONFIG[key];
    if (Array.isArray(DEFAULT_CONFIG[key])) {
      if (isDirection(value)) {
        clean[key] = normalize(value);
      }
      continue;
    }
    if (typeof value !== expected) {
      continue;
    }
    if (key === 'screenMapping') {
      if (value === null || (Array.isArray(value) && value.length === 9 && value.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
        clean[key] = value;
      }
      continue;
    }
    if (key === 'horizontalSign') {
      if (value === 1 || value === -1) clean[key] = value;
      continue;
    }
    if (expected === 'number' && (!Number.isFinite(value) || value < 0)) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

function unitOrNull(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

function isDirection(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(function (n) {
      return typeof n === 'number' && Number.isFinite(n);
    }) &&
    Math.hypot(value[0], value[1], value[2]) > 0.1
  );
}

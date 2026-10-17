// Owned by CpE 2. Replace the inside freely, but keep the exported shape so the rest of
// the app keeps working. See motion/README.md for the contract.
//
// Per sample: gyro rates -> subtract bias -> project onto the screen directions ->
// One Euro filter -> deadzone -> pixels. The bias is the average of the first
// calibrationMs of samples, while the user holds the pen still. Every setting is read
// from `config` on each sample, so the debug panel (D key) can change them live.
//
// The screen directions are vectors in gyro space, not single axes, because the sensor
// sits at an angle in the pen: a sweep to the right turns gz but also gx and gy. A plain
// axis is still possible, [0, 0, 1] is gz alone. startAxisWizard() measures them.

export const AXES = ['gx', 'gy', 'gz'];

export const DEFAULT_CONFIG = {
  // Unit vectors (gx, gy, gz) for the rotation that moves the cursor right, and down.
  // Measured on the real pen from left, right, up, and down sweeps.
  xVector: [0.47, -0.43, 0.77],
  yVector: [-0.8, -0.55, 0.23],
  pixelsPerDegree: 12, // sensitivity
  smoothing: 0, // 0 is off, 1 is heaviest. Sets the One Euro filter's minimum cutoff
  smoothingBeta: 0.02, // how quickly the filter opens up for fast movement
  deadzone: 0, // degrees per second of rotation ignored as hand tremor
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

// Axis wizard: each tilt step lasts WIZARD_STEP_MS, and a tilt smaller than
// MIN_TILT_DEG means the user didn't move, so the wizard fails instead of guessing.
const WIZARD_STEP_MS = 2000;
const MIN_TILT_DEG = 5;

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

export function createMotion(overrides) {
  const config = Object.assign({}, DEFAULT_CONFIG, overrides || {});
  const filterX = createOneEuro();
  const filterY = createOneEuro();
  let lastT = null;
  let calibrationStartT = null;
  let sums = { gx: 0, gy: 0, gz: 0 };
  let count = 0;
  let bias = null;
  let wizard = null;

  function calibrate(sample) {
    if (calibrationStartT === null) {
      calibrationStartT = sample.t;
    }
    for (let i = 0; i < AXES.length; i++) {
      sums[AXES[i]] += sample[AXES[i]];
    }
    count++;
    if (sample.t - calibrationStartT >= config.calibrationMs) {
      bias = { gx: sums.gx / count, gy: sums.gy / count, gz: sums.gz / count };
    }
  }

  // Takes one sample, returns how far to move the cursor in pixels.
  // ready is false while calibrating, and the app ignores movement until it's true.
  function update(sample) {
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
    if (wizard !== null) {
      wizardStep(rate, sample.t, dt);
      return { dx: 0, dy: 0, ready: false };
    }
    let rateX = dot(rate, config.xVector);
    let rateY = dot(rate, config.yVector);

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

    return {
      dx: rateX * dt * config.pixelsPerDegree,
      dy: rateY * dt * config.pixelsPerDegree,
      ready: true,
    };
  }

  // Measures the screen directions in three timed steps, with the cursor frozen throughout:
  //   still  hold still while the bias is measured (calibrationMs)
  //   right  tilt the pen right, within WIZARD_STEP_MS
  //   up     tilt the pen up, within WIZARD_STEP_MS
  // onProgress gets { step, progress } as it goes, progress being 0 to 1 within the step,
  // then { step: 'done', result }, { step: 'failed', reason }, or { step: 'cancelled' }.
  // On done the new vectors are already in config. result.right and result.up each hold the
  // measured vector, its size in degrees, and the dominant single axis and sign.
  function startAxisWizard(onProgress) {
    cancelAxisWizard();
    restartCalibration();
    wizard = { step: 'still', onProgress: onProgress, startT: null, sum: [0, 0, 0], right: null };
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
      finishWizard({ step: 'failed', reason: 'No ' + wizard.step + ' tilt seen. Tilt further and try again' });
      return;
    }
    const measured = { vector: normalize(tilt), degrees: degrees, dominant: dominantAxis(tilt) };
    if (wizard.step === 'right') {
      wizard.right = measured;
      wizard.step = 'up';
      wizard.startT = t;
      wizard.sum = [0, 0, 0];
      wizard.onProgress({ step: 'up', progress: 0 });
      return;
    }

    // Down is the opposite of up. Any part of it that's really sideways is removed, so the
    // two directions are independent and a pure sideways tilt can't nudge the cursor up or down.
    const right = wizard.right.vector;
    const down = [-measured.vector[0], -measured.vector[1], -measured.vector[2]];
    const along = dot(down, right);
    const offRight = Math.abs(along);
    if (offRight > 0.7) {
      finishWizard({ step: 'failed', reason: 'The right and up tilts turned the pen the same way. Try again' });
      return;
    }
    config.xVector = right;
    config.yVector = normalize([down[0] - along * right[0], down[1] - along * right[1], down[2] - along * right[2]]);
    finishWizard({ step: 'done', result: { right: wizard.right, up: measured } });
  }

  function restartCalibration() {
    lastT = null;
    calibrationStartT = null;
    sums = { gx: 0, gy: 0, gz: 0 };
    count = 0;
    bias = null;
    filterX.reset();
    filterY.reset();
  }

  // Called when the user presses R or reconnects. Starts calibration over.
  function reset() {
    cancelAxisWizard();
    restartCalibration();
  }

  // For the debug panel. progress is 0 to 1 while calibrating, bias is null until done.
  function getState() {
    let progress = 1;
    if (bias === null) {
      progress = calibrationStartT === null ? 0 : Math.min(1, (lastT - calibrationStartT) / config.calibrationMs);
    }
    return { calibrating: bias === null, progress: progress, bias: bias };
  }

  return { update, reset, getState, startAxisWizard, cancelAxisWizard, config };
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
    if (expected === 'number' && (!Number.isFinite(value) || value < 0)) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
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

// PLACEHOLDER owned by CpE 2. Replace the inside freely, but keep the exported shape
// so the rest of the app keeps working. See motion/README.md for the contract.
//
// Right now this maps gyro rotation speed straight to cursor movement with no
// calibration and no smoothing. Expect slow drift (gyro bias) and shaky lines.

export const DEFAULT_CONFIG = {
  xAxis: 'gz', // gyro axis that moves the cursor left and right
  yAxis: 'gy', // gyro axis that moves it up and down
  invertX: false,
  invertY: true,
  pixelsPerDegree: 12, // sensitivity
  maxGapMs: 50, // ignore time gaps longer than this so a dropped packet can't fling the cursor
};

export function createMotion(overrides) {
  const config = Object.assign({}, DEFAULT_CONFIG, overrides || {});
  let lastT = null;

  // Takes one sample, returns how far to move the cursor in pixels.
  // ready is false while the module isn't able to produce movement yet (during calibration, say).
  function update(sample) {
    if (lastT === null) {
      lastT = sample.t;
      return { dx: 0, dy: 0, ready: true };
    }

    let dtMs = sample.t - lastT;
    lastT = sample.t;
    if (dtMs <= 0 || dtMs > config.maxGapMs) {
      return { dx: 0, dy: 0, ready: true };
    }
    const dt = dtMs / 1000;

    let rateX = sample[config.xAxis];
    let rateY = sample[config.yAxis];
    if (config.invertX) rateX = -rateX;
    if (config.invertY) rateY = -rateY;

    return {
      dx: rateX * dt * config.pixelsPerDegree,
      dy: rateY * dt * config.pixelsPerDegree,
      ready: true,
    };
  }

  // Called when the user presses R or reconnects. Start calibration over here.
  function reset() {
    lastT = null;
  }

  return { update, reset, config };
}

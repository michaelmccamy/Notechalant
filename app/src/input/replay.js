// Plays a recording at real speed, using each sample's t to time it.
// This lets the app and motion code be tested end to end with no hardware.

export function playRecording(samples, onSample, onDone, speed) {
  if (samples.length === 0) {
    onDone();
    return { stop: function () {} };
  }

  const rate = speed || 1;
  const firstT = samples[0].t;
  const startedAt = performance.now();
  let index = 0;
  let stopped = false;

  function tick() {
    if (stopped) {
      return;
    }
    const elapsed = (performance.now() - startedAt) * rate;
    // Emit every sample whose time has come. Usually one or two per frame at 100 Hz.
    while (index < samples.length && samples[index].t - firstT <= elapsed) {
      onSample(samples[index]);
      index++;
    }
    if (index >= samples.length) {
      onDone();
      return;
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  function stop() {
    stopped = true;
  }

  return { stop };
}

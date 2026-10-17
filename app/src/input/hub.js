// Every hardware input (serial, WebSocket, replay) calls onPenData(sample).
// The hub runs the sample through the motion module and moves the ink cursor.
// The mouse does not come through here because it already has a screen position.

export function createInputHub({ ink, motion }) {
  let spacebarDown = false;
  let lastSampleAt = 0;

  function onPenData(sample) {
    lastSampleAt = performance.now();
    const movement = motion.update(sample);
    if (!movement.ready) {
      return;
    }
    const penDown = sample.pen === 1 || spacebarDown;
    ink.moveBy(movement.dx, movement.dy, penDown);
  }

  function setSpacebar(isDown) {
    spacebarDown = isDown;
  }

  function recalibrate() {
    motion.reset();
    ink.centerCursor();
  }

  // True if a hardware sample arrived recently. The UI uses this to show a live indicator.
  function isReceiving() {
    return performance.now() - lastSampleAt < 500;
  }

  return { onPenData, setSpacebar, recalibrate, isReceiving };
}

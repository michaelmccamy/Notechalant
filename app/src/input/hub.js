// Every hardware input (serial, WebSocket, replay) calls onPenData(sample).
// The hub runs the sample through the motion module and moves the ink cursor: by an amount in
// relative mode, or to a spot on the page in pointer mode (movement.absolute).
// The mouse does not come through here because it already has a screen position.
// A double tap on the pen's touch pad calls onDoubleTap (main.js recalibrates on it), and a triple
// tap onTripleTap (main.js clears the page).

import { createDoubleTap } from './doubleTap.js';

export function createInputHub({ ink, motion, onDoubleTap, onTripleTap }) {
  let spacebarDown = false;
  let lastSampleAt = 0;
  const doubleTap = createDoubleTap();

  function onPenData(sample) {
    lastSampleAt = performance.now();
    const penDown = sample.pen === 1 || spacebarDown;
    // The motion module moves the cursor a little slower while drawing than while travelling.
    const movement = motion.update(sample, penDown);
    if (movement.ready) {
      // Writing mode's lazy brush. Read every sample so the D panel's slider applies live.
      ink.setLazyRadius(motion.config.writingMode ? motion.config.writingString : 0);
      if (movement.absolute) {
        ink.pointAt(movement.x, movement.y, penDown);
      } else {
        ink.moveBy(movement.dx, movement.dy, penDown);
      }
    }
    // After the move, so the last tap's dot is finished and the handler can remove it.
    const taps = doubleTap.update(sample.pen, sample.t);
    if (taps === 2 && onDoubleTap) {
      onDoubleTap();
    } else if (taps === 3 && onTripleTap) {
      onTripleTap();
    }
  }

  function setSpacebar(isDown) {
    spacebarDown = isDown;
  }

  function recalibrate() {
    motion.reset();
    ink.centerCursor();
  }

  // Pointer mode: wherever the pen points now becomes the middle of the page.
  function recenter() {
    if (motion.recenter) {
      motion.recenter();
    }
    ink.centerCursor();
  }

  // True if a hardware sample arrived recently. The UI uses this to show a live indicator.
  function isReceiving() {
    return performance.now() - lastSampleAt < 500;
  }

  return { onPenData, setSpacebar, recalibrate, recenter, isReceiving };
}

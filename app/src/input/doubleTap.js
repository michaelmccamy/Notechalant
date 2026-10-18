// Spots a double tap on the pen's touch pad from the samples' pen field and time.
// A tap is a touch shorter than MAX_TAP_MS. Two taps count when the second touch starts
// within MAX_GAP_MS of the first one ending. Pure, so it runs under `npm test`.

const MAX_TAP_MS = 250;
const MAX_GAP_MS = 400;

export function createDoubleTap() {
  let down = false;
  let pressedAt = 0;
  let lastTapEndedAt = null;
  let firstTapPending = false;

  // Feed every sample's pen state and time (ms). Returns true on the sample that completes
  // a double tap.
  function update(pen, t) {
    if (pen === 1 && !down) {
      down = true;
      firstTapPending = lastTapEndedAt !== null && t - lastTapEndedAt <= MAX_GAP_MS;
      pressedAt = t;
      return false;
    }
    if (pen !== 1 && down) {
      down = false;
      const wasTap = t - pressedAt <= MAX_TAP_MS;
      if (wasTap && firstTapPending) {
        lastTapEndedAt = null;
        firstTapPending = false;
        return true;
      }
      lastTapEndedAt = wasTap ? t : null;
    }
    return false;
  }

  return { update };
}

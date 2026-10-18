// Spots double and triple taps on the pen's touch pad from the samples' pen field and time.
// A tap is a touch shorter than MAX_TAP_MS. Taps chain when each touch starts within
// MAX_GAP_MS of the last one ending. Pure, so it runs under `npm test`.
//
// The double tap fires on the second tap without waiting to see if a third follows, so
// recentering has no delay. A third tap then fires as a triple tap.

const MAX_TAP_MS = 250;
const MAX_GAP_MS = 400;

export function createDoubleTap() {
  let down = false;
  let pressedAt = 0;
  let lastTapEndedAt = null;
  // Taps so far in the current chain.
  let taps = 0;

  // Feed every sample's pen state and time (ms). Returns 2 on the sample that completes a double
  // tap, 3 on the one that completes a triple tap, and 0 otherwise.
  function update(pen, t) {
    if (pen === 1 && !down) {
      down = true;
      if (lastTapEndedAt === null || t - lastTapEndedAt > MAX_GAP_MS) {
        taps = 0;
      }
      pressedAt = t;
      return 0;
    }
    if (pen !== 1 && down) {
      down = false;
      if (t - pressedAt > MAX_TAP_MS) {
        taps = 0;
        lastTapEndedAt = null;
        return 0;
      }
      taps++;
      lastTapEndedAt = t;
      if (taps === 3) {
        taps = 0;
        lastTapEndedAt = null;
        return 3;
      }
      return taps === 2 ? 2 : 0;
    }
    return 0;
  }

  return { update };
}

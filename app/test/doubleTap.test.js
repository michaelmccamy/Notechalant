// Tests double and triple taps on the touch pad: a double tap recenters, a triple tap clears.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoubleTap } from '../src/input/doubleTap.js';

// Feeds pen states at 100 Hz from a list of [pen, durationMs] and returns the times a double tap
// fired, or with `count` 3, a triple tap.
function play(steps, count) {
  const detector = createDoubleTap();
  const fired = [];
  let t = 0;
  for (const [pen, ms] of steps) {
    for (let i = 0; i < ms / 10; i++) {
      if (detector.update(pen, t) === (count || 2)) fired.push(t);
      t += 10;
    }
  }
  return fired;
}

test('two quick taps fire once, on the second release', function () {
  assert.deepEqual(play([[0, 100], [1, 120], [0, 150], [1, 120], [0, 100]]), [490]);
});

test('a long press, slow taps, or one tap do not fire', function () {
  assert.deepEqual(play([[0, 100], [1, 600], [0, 150], [1, 120], [0, 100]]), [], 'first touch was a stroke');
  assert.deepEqual(play([[0, 100], [1, 120], [0, 700], [1, 120], [0, 100]]), [], 'too far apart');
  assert.deepEqual(play([[0, 100], [1, 120], [0, 100]]), [], 'one tap');
  assert.deepEqual(play([[0, 100], [1, 120], [0, 150], [1, 500], [0, 100]]), [], 'second touch was a stroke');
});

test('a third quick tap fires a triple tap, after the double tap', function () {
  const steps = [[0, 50], [1, 100], [0, 100], [1, 100], [0, 100], [1, 100], [0, 100]];
  assert.deepEqual(play(steps), [350], 'double on the second tap, with no wait');
  assert.deepEqual(play(steps, 3), [550], 'triple on the third');
  // A fourth tap starts over, so four taps are a triple and then a single.
  assert.deepEqual(play([...steps, [1, 100], [0, 100]], 2), [350]);
  // A slow third tap is just a new tap.
  assert.deepEqual(play([[0, 50], [1, 100], [0, 100], [1, 100], [0, 600], [1, 100], [0, 100]], 3), []);
  // A stroke after a double tap doesn't make a triple.
  assert.deepEqual(play([[0, 50], [1, 100], [0, 100], [1, 100], [0, 100], [1, 500], [0, 100]], 3), []);
});

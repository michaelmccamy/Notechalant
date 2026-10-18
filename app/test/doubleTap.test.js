// Tests double tap on the touch pad, which recenters pointer mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoubleTap } from '../src/input/doubleTap.js';

// Feeds pen states at 100 Hz from a list of [pen, durationMs] and returns the times it fired.
function play(steps) {
  const detector = createDoubleTap();
  const fired = [];
  let t = 0;
  for (const [pen, ms] of steps) {
    for (let i = 0; i < ms / 10; i++) {
      if (detector.update(pen, t)) fired.push(t);
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

test('a third quick tap starts a new pair instead of firing again', function () {
  assert.deepEqual(play([[0, 50], [1, 100], [0, 100], [1, 100], [0, 100], [1, 100], [0, 100]]), [350]);
});

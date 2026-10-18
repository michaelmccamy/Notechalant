// Tests corner calibration's mapping from pointing angles to the page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPlane, fromPlane, computeHomography, applyHomography, invertHomography, mappingFromCorners, CORNERS } from '../src/motion/screenMap.js';

// Where a pen at the origin points to hit screen point (sx, sy, sz) in metres, as
// [degrees right, degrees up]. The screen is a flat rectangle somewhere in front.
function aim([sx, sy, sz]) {
  const right = (Math.atan2(sx, sz) * 180) / Math.PI;
  const up = (Math.atan2(sy, Math.hypot(sx, sz)) * 180) / Math.PI;
  return [right, up];
}

// A 2 m by 1.2 m screen, 3 m away, off to the right and above, and turned 30 degrees.
function screenPoint(x, y) {
  const turn = (30 * Math.PI) / 180;
  const along = x * 1.0;
  return [0.8 + along * Math.cos(turn), 0.5 - y * 0.6, 3 + along * Math.sin(turn)];
}

function close(a, b, tolerance, label) {
  assert.ok(Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance, label + ': ' + a + ' vs ' + b);
}

test('plane coordinates round trip', function () {
  close(fromPlane(...toPlane(25, -10)), [25, -10], 1e-9, 'round trip');
});

test('homography through four points, and its inverse', function () {
  const src = [[0, 0], [2, 0.2], [2.4, 1.8], [-0.3, 1.5]];
  const h = computeHomography(src, CORNERS);
  src.forEach((p, i) => close(applyHomography(h, p), CORNERS[i], 1e-9, 'corner ' + i));
  const back = invertHomography(h);
  close(applyHomography(back, [0.3, -0.5]), applyHomography(back, applyHomography(h, applyHomography(back, [0.3, -0.5]))), 1e-9, 'inverse');
  assert.equal(computeHomography([[0, 0], [1, 1], [2, 2], [3, 3]], CORNERS), null, 'points in a line');
});

test('pointing at four corners maps every spot of a screen seen at an angle exactly', function () {
  const corners = CORNERS.map(([x, y]) => aim(screenPoint(x, y)));
  const { mapping } = mappingFromCorners(corners);
  assert.ok(mapping !== null);
  for (const [x, y] of [[0, 0], [0.5, -0.3], [-0.8, 0.9], [0.25, 0.75]]) {
    const [right, up] = aim(screenPoint(x, y));
    close(applyHomography(mapping, toPlane(right, up)), [x, y], 1e-6, 'spot ' + x + ',' + y);
  }
});

test('corners pointed at in the wrong order, or barely apart, are refused', function () {
  const good = CORNERS.map(([x, y]) => aim(screenPoint(x, y)));
  const swapped = [good[1], good[0], good[2], good[3]];
  assert.equal(mappingFromCorners(swapped).mapping, null, 'swapped');
  assert.equal(mappingFromCorners([good[0], good[0], good[0], good[0]]).mapping, null, 'all the same');
  const tiny = [[0, 0], [1, 0], [1, -1], [0, -1]];
  assert.match(mappingFromCorners(tiny).reason, /too close/);
  // The desk calibration that felt far too sensitive: 21.5 degrees across but 3.7 tall, from
  // reaching for the near and far corners with the hand instead of tilting the pen.
  const squashed = [[22.8, 20.2], [42.0, 16.7], [42.8, 15.5], [19.5, 15.1]];
  assert.equal(mappingFromCorners(squashed).mapping, null);
  assert.match(mappingFromCorners(squashed).reason, /tilt the pen/);
  // A long thin one that is big enough both ways is still squashed.
  assert.match(mappingFromCorners([[-20, 4], [20, 4], [20, -4], [-20, -4]]).reason, /Up and down came out much smaller/);
  // The good ones from earlier recordings pass.
  assert.ok(mappingFromCorners([[-12.5, 8.5], [12.5, 8.5], [12.5, -8.5], [-12.5, -8.5]]).mapping !== null);
});

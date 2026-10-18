// Tests shape snapping: clean lines, ellipses, and rectangles, and leaving letters alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapStroke, isClosedLoop, isJustMarks, underlineOf } from '../src/ink/shapes.js';

// Seeded wobble, so a "hand drawn" stroke is the same every run.
let seed = 7;
function wobble(amount) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return (seed / 2147483648 - 0.5) * 2 * amount;
}

function stroke(points) {
  return { color: '#1c1c1a', width: 4, points: points.map(([x, y]) => ({ x, y })) };
}

function handLine(x0, y0, x1, y1, shake) {
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    pts.push([x0 + (x1 - x0) * t + wobble(shake), y0 + (y1 - y0) * t + wobble(shake)]);
  }
  return stroke(pts);
}

function handEllipse(cx, cy, rx, ry, shake) {
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * rx + wobble(shake), cy + Math.sin(a) * ry + wobble(shake)]);
  }
  return stroke(pts);
}

function handBox(x, y, w, h, shake) {
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  const pts = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 15; i++) {
      const t = i / 15;
      pts.push([
        corners[c][0] + (corners[c + 1][0] - corners[c][0]) * t + wobble(shake),
        corners[c][1] + (corners[c + 1][1] - corners[c][1]) * t + wobble(shake),
      ]);
    }
  }
  pts.push([x + wobble(shake), y + wobble(shake)]);
  return stroke(pts);
}

test('a shaky, slightly tilted down stroke becomes a straight upright line', function () {
  const snapped = snapStroke(handLine(100, 100, 115, 300, 3));
  assert.equal(snapped.shape, 'line');
  const [a, b] = snapped.stroke.points;
  assert.ok(Math.abs(a.x - b.x) < 1e-9, 'exactly upright');
  assert.ok(Math.abs(b.y - a.y - 200.6) < 2, 'keeps its length, ' + (b.y - a.y));
  assert.ok(Math.abs((a.x + b.x) / 2 - 107.5) < 2, 'keeps its middle');
});

test('a clearly diagonal line stays diagonal', function () {
  const snapped = snapStroke(handLine(0, 0, 150, 150, 2));
  assert.equal(snapped.shape, 'line');
  const [a, b] = snapped.stroke.points;
  assert.ok(Math.abs(Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 4) < 0.05);
});

test('a rough circle becomes a clean ellipse in the same box', function () {
  const snapped = snapStroke(handEllipse(200, 200, 80, 60, 4));
  assert.equal(snapped.shape, 'ellipse');
  const xs = snapped.stroke.points.map((p) => p.x);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 160) < 12);
});

test('a rough box becomes a sharp rectangle', function () {
  const snapped = snapStroke(handBox(50, 50, 200, 120, 3));
  assert.equal(snapped.shape, 'rectangle');
  assert.equal(snapped.stroke.points.length, 9, 'four doubled corners plus the start');
  assert.equal(snapped.stroke.color, '#1c1c1a');
});

test('letters, open curves, and tiny strokes are left alone', function () {
  // An S: two opposite arcs.
  const s = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    s.push([100 + Math.sin(a) * 30 * (i < 20 ? 1 : -1), 100 + i * 3]);
  }
  assert.equal(snapStroke(stroke(s)), null, 'S');
  // A C: three quarters of a circle, open.
  const c = [];
  for (let i = 0; i <= 30; i++) {
    const a = Math.PI / 4 + (i / 30) * Math.PI * 1.5;
    c.push([100 + Math.cos(a) * 50, 100 + Math.sin(a) * 50]);
  }
  assert.equal(snapStroke(stroke(c)), null, 'C');
  assert.equal(snapStroke(handLine(0, 0, 10, 12, 0.5)), null, 'too small');
  assert.equal(snapStroke(stroke([[0, 0], [50, 50]])), null, 'too few points');
});

test('circle to ask: a loose loop around something counts, a written o or a line does not', function () {
  // A lopsided, shaky loop that doesn't close exactly, like a quick circle around an equation.
  const loose = handEllipse(300, 200, 180, 70, 12);
  loose.points.pop();
  loose.points.pop();
  assert.equal(isClosedLoop(loose.points), true);
  assert.equal(isClosedLoop(handBox(100, 100, 300, 150, 6).points), true, 'a box around something');
  assert.equal(isClosedLoop(handEllipse(100, 100, 20, 25, 1).points), false, 'a written o is too small');
  assert.equal(isClosedLoop(handLine(0, 0, 300, 200, 3).points), false, 'a line');
  const c = [];
  for (let i = 0; i <= 30; i++) {
    const a = Math.PI / 4 + (i / 30) * Math.PI * 1.5;
    c.push({ x: 200 + Math.cos(a) * 100, y: 200 + Math.sin(a) * 100 });
  }
  assert.equal(isClosedLoop(c), false, 'an open C');
});

test('underlines and circles are marks, writing is not', function () {
  const underline = handLine(100, 300, 400, 305, 2);
  const circle = handEllipse(300, 200, 150, 60, 6);
  assert.equal(isJustMarks([underline]), true, 'an underline');
  assert.equal(isJustMarks([underline, circle]), true, 'an underline and a circle');
  // H: three straight strokes is writing.
  assert.equal(isJustMarks([handLine(0, 0, 0, 100, 2), handLine(60, 0, 60, 100, 2), handLine(0, 50, 60, 50, 2)]), false, 'an H');
  // A curvy stroke, like a written S, is writing.
  const s = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    s.push([100 + Math.sin(a) * 30 * (i < 20 ? 1 : -1), 100 + i * 3]);
  }
  assert.equal(isJustMarks([stroke(s)]), false, 'an S');
  assert.equal(isJustMarks([handLine(0, 0, 10, 0, 0.5)]), false, 'a short dash could be a minus sign');
  assert.equal(isJustMarks([]), false);
});

test('an underline is a long, nearly level, straight stroke', function () {
  const under = underlineOf(handLine(100, 300, 420, 312, 2).points);
  assert.ok(under !== null, 'slightly tilted underline');
  assert.ok(Math.abs(under.x0 - 100) < 5 && Math.abs(under.x1 - 420) < 5 && Math.abs(under.y - 306) < 5);
  assert.ok(underlineOf(handLine(420, 300, 100, 300, 2).points) !== null, 'drawn right to left');
  assert.equal(underlineOf(handLine(100, 100, 100, 400, 2).points), null, 'a down stroke');
  assert.equal(underlineOf(handLine(0, 0, 200, 200, 2).points), null, 'a diagonal');
  assert.equal(underlineOf(handLine(0, 0, 40, 0, 1).points), null, 'too short, like a minus sign');
  assert.equal(underlineOf(handEllipse(200, 200, 100, 10, 1).points), null, 'a flat loop is not straight');
});

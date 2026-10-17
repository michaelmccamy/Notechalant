// Run with `npm test` from app/. Uses Node's built-in test runner, no extra packages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSample, createLineSplitter, parseRecording } from '../src/input/parseSample.js';
import { createMotion } from '../src/motion/index.js';

const recordingPath = new URL('../../data/recordings/synthetic/shapes.jsonl', import.meta.url);

test('parseSample accepts a valid line', function () {
  const sample = parseSample('{"t":10,"gx":1,"gy":2,"gz":3,"ax":0,"ay":0,"az":1,"pen":1}');
  assert.deepEqual(sample, { t: 10, gx: 1, gy: 2, gz: 3, ax: 0, ay: 0, az: 1, pen: 1 });
});

test('parseSample skips boot text, broken JSON, and missing fields', function () {
  assert.equal(parseSample('MPU6050 ready'), null);
  assert.equal(parseSample('{"t":10,"gx":1'), null);
  assert.equal(parseSample('{"t":10,"gx":1,"gy":2,"gz":3,"ax":0,"ay":0}'), null);
  assert.equal(parseSample(''), null);
});

test('line splitter handles lines split across chunks', function () {
  const received = [];
  const splitter = createLineSplitter(function (sample) {
    received.push(sample.t);
  });
  splitter.push('{"t":1,"gx":0,"gy":0,"gz":0,"ax":0,"ay":0,"az":1,"pen":0}\n{"t":2,"gx":0,');
  assert.deepEqual(received, [1]);
  splitter.push('"gy":0,"gz":0,"ax":0,"ay":0,"az":1,"pen":0}\nboot noise\n');
  assert.deepEqual(received, [1, 2]);
});

test('synthetic recording parses completely', function () {
  const text = readFileSync(recordingPath, 'utf8');
  const lineCount = text.trim().split('\n').length;
  const samples = parseRecording(text);
  assert.equal(samples.length, lineCount);
});

test('motion calibrates out the gyro bias and retraces the synthetic circle', function () {
  const samples = parseRecording(readFileSync(recordingPath, 'utf8'));
  // The generator maps x to gz and y to -gy, the old single axis setup, not the real pen's angle.
  const motion = createMotion({ xVector: [0, 0, 1], yVector: [0, -1, 0] });

  let x = 0;
  let y = 0;
  let firstPenDown = null;
  let lastPenDownOfFirstStroke = null;
  let strokeIndex = -1;
  let wasDown = false;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const move = motion.update(s);
    x += move.dx;
    y += move.dy;

    if (s.pen === 1 && !wasDown) {
      strokeIndex++;
      if (strokeIndex === 0) {
        firstPenDown = { x: x, y: y };
      }
    }
    if (s.pen === 1 && strokeIndex === 0) {
      lastPenDownOfFirstStroke = { x: x, y: y };
    }
    wasDown = s.pen === 1;
  }

  assert.equal(strokeIndex, 2, 'three strokes, circle then square then check');
  // The circle should start near the top point (-260, -110) and close on itself.
  assert.ok(Math.abs(firstPenDown.x - -260) < 25, 'circle start x ' + firstPenDown.x);
  assert.ok(Math.abs(firstPenDown.y - -110) < 25, 'circle start y ' + firstPenDown.y);
  const gap = Math.hypot(lastPenDownOfFirstStroke.x - firstPenDown.x, lastPenDownOfFirstStroke.y - firstPenDown.y);
  assert.ok(gap < 25, 'circle closes, gap ' + gap.toFixed(1));
});

// Tests debug recordings: settings lines when settings change, and that Load recording can
// replay the file as is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugRecorder, debugFileName } from '../src/debug/recorder.js';
import { parseRecording } from '../src/input/parseSample.js';

function sample(t, pen) {
  return { t: t, gx: 1, gy: -2, gz: 3, ax: 0, ay: 0, az: 1, pen: pen };
}

test('debug recording has samples with dx and dy, and a settings line per change', function () {
  const recorder = createDebugRecorder();
  const config = { pixelsPerDegree: 12, xVector: [0, 0, 1] };
  recorder.add(sample(0, 0), { dx: 1, dy: 1, ready: true }, config, null); // not recording yet

  recorder.start({ source: 'bluetooth', recordedAt: '2026-10-17T21:00:00.000Z' });
  recorder.add(sample(10, 0), { dx: 0, dy: 0, ready: false }, config, null);
  recorder.add(sample(20, 0), { dx: 0.123456, dy: -1, ready: true }, config, { gx: 0.1, gy: 0, gz: 0 });
  recorder.add(sample(30, 1), { dx: 2, dy: 0, ready: true }, config, { gx: 0.1, gy: 0, gz: 0 }, true);
  recorder.add(sample(40, 1), { dx: 4, dy: 0, ready: true }, Object.assign({}, config, { pixelsPerDegree: 24 }), { gx: 0.1, gy: 0, gz: 0 });
  assert.deepEqual(recorder.progress(), { samples: 4, seconds: 0.03 });

  const lines = recorder.stop().trim().split('\n').map(function (l) { return JSON.parse(l); });
  assert.equal(recorder.isRecording(), false);
  const settings = lines.filter(function (l) { return l.type === 'settings'; });
  assert.equal(settings.length, 3, 'start, bias found, sensitivity changed');
  assert.equal(settings[0].source, 'bluetooth');
  assert.equal(settings[0].recordedAt, '2026-10-17T21:00:00.000Z');
  assert.equal(settings[0].bias, null);
  assert.deepEqual(settings[1].bias, { gx: 0.1, gy: 0, gz: 0 });
  assert.equal(settings[2].config.pixelsPerDegree, 24);

  const samples = lines.filter(function (l) { return l.type === undefined; });
  assert.deepEqual(samples[1], { t: 20, gx: 1, gy: -2, gz: 3, ax: 0, ay: 0, az: 1, pen: 0, space: 0, dx: 0.1235, dy: -1, ready: true });
  assert.equal(samples[2].space, 1, 'Space held');
});

test('Load recording replays a debug file, skipping the settings lines', function () {
  const recorder = createDebugRecorder();
  recorder.start({ source: 'serial' });
  for (let i = 0; i < 5; i++) {
    recorder.add(sample(i * 10, 0), { dx: 0, dy: 0, ready: true }, { pixelsPerDegree: 12 + i }, null);
  }
  const replayed = parseRecording(recorder.stop());
  assert.equal(replayed.length, 5);
  assert.deepEqual(replayed[2], sample(20, 0));
});

test('debug file names sort by time and work on every OS', function () {
  assert.equal(debugFileName(new Date(2026, 9, 7, 9, 5, 3)), 'debug-2026-10-07T09-05-03.jsonl');
});

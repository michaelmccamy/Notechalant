// Replays debug recordings through the motion module and measures how steady the pen-down
// strokes come out, with Writing mode off and on.
//
//   node tools/stroke-straightness.mjs [recording.jsonl ...]
//
// With no files it uses every recording in data/recordings/debug/ that has the pen down. Each
// recording runs in pointer mode with the bias and motion settings it was recorded with. If the
// settings change to a new screen mapping partway, the recording starts with corner
// calibration, so that runs too, from the same taps. The ink is built the way
// inkCanvas.js builds it (points at least 1.5 px apart) on a 1200 x 750 page.
//
// Measures, per stroke. Writing mode draws smaller, so each one ignores size:
//   wiggle     total degrees of turning along the stroke, cut into 64 equal pieces so the size
//              and sample rate don't matter. A straight line is 0, a clean circle 360, and
//              shake adds a lot, since every little zigzag counts. Lower is steadier.
//   off line   distance from the best straight line through the stroke, RMS, as a share of
//              its length. Only for strokes that are meant to be lines (directness above 0.8).
//   directness start to end distance over path length. 1 is perfectly straight.

import { readFileSync, readdirSync } from 'node:fs';
import { createMotion } from '../app/src/motion/index.js';
import { lazyFollow, smoothStroke } from '../app/src/ink/writing.js';

const PAGE_W = 1200;
const PAGE_H = 750;
const MIN_POINT_DISTANCE = 1.5;
const RESAMPLE_PX = 2;
const WIGGLE_PIECES = 64;
const MIN_STROKE_PX = 15; // dots and taps aren't strokes

const dir = new URL('../data/recordings/debug/', import.meta.url);
const files = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => new URL(f, dir).pathname);

const VARIANTS = [
  { name: 'before (pointer mode)', writing: false, lazy: 0, smooth: false },
  { name: 'writing gain', writing: true, lazy: 0, smooth: false },
  { name: '+ lazy brush', writing: true, lazy: 4, smooth: false },
  { name: '+ curve fit (Writing mode)', writing: true, lazy: 4, smooth: true },
];

function load(file) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const settings = rows.find((r) => r.type === 'settings') || {};
  const samples = rows.filter((r) => typeof r.gx === 'number');
  const mappings = rows.filter((r) => r.type === 'settings').map((r) => JSON.stringify(r.config && r.config.screenMapping));
  const config = {};
  for (const [key, value] of Object.entries(settings.config || {})) {
    if (!key.startsWith('writing')) {
      config[key] = value;
    }
  }
  return { bias: settings.bias || null, samples: samples, config: config, calibrates: new Set(mappings).size > 1 };
}

function strokesFor(recording, variant) {
  const motion = createMotion(Object.assign({}, recording.config, { pointerMode: true, calibrationMs: 0, writingMode: variant.writing }));
  if (recording.calibrates) {
    motion.startScreenCalibration(function () {});
  }
  const bias = recording.bias || { gx: 0, gy: 0, gz: 0 };
  const strokes = [];
  let current = null;
  let brush = null;
  for (const raw of recording.samples) {
    const sample = Object.assign({}, raw, { gx: raw.gx - bias.gx, gy: raw.gy - bias.gy, gz: raw.gz - bias.gz });
    const penDown = raw.pen === 1 || raw.space === 1;
    const m = motion.update(sample, penDown);
    if (!m.ready || !m.absolute) {
      continue;
    }
    const cursor = { x: ((clamp(m.x) + 1) / 2) * PAGE_W, y: ((clamp(m.y) + 1) / 2) * PAGE_H };
    if (penDown && current === null) {
      current = [cursor];
      brush = cursor;
    } else if (!penDown && current !== null) {
      strokes.push(variant.smooth ? smoothStroke(current) : current);
      current = null;
    } else if (penDown) {
      brush = variant.lazy > 0 ? lazyFollow(brush, cursor, variant.lazy) : cursor;
      const last = current[current.length - 1];
      if (Math.hypot(brush.x - last.x, brush.y - last.y) >= MIN_POINT_DISTANCE) {
        current.push(brush);
      }
    }
  }
  if (current !== null) {
    strokes.push(variant.smooth ? smoothStroke(current) : current);
  }
  return strokes.filter((s) => pathLength(s) >= MIN_STROKE_PX);
}

function clamp(v) {
  return Math.max(-1, Math.min(1, v));
}

function pathLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

function resample(points, step) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    let d = step - carry;
    while (d <= segment) {
      const w = d / segment;
      out.push({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w });
      d += step;
    }
    carry = segment - (d - step);
  }
  return out;
}

function wiggle(points) {
  const r = resample(points, pathLength(points) / WIGGLE_PIECES);
  let turning = 0;
  for (let i = 2; i < r.length; i++) {
    const h1 = Math.atan2(r[i - 1].y - r[i - 2].y, r[i - 1].x - r[i - 2].x);
    const h2 = Math.atan2(r[i].y - r[i - 1].y, r[i].x - r[i - 1].x);
    if (Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y) < 1e-6 || Math.hypot(r[i - 1].x - r[i - 2].x, r[i - 1].y - r[i - 2].y) < 1e-6) {
      continue;
    }
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turning += Math.abs(d);
  }
  return (turning * 180) / Math.PI;
}

function directness(points) {
  const a = points[0];
  const b = points[points.length - 1];
  return Math.hypot(b.x - a.x, b.y - a.y) / pathLength(points);
}

// RMS distance from the total least squares line, over the stroke's length.
function offLine(points) {
  const r = resample(points, RESAMPLE_PX);
  const mx = r.reduce((s, p) => s + p.x, 0) / r.length;
  const my = r.reduce((s, p) => s + p.y, 0) / r.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of r) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  // The smaller eigenvalue of the scatter matrix is the summed squared distance from the line.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const small = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  return Math.sqrt(Math.max(0, small) / r.length) / pathLength(r);
}

function median(values) {
  if (values.length === 0) {
    return NaN;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(strokes) {
  const lines = strokes.filter((s) => directness(s) > 0.8);
  return {
    strokes: strokes.length,
    wiggle: median(strokes.map(wiggle)),
    offLine: median(lines.map(offLine)) * 100,
    lines: lines.length,
    directness: median(strokes.map(directness)),
    length: median(strokes.map(pathLength)),
  };
}

function row(name, s) {
  const pad = (v, n) => String(v).padStart(n);
  return (
    name.padEnd(28) +
    pad(s.strokes, 7) +
    pad(s.wiggle.toFixed(0) + '°', 10) +
    pad(Number.isNaN(s.offLine) ? '-' : s.offLine.toFixed(1) + '%', 10) +
    pad(s.directness.toFixed(2), 11) +
    pad(s.length.toFixed(0) + ' px', 10)
  );
}

const header = ''.padEnd(28) + 'strokes'.padStart(7) + 'wiggle'.padStart(10) + 'off line'.padStart(10) + 'directness'.padStart(11) + 'length'.padStart(10);
const totals = VARIANTS.map(() => []);
for (const file of files) {
  const recording = load(file);
  if (!recording.samples.some((s) => s.pen === 1 || s.space === 1)) {
    continue;
  }
  console.log('\n' + file.split('/').pop());
  console.log(header);
  VARIANTS.forEach(function (variant, i) {
    const strokes = strokesFor(recording, variant);
    totals[i].push(...strokes);
    console.log(row(variant.name, summarize(strokes)));
  });
}
console.log('\nAll recordings');
console.log(header);
VARIANTS.forEach((variant, i) => console.log(row(variant.name, summarize(totals[i]))));
console.log('\nwiggle: total degrees of turning along a stroke (lower is steadier). off line: RMS distance from the best line, as a share of length, for line-like strokes. Medians.');

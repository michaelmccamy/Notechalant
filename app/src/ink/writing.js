// Writing mode: three things that steady handwriting from an air pen. No DOM, so it runs under
// `npm test` and in tools/stroke-straightness.mjs.
//
//   precisionGain   slow turning moves the ink much less than fast turning, so the slow drift
//                   of a shaky hand mostly disappears while real strokes still draw. Writing on
//                   the real pen turns it 11 to 27 deg/s (median, debug recordings), so the
//                   full gain starts well below that: shrinking the slow parts of a letter more
//                   than the fast parts bends it out of shape (an e's loop came out squashed).
//                   motion/index.js applies it while the pen is down, to a smoothed speed.
//   lazyFollow      a lazy brush: the ink point hangs off the cursor on a string of length
//                   radius, and only moves when the cursor pulls the string tight. Wobble inside
//                   the string never reaches the ink. inkCanvas.js applies it while drawing.
//   smoothStroke    a light curve fit when the pen lifts: a gentle average, then drop points
//                   that sit on the line between their neighbors, then a Catmull-Rom curve back
//                   through what's left.

// Below the reference speed the gain falls off as (speed / mid) to the power curve, but never
// below this share of the full writing gain, so a slow, careful stroke still draws.
const MIN_PRECISION = 0.3;

// speedDps is how fast the pen turns, in degrees per second. Returns the multiplier on cursor
// movement: config.writingGain at or above config.writingMidDps, less below it.
export function precisionGain(speedDps, config) {
  const share = config.writingCurve <= 0 ? 1 : Math.pow(Math.max(0, speedDps) / config.writingMidDps, config.writingCurve);
  return config.writingGain * Math.max(MIN_PRECISION, Math.min(1, share));
}

// brush and target are { x, y }. Returns where the brush ends up: unchanged while the target is
// within radius of it, otherwise dragged along the line toward the target until it's radius away.
export function lazyFollow(brush, target, radius) {
  const dx = target.x - brush.x;
  const dy = target.y - brush.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius) {
    return brush;
  }
  const pull = (distance - radius) / distance;
  return { x: brush.x + dx * pull, y: brush.y + dy * pull };
}

// Points closer than this to the line through their neighbors are dropped before the curve fit.
const SIMPLIFY_TOLERANCE = 1;
// The curve is sampled about this often, in pixels.
const CURVE_STEP = 3;

// points: [{ x, y }]. Returns new points for the same stroke, smoothed. Short strokes and dots
// come back as they are. The first and last points never move.
export function smoothStroke(points) {
  if (points.length < 4) {
    return points;
  }
  const averaged = points.map(function (p, i) {
    if (i === 0 || i === points.length - 1) {
      return p;
    }
    const a = points[i - 1];
    const b = points[i + 1];
    return { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
  });
  return catmullRom(simplify(averaged, SIMPLIFY_TOLERANCE), CURVE_STEP);
}

// Ramer-Douglas-Peucker: keeps the points that matter for the shape.
export function simplify(points, tolerance) {
  if (points.length < 3) {
    return points.slice();
  }
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let worst = 0;
    let worstIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[i], points[start], points[end]);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > tolerance) {
      keep[worstIndex] = true;
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }
  return points.filter((p, i) => keep[i]);
}

// Centripetal Catmull-Rom through every point, so the curve can't overshoot into loops at
// sharp turns. The ends are padded by repeating the first and last points' direction.
export function catmullRom(points, step) {
  if (points.length < 3) {
    return points.slice();
  }
  const n = points.length;
  const first = { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y };
  const last = { x: 2 * points[n - 1].x - points[n - 2].x, y: 2 * points[n - 1].y - points[n - 2].y };
  const padded = [first, ...points, last];
  const out = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < padded.length - 2; i++) {
    const p0 = padded[i - 1];
    const p1 = padded[i];
    const p2 = padded[i + 1];
    const p3 = padded[i + 2];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(1, Math.ceil(length / step));
    for (let s = 1; s <= steps; s++) {
      out.push(centripetalPoint(p0, p1, p2, p3, s / steps));
    }
  }
  return out;
}

// Barry-Goldman form of centripetal Catmull-Rom (alpha 0.5), at u from 0 (p1) to 1 (p2).
function centripetalPoint(p0, p1, p2, p3, u) {
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const a1 = lerp(p0, p1, t0, t1, t);
  const a2 = lerp(p1, p2, t1, t2, t);
  const a3 = lerp(p2, p3, t2, t3, t);
  const b1 = lerp(a1, a2, t0, t2, t);
  const b2 = lerp(a2, a3, t1, t3, t);
  return lerp(b1, b2, t1, t2, t);
}

function knot(a, b) {
  // A tiny floor keeps repeated points from dividing by zero.
  return Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
}

function lerp(a, b, ta, tb, t) {
  const w = (t - ta) / (tb - ta);
  return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const w = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + w * dx), p.y - (a.y + w * dy));
}

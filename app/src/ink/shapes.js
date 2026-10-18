// Shape snapping: when the pen lifts, a stroke that's clearly a line, an ellipse, a rectangle, a
// triangle, or an arrow is redrawn as a clean one. Anything less certain (letters, open curves,
// scribbles) is left alone, since snapping a letter wrong is worse than a wobbly line. No DOM, so
// it runs under `npm test`.
//
// snapStroke(stroke) returns { shape, stroke } with the clean stroke, or null.
// snapHeld(stroke) is for hold to snap, where the pen is held still at the end of a stroke to ask
// for it: looser, and it also straightens strokes made of a few straight pieces (an L, a V, a Z).

import { simplify, findCorners } from './writing.js';

const MIN_SIZE = 30; // px, bounding box diagonal. Smaller strokes are letter parts and dots.
// Furthest point from the chord, as a share of the chord's length. Lines drawn with the air pen
// bow 4 to 9% (debug recording 23-32-18), and a c or a ( bows 15% and up.
const LINE_MAX_BOW = 0.1;
const LINE_MIN_DIRECTNESS = 0.9; // chord length over path length
const LEVEL_SNAP_DEG = 10; // lines this close to level or upright become exactly level or upright
const CLOSED_MAX_GAP = 0.25; // start to end distance, as a share of the box diagonal
const CLOSED_MIN_PATH = 1.8; // path length over box diagonal (a circle is 2.2, a square 2.8)
const ELLIPSE_MAX_ERROR = 0.1;
const RECT_MAX_ERROR = 0.06;
const ELLIPSE_POINTS = 48;
// Closed shapes are told apart by their corners: turns sharper than SHAPE_CORNER_DEG over
// SHAPE_CORNER_ARM of the shape's size. A box's corners still turn about 90 degrees when drawn
// round (an air pen box measured as close to an ellipse as to a rectangle), and a circle turns
// gently everywhere. Straight pieces are found by simplifying with POLY_TOLERANCE of the size,
// and every point must lie within POLY_MAX_ERROR of them.
const SHAPE_CORNER_ARM = 0.1;
const SHAPE_CORNER_DEG = 50;
// Straightening a letter needs sharper corners still: an L turns 90 degrees, a V or Z more, and a
// round S about 50 over the same distance.
const STRAIGHT_CORNER_DEG = 70;
const POLY_TOLERANCE = 0.08;
const POLY_MAX_ERROR = 0.05;
// Arrows: a shaft, then one or two short barbs at the tip, each at most this share of the shaft.
const ARROW_MAX_BARB = 0.45;
const ARROW_MIN_BARB = 0.08;
const ARROW_TOLERANCE = 0.04;

// Hold to snap asks for a shape, so it allows more than the automatic snap.
const LOOSE = { lineDirectness: 0.85, lineBow: 0.15, closedGap: 0.3, closedPath: 1.6, ellipse: 0.2, polyError: 0.09, rectError: 0.1 };
const STRICT = { lineDirectness: LINE_MIN_DIRECTNESS, lineBow: LINE_MAX_BOW, closedGap: CLOSED_MAX_GAP, closedPath: CLOSED_MIN_PATH, ellipse: ELLIPSE_MAX_ERROR, polyError: POLY_MAX_ERROR, rectError: RECT_MAX_ERROR };

export function snapStroke(stroke) {
  const points = stroke.points;
  if (points.length < 5) {
    return null;
  }
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  if (diagonal < MIN_SIZE) {
    return null;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  const path = pathLength(points);

  if (chord / path >= LINE_MIN_DIRECTNESS && maxBow(points, first, last) / chord <= LINE_MAX_BOW) {
    return { shape: 'line', stroke: withPoints(stroke, straightLine(first, last)) };
  }

  if (chord / diagonal > CLOSED_MAX_GAP || path / diagonal < CLOSED_MIN_PATH) {
    const arrow = arrowOf(points, STRICT);
    return arrow === null ? null : { shape: 'arrow', stroke: withPoints(stroke, arrow) };
  }
  const corners = closedCorners(points, diagonal);
  if (corners.length === 3) {
    const triangle = triangleOf(points, corners, diagonal, STRICT);
    if (triangle !== null) {
      return { shape: 'triangle', stroke: withPoints(stroke, triangle) };
    }
  }
  const ellipse = ellipseError(points, box);
  const rect = rectError(points, box);
  if (rect <= RECT_MAX_ERROR && rect < ellipse * 0.6) {
    return { shape: 'rectangle', stroke: withPoints(stroke, rectanglePoints(box)) };
  }
  if (ellipse <= ELLIPSE_MAX_ERROR) {
    return { shape: 'ellipse', stroke: withPoints(stroke, ellipsePoints(box)) };
  }
  return null;
}

// Hold to snap: the same shapes, looser, and otherwise a stroke made of two to six straight
// pieces comes back with each piece straight and its corners sharp. null if nothing fits, like
// a curvy letter.
export function snapHeld(stroke) {
  const points = stroke.points;
  if (points.length < 3) {
    return null;
  }
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  if (diagonal < 12) {
    return null;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  const path = pathLength(points);
  if (chord / path >= LOOSE.lineDirectness && maxBow(points, first, last) / chord <= LOOSE.lineBow) {
    return { shape: 'line', stroke: withPoints(stroke, straightLine(first, last)) };
  }
  if (chord / diagonal <= LOOSE.closedGap && path / diagonal >= LOOSE.closedPath) {
    const corners = closedCorners(points, diagonal);
    if (corners.length === 3) {
      const triangle = triangleOf(points, corners, diagonal, LOOSE);
      return triangle === null ? null : { shape: 'triangle', stroke: withPoints(stroke, triangle) };
    }
    if (corners.length === 4) {
      // Level and upright sides become the bounding box, anything else (a diamond) keeps its corners.
      return rectError(points, box) <= LOOSE.rectError
        ? { shape: 'rectangle', stroke: withPoints(stroke, rectanglePoints(box)) }
        : polyError(points, corners, true) <= LOOSE.polyError * diagonal
          ? { shape: 'quadrilateral', stroke: withPoints(stroke, sharpPolyline([...corners, corners[0]])) }
          : null;
    }
    // An oval can come out with a point at each end.
    if (corners.length <= 2 && ellipseError(points, box) <= LOOSE.ellipse) {
      return { shape: 'ellipse', stroke: withPoints(stroke, ellipsePoints(box)) };
    }
    return snapStroke(stroke);
  }
  const arrow = arrowOf(points, LOOSE);
  if (arrow !== null) {
    return { shape: 'arrow', stroke: withPoints(stroke, arrow) };
  }
  // Straight pieces only where the stroke really has sharp corners: an L or a Z, not an S, which
  // simplifies to a zigzag too but bends smoothly.
  const vertices = simplify(points, Math.max(3, POLY_TOLERANCE * diagonal));
  if (vertices.length >= 3 && vertices.length <= 7 && polyError(points, vertices, false) <= LOOSE.polyError * diagonal) {
    const arm = SHAPE_CORNER_ARM * diagonal;
    const sharp = findCorners(points, arm, STRAIGHT_CORNER_DEG).map((i) => points[i]);
    const inner = vertices.slice(1, -1);
    if (inner.every((v) => sharp.some((c) => Math.hypot(c.x - v.x, c.y - v.y) <= arm))) {
      return { shape: 'straight', stroke: withPoints(stroke, sharpPolyline(vertices)) };
    }
  }
  // Holding is never worse than lifting.
  return snapStroke(stroke);
}

// The corners of a closed stroke. The stroke is followed a little way past its end, back over its
// start, so a box that starts and ends at a corner has that corner found too.
function closedCorners(points, diagonal) {
  const arm = SHAPE_CORNER_ARM * diagonal;
  let wrap = 1;
  while (wrap < points.length && Math.hypot(points[wrap].x - points[0].x, points[wrap].y - points[0].y) < 2 * arm) {
    wrap++;
  }
  const loop = points.concat(points.slice(1, wrap + 1));
  const found = [];
  for (const i of findCorners(loop, arm, SHAPE_CORNER_DEG)) {
    const p = loop[i];
    if (found.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= arm)) {
      found.push(p);
    }
  }
  return found;
}

function triangleOf(points, corners, diagonal, limits) {
  // A thin sliver isn't a triangle.
  const [a, b, c] = corners;
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  if (area < 0.08 * diagonal * diagonal || polyError(points, corners, true) > limits.polyError * diagonal) {
    return null;
  }
  return sharpPolyline([a, b, c, a]);
}

// An arrow drawn in one stroke: a long shaft, then short barbs back from the tip, one each side.
function arrowOf(points, limits) {
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  // Finer than for polygons: barbs stick out less than a polygon's corners do.
  const vertices = simplify(points, Math.max(3, ARROW_TOLERANCE * diagonal));
  if (vertices.length < 3 || vertices.length > 5 || polyError(points, vertices, false) > limits.polyError * diagonal) {
    return null;
  }
  const tail = vertices[0];
  const tip = vertices[1];
  const shaft = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  if (shaft < 40) {
    return null;
  }
  // Every later vertex stays near the tip, and points back towards the tail.
  const back = { x: (tail.x - tip.x) / shaft, y: (tail.y - tip.y) / shaft };
  for (const v of vertices.slice(2)) {
    const d = Math.hypot(v.x - tip.x, v.y - tip.y);
    const along = ((v.x - tip.x) * back.x + (v.y - tip.y) * back.y) / Math.max(d, 1e-9);
    if (d > ARROW_MAX_BARB * shaft || (d > ARROW_MIN_BARB * shaft && along < 0.3)) {
      return null;
    }
  }
  // Barbs on both sides of the shaft. One alone is more often a hook from lifting the pen.
  const sides = vertices.slice(2).filter((v) => Math.hypot(v.x - tip.x, v.y - tip.y) >= ARROW_MIN_BARB * shaft).map((v) => Math.sign((tip.x - tail.x) * (v.y - tail.y) - (tip.y - tail.y) * (v.x - tail.x)));
  if (!sides.includes(1) || !sides.includes(-1)) {
    return null;
  }
  // A clean head: two barbs 30 degrees either side of the shaft, a fifth of its length.
  const barb = Math.min(40, Math.max(12, 0.2 * shaft));
  const angle = Math.atan2(back.y, back.x);
  const side = (turn) => ({ x: tip.x + barb * Math.cos(angle + turn), y: tip.y + barb * Math.sin(angle + turn) });
  return sharpPolyline([tail, tip, side(Math.PI / 6), tip, side(-Math.PI / 6)]);
}

// Furthest any point is from the polyline through vertices (closed joins the last to the first).
function polyError(points, vertices, closed) {
  const segments = [];
  for (let i = 1; i < vertices.length; i++) segments.push([vertices[i - 1], vertices[i]]);
  if (closed) segments.push([vertices[vertices.length - 1], vertices[0]]);
  let worst = 0;
  for (const p of points) {
    let near = Infinity;
    for (const [a, b] of segments) near = Math.min(near, segmentDistance(p, a, b));
    worst = Math.max(worst, near);
  }
  return worst;
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

// Straight pieces between vertices. Inner vertices are doubled, so the curve drawing in
// inkCanvas.js keeps them sharp (as rectanglePoints does).
function sharpPolyline(vertices) {
  const out = [{ x: vertices[0].x, y: vertices[0].y }];
  for (let i = 1; i < vertices.length; i++) {
    const v = { x: vertices[i].x, y: vertices[i].y };
    out.push(v);
    if (i < vertices.length - 1) out.push({ x: v.x, y: v.y });
  }
  return out;
}

// Circle to ask: any loop around something counts, so this is looser than the ellipse and
// rectangle checks. A circled area is at least LOOP_MIN_SIZE across, so a written o or 0
// doesn't ask.
const LOOP_MIN_SIZE = 60;
// More strokes than this at once is writing, even if each one is straight (an E, a box of lines).
const MAX_MARKS = 2;

export function isClosedLoop(points) {
  if (points.length < 8) {
    return false;
  }
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);
  if (Math.min(box.width, box.height) < LOOP_MIN_SIZE) {
    return false;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  return gap / diagonal <= CLOSED_MAX_GAP && pathLength(points) / diagonal >= CLOSED_MIN_PATH;
}

// True if every stroke is a mark rather than writing: a straight line (an underline, a
// strikethrough, a pointer line) or a loop around something. Transcription skips these, so an
// underline doesn't go off to be read. Letters are rarely a lone straight line, and an I or a 1
// on its own is the one thing this gets wrong.
export function isJustMarks(strokes) {
  if (strokes.length === 0 || strokes.length > MAX_MARKS) {
    return false;
  }
  return strokes.every(function (stroke) {
    const points = stroke.points;
    if (!points || points.length < 2) {
      return false;
    }
    const first = points[0];
    const last = points[points.length - 1];
    const chord = Math.hypot(last.x - first.x, last.y - first.y);
    const straight = chord >= MIN_SIZE && chord / pathLength(points) >= LINE_MIN_DIRECTNESS && maxBow(points, first, last) / chord <= LINE_MAX_BOW;
    return straight || isClosedLoop(points);
  });
}

// Circle to ask also takes an underline: a straight stroke within UNDERLINE_MAX_DEG of level
// and at least UNDERLINE_MIN_LENGTH long. Returns { x0, x1, y }, or null.
const UNDERLINE_MAX_DEG = 20;
const UNDERLINE_MIN_LENGTH = 60;

export function underlineOf(points) {
  if (points.length < 2) {
    return null;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  if (chord < UNDERLINE_MIN_LENGTH || chord / pathLength(points) < LINE_MIN_DIRECTNESS || maxBow(points, first, last) / chord > LINE_MAX_BOW) {
    return null;
  }
  const tilt = (Math.abs(Math.atan2(last.y - first.y, Math.abs(last.x - first.x))) * 180) / Math.PI;
  if (tilt > UNDERLINE_MAX_DEG) {
    return null;
  }
  return { x0: Math.min(first.x, last.x), x1: Math.max(first.x, last.x), y: (first.y + last.y) / 2 };
}

export function strokeBox(points) {
  return bounds(points);
}

function withPoints(stroke, points) {
  return { color: stroke.color, width: stroke.width, points: points };
}

function bounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function pathLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

function maxBow(points, a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  let worst = 0;
  for (const p of points) {
    worst = Math.max(worst, Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length);
  }
  return worst;
}

// Keeps the middle and the length. Close to level or upright becomes exactly so.
function straightLine(a, b) {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const half = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  const quarter = Math.PI / 2;
  const nearest = Math.round(angle / quarter) * quarter;
  if (Math.abs(angle - nearest) <= (LEVEL_SNAP_DEG * Math.PI) / 180) {
    angle = nearest;
  }
  const dx = Math.cos(angle) * half;
  const dy = Math.sin(angle) * half;
  return [
    { x: mid.x - dx, y: mid.y - dy },
    { x: mid.x + dx, y: mid.y + dy },
  ];
}

// Average distance of the points from the box's inscribed ellipse, 0 for a perfect one.
function ellipseError(points, box) {
  const cx = box.minX + box.width / 2;
  const cy = box.minY + box.height / 2;
  const rx = Math.max(box.width / 2, 1);
  const ry = Math.max(box.height / 2, 1);
  let sum = 0;
  for (const p of points) {
    sum += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
  }
  return sum / points.length;
}

// Average distance of the points from the box's nearest edge, as a share of the box size.
function rectError(points, box) {
  const w = Math.max(box.width, 1);
  const h = Math.max(box.height, 1);
  let sum = 0;
  for (const p of points) {
    const toSide = Math.min(Math.abs(p.x - box.minX), Math.abs(p.x - box.maxX)) / w;
    const toTopOrBottom = Math.min(Math.abs(p.y - box.minY), Math.abs(p.y - box.maxY)) / h;
    sum += Math.min(toSide, toTopOrBottom);
  }
  return sum / points.length;
}

function ellipsePoints(box) {
  const cx = box.minX + box.width / 2;
  const cy = box.minY + box.height / 2;
  const points = [];
  for (let i = 0; i <= ELLIPSE_POINTS; i++) {
    const a = (i / ELLIPSE_POINTS) * Math.PI * 2;
    points.push({ x: cx + Math.cos(a) * (box.width / 2), y: cy + Math.sin(a) * (box.height / 2) });
  }
  return points;
}

// Each corner is doubled. Strokes are drawn as curves through midpoints (drawStroke in
// inkCanvas.js), and a doubled point keeps the corner sharp instead of rounding it off.
function rectanglePoints(box) {
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  const points = [corners[0]];
  for (let i = 1; i <= 4; i++) {
    const corner = corners[i % 4];
    points.push({ x: corner.x, y: corner.y }, { x: corner.x, y: corner.y });
  }
  return points;
}

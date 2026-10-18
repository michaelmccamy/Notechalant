// Shape snapping: when the pen lifts, a stroke that's clearly a line, an ellipse, or a rectangle
// is redrawn as a clean one. Anything less certain (letters, open curves, scribbles) is left
// alone, since snapping a letter wrong is worse than a wobbly line. No DOM, so it runs under
// `npm test`.
//
// snapStroke(stroke) returns { shape, stroke } with the clean stroke, or null.

const MIN_SIZE = 30; // px, bounding box diagonal. Smaller strokes are letter parts and dots.
const LINE_MAX_BOW = 0.08; // furthest point from the chord, as a share of the chord's length
const LINE_MIN_DIRECTNESS = 0.9; // chord length over path length
const LEVEL_SNAP_DEG = 10; // lines this close to level or upright become exactly level or upright
const CLOSED_MAX_GAP = 0.25; // start to end distance, as a share of the box diagonal
const CLOSED_MIN_PATH = 1.8; // path length over box diagonal (a circle is 2.2, a square 2.8)
const ELLIPSE_MAX_ERROR = 0.1;
const RECT_MAX_ERROR = 0.06;
const ELLIPSE_POINTS = 48;

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
    return null;
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

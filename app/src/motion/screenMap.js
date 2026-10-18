// Corner calibration for pointer mode. The user points at the page's four corners; this maps
// pointing angles onto the page from those four readings.
//
// Pointing angles become flat-plane coordinates first (gnomonic: u = tan(right), v =
// tan(up) / cos(right)). Seen from where the user stands, a flat screen is then exactly a
// perspective view of that plane, so a homography through the four corners maps any pointing
// direction to the spot on the screen it hits, whatever the distance, offset, or viewing angle.
// No DOM, so it runs under `npm test`.

// Page coordinates of the corners, in the order the user points at them: top left, top
// right, bottom right, bottom left. x and y go from -1 to 1, y down.
export const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const DEG = Math.PI / 180;

// rightDeg is degrees right of some reference, upDeg degrees above level.
export function toPlane(rightDeg, upDeg) {
  const a = rightDeg * DEG;
  return [Math.tan(a), Math.tan(upDeg * DEG) / Math.cos(a)];
}

export function fromPlane(u, v) {
  const a = Math.atan(u);
  return [a / DEG, Math.atan(v * Math.cos(a)) / DEG];
}

// The 3x3 homography (row major, 9 numbers) taking each src point to its dst point, or null
// if the four points are degenerate (three in a line, or two the same).
export function computeHomography(src, dst) {
  // h33 = 1, solve the 8 others: two equations per point pair.
  const rows = [];
  const rhs = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    rhs.push(X);
    rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    rhs.push(Y);
  }
  const h = solve(rows, rhs);
  return h === null ? null : [...h, 1];
}

export function applyHomography(h, point) {
  const [x, y] = point;
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function invertHomography(h) {
  const [a, b, c, d, e, f, g, k, l] = h;
  const det = a * (e * l - f * k) - b * (d * l - f * g) + c * (d * k - e * g);
  if (Math.abs(det) < 1e-12) {
    return null;
  }
  return [
    (e * l - f * k) / det,
    (c * k - b * l) / det,
    (b * f - c * e) / det,
    (f * g - d * l) / det,
    (a * l - c * g) / det,
    (c * d - a * f) / det,
    (d * k - e * g) / det,
    (b * g - a * k) / det,
    (a * e - b * d) / det,
  ];
}

// The corners the user pointed at ([rightDeg, upDeg] each, in CORNERS order) as a mapping, or
// null with a reason if they can't make one: too close together, or not in the right order.
export function mappingFromCorners(cornerAngles) {
  const plane = cornerAngles.map(([right, up]) => toPlane(right, up));
  // The pointed-at corners must go round the same way as the page's (top left, top right,
  // bottom right, bottom left) without crossing, or the mapping would fold over.
  if (!turnsClockwise(plane)) {
    return { mapping: null, reason: 'The corners came out in the wrong order or on top of each other. Try again' };
  }
  const widthDeg = Math.abs(cornerAngles[1][0] - cornerAngles[0][0]);
  const heightDeg = Math.abs(cornerAngles[0][1] - cornerAngles[3][1]);
  if (widthDeg < 4 || heightDeg < 3) {
    return { mapping: null, reason: 'The corners are too close together. Point right at each corner of the page' };
  }
  const h = computeHomography(plane, CORNERS);
  if (h === null) {
    return { mapping: null, reason: "Couldn't make sense of those corners. Try again" };
  }
  return { mapping: h, reason: '' };
}

// True if every corner turns clockwise (in the plane, where up is positive), which is how top
// left, top right, bottom right, bottom left go round. A swapped pair makes a figure eight, with
// corners turning both ways.
function turnsClockwise(points) {
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const [cx, cy] = points[(i + 2) % points.length];
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) >= 0) {
      return false;
    }
  }
  return true;
}

// Gaussian elimination with partial pivoting. Returns null for a singular system.
function solve(rows, rhs) {
  const n = rhs.length;
  const m = rows.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      return null;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const factor = m[r][col] / m[col][col];
        for (let c = col; c <= n; c++) {
          m[r][c] -= factor * m[col][c];
        }
      }
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

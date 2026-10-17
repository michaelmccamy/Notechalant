// Generates a fake pen recording that traces known shapes, so the app and motion code
// can be tested before real recordings exist.
//
//   node tools/make-synthetic.mjs > data/recordings/synthetic/shapes.jsonl
//
// It works backwards from a path in screen pixels to the gyro rates that would draw it,
// using the same mapping as the placeholder motion module (x from gz, y from -gy,
// 12 pixels per degree). Then it adds a constant gyro bias and random noise, like a real sensor.

const SAMPLE_MS = 10; // 100 Hz
const PIXELS_PER_DEGREE = 12;
const BIAS = { gx: 0.3, gy: -0.4, gz: 0.6 }; // degrees per second, what calibration should remove
const NOISE = 0.8; // standard deviation in degrees per second, what filtering should smooth
const DRAW_SPEED = 400; // pixels per second while writing
const TRAVEL_SPEED = 700; // pixels per second with the pen up

// Seeded random numbers so the file is the same every run.
let seed = 12345;
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function gaussian() {
  const u = Math.max(random(), 1e-9);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A plan is a list of steps. Each step either holds still or moves through points.
// Points are pixels relative to where the cursor starts (the center of the canvas).
const plan = [];

function hold(seconds) {
  plan.push({ type: 'hold', seconds: seconds });
}

function path(points, pen) {
  plan.push({ type: 'path', points: points, pen: pen });
}

function circlePoints(cx, cy, r, steps) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

hold(2.0); // calibration window
path([{ x: 0, y: 0 }, { x: -260, y: -110 }], 0);
path(circlePoints(-260, 0, 110, 60), 1);
hold(0.3);
path([{ x: -260, y: -110 }, { x: -60, y: -100 }], 0);
path(
  [
    { x: -60, y: -100 },
    { x: 140, y: -100 },
    { x: 140, y: 100 },
    { x: -60, y: 100 },
    { x: -60, y: -100 },
  ],
  1,
);
hold(0.3);
path([{ x: -60, y: -100 }, { x: 220, y: 0 }], 0);
path(
  [
    { x: 220, y: 0 },
    { x: 270, y: 60 },
    { x: 380, y: -100 },
  ],
  1,
);
hold(0.5);

let t = 1532; // pretend the board booted a second and a half ago
const lines = [];

function emit(vx, vy, pen) {
  // Screen velocity in pixels per second to gyro rate in degrees per second.
  const gz = vx / PIXELS_PER_DEGREE;
  const gy = -vy / PIXELS_PER_DEGREE;
  const sample = {
    t: t,
    gx: round(BIAS.gx + NOISE * gaussian()),
    gy: round(gy + BIAS.gy + NOISE * gaussian()),
    gz: round(gz + BIAS.gz + NOISE * gaussian()),
    ax: round(0.01 * gaussian()),
    ay: round(0.01 * gaussian()),
    az: round(1 + 0.01 * gaussian()),
    pen: pen,
  };
  lines.push(JSON.stringify(sample));
  t += SAMPLE_MS;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

for (let s = 0; s < plan.length; s++) {
  const step = plan[s];
  if (step.type === 'hold') {
    const count = Math.round((step.seconds * 1000) / SAMPLE_MS);
    for (let i = 0; i < count; i++) {
      emit(0, 0, 0);
    }
    continue;
  }

  const speed = step.pen === 1 ? DRAW_SPEED : TRAVEL_SPEED;
  for (let p = 1; p < step.points.length; p++) {
    const a = step.points[p - 1];
    const b = step.points[p];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const count = Math.max(1, Math.round((distance / speed) * (1000 / SAMPLE_MS)));
    const seconds = (count * SAMPLE_MS) / 1000;
    for (let i = 0; i < count; i++) {
      emit(dx / seconds, dy / seconds, step.pen);
    }
  }
}

process.stdout.write(lines.join('\n') + '\n');

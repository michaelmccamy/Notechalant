// Builds data/samples/demo-slides.pdf: four 16:9 slides for testing Circle to ask and for the
// pitch. Big, high-contrast text with space around each item so it's easy to circle.
//
//   node tools/make-demo-slides.mjs
//
// Uses pdf-lib from the app's packages (run `npm install` in app/ first). The chart is drawn
// as vector shapes, so it stays sharp at any size.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OUT = new URL('../data/samples/demo-slides.pdf', import.meta.url);

// 16:9 at 960 x 540 points (13.33 x 7.5 in, the usual slide size).
const W = 960;
const H = 540;
const MARGIN = 64;

// Colors from the app's design.
const INK = rgb(0.114, 0.149, 0.125); // #1d2620
const MUTED = rgb(0.337, 0.38, 0.353); // #56615a
const ACCENT = rgb(0.18, 0.42, 0.31); // #2e6b4f
const TINT = rgb(0.886, 0.929, 0.898); // #e2ede5
const PAPER = rgb(1, 0.996, 0.98); // #fffefa
const RULE = rgb(0.827, 0.855, 0.808); // #d3dace

const doc = await PDFDocument.create();
doc.setTitle('Notechalant demo slides');
doc.setAuthor('Notechalant');
const regular = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

function newSlide(title, number) {
  const page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: PAPER });
  page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: ACCENT });
  if (title) {
    page.drawText(title, { x: MARGIN, y: H - 92, size: 40, font: bold, color: INK });
  }
  page.drawText(String(number), { x: W - MARGIN, y: 28, size: 14, font: regular, color: MUTED });
  return page;
}

// Text centered on x. pdf-lib's standard fonts use WinAnsi, so ² is fine but use - for minus.
function centered(page, text, x, y, size, font, color) {
  page.drawText(text, { x: x - font.widthOfTextAtSize(text, size) / 2, y: y, size: size, font: font, color: color || INK });
}

function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

// 1. Title
{
  const page = newSlide(null, 1);
  centered(page, 'Notechalant:', W / 2, 310, 72, bold, ACCENT);
  centered(page, 'circle to ask, on any screen', W / 2, 230, 44, bold, INK);
  centered(page, 'Write on any screen from across the room. Circle anything to get it explained.', W / 2, 150, 20, regular, MUTED);
  centered(page, 'SwampHacks XII', W / 2, 70, 18, regular, MUTED);
}

// 2. Math: two problems, each in its own box with room around it.
{
  const page = newSlide('Two problems', 2);
  const boxes = [
    { label: 'Solve for x', math: 'x² - 5x + 6 = 0', y: 260 },
    { label: 'Find the derivative', math: 'd/dx (3x² + 2x)', y: 90 },
  ];
  for (const box of boxes) {
    page.drawRectangle({ x: 150, y: box.y, width: W - 300, height: 130, color: TINT, borderColor: RULE, borderWidth: 1 });
    page.drawText(box.label, { x: 180, y: box.y + 96, size: 18, font: regular, color: MUTED });
    centered(page, box.math, W / 2, box.y + 32, 52, bold, INK);
  }
}

// 3. Chart: study hours against exam score, a clear upward trend.
{
  const page = newSlide('More study, higher scores', 3);
  const data = [
    ['0', 52],
    ['2', 61],
    ['4', 70],
    ['6', 78],
    ['8', 86],
    ['10', 92],
  ];
  const left = 190;
  const bottom = 90;
  const width = 600;
  const height = 300;
  const maxScore = 100;
  // Gridlines and score labels.
  for (let s = 0; s <= maxScore; s += 25) {
    const y = bottom + (s / maxScore) * height;
    page.drawLine({ start: { x: left, y: y }, end: { x: left + width, y: y }, thickness: s === 0 ? 2 : 1, color: s === 0 ? INK : RULE });
    const label = String(s);
    page.drawText(label, { x: left - 14 - regular.widthOfTextAtSize(label, 16), y: y - 6, size: 16, font: regular, color: MUTED });
  }
  const slot = width / data.length;
  data.forEach(function ([hours, score], i) {
    const barWidth = slot * 0.56;
    const x = left + slot * i + (slot - barWidth) / 2;
    const barHeight = (score / maxScore) * height;
    page.drawRectangle({ x: x, y: bottom, width: barWidth, height: barHeight, color: ACCENT });
    centered(page, String(score), x + barWidth / 2, bottom + barHeight + 8, 16, bold, INK);
    centered(page, hours, x + barWidth / 2, bottom - 26, 16, regular, MUTED);
  });
  centered(page, 'Hours studied per week', left + width / 2, bottom - 56, 18, regular, MUTED);
  page.drawText('Exam score', { x: 60, y: bottom + height / 2, size: 18, font: regular, color: MUTED, rotate: { type: 'degrees', angle: 90 } });
}

// 4. Text: one dense paragraph that's easy to get lost in.
{
  const page = newSlide('What Big O notation means', 4);
  const paragraph =
    'Big O notation describes how an algorithm\'s running time or memory grows as its input size n grows, ' +
    'keeping only the fastest-growing term and dropping constant factors, so an algorithm that takes ' +
    '3n² + 5n + 2 steps is O(n²), because for large n the n² term dominates; it is an upper bound on ' +
    'growth, not an exact count of steps, which is why a slower-looking O(n log n) sort beats an O(n²) ' +
    'one on large inputs even if the O(n²) sort is faster on small ones.';
  const size = 26;
  const lines = wrap(paragraph, regular, size, W - MARGIN * 2 - 60);
  let y = H - 160;
  for (const line of lines) {
    page.drawText(line, { x: MARGIN + 30, y: y, size: size, font: regular, color: INK, lineHeight: size * 1.4 });
    y -= size * 1.45;
  }
}

mkdirSync(new URL('../data/samples/', import.meta.url), { recursive: true });
writeFileSync(OUT, await doc.save());
console.log('Wrote', OUT.pathname);

// Pure helpers for opening files. No DOM or file system in here, so it all runs under `npm test`.

import { isText, scaleItems } from '../ink/inkItems.js';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
// Old binary Office formats and other suites. No browser renderer reads these.
const OTHER_OFFICE_EXTENSIONS = ['doc', 'ppt', 'xls', 'odt', 'odp', 'ods', 'pages', 'key', 'numbers', 'rtf'];

// Everything the Open File picker offers.
export const OPENABLE_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', ...IMAGE_EXTENSIONS];

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// 'image', 'pdf', 'docx', 'xlsx', 'pptx', 'office' (formats we can't show), or 'other'.
// 'other' gets opened as text if it looks like text.
export function kindOf(name) {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (ext === 'pdf' || ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext;
  if (OTHER_OFFICE_EXTENSIONS.includes(ext)) return 'office';
  return 'other';
}

// Where to start each page when laying tall content (a Word section, a spreadsheet) onto
// fixed-height pages. `blocks` are the pieces that shouldn't be cut ({ top, bottom }, sorted by
// top), such as paragraphs and table rows. Each page holds `available` units of content
// starting at its start. A block that doesn't fit moves to the next page whole, and only a block
// taller than a page gets cut. Returns the start of every page, the first being `firstTop`.
export function pageBreaks(blocks, firstTop, available) {
  const starts = [firstTop];
  let start = firstTop;
  let limit = firstTop + available;
  for (const block of blocks) {
    while (block.bottom > limit + 0.5) {
      start = block.top > start ? block.top : limit;
      limit = start + available;
      starts.push(start);
    }
  }
  return starts;
}

// A NUL character in the first few KB means binary. Text files essentially never have one.
export function looksLikeText(sample) {
  return !sample.includes('\u0000');
}

// Wraps text to a fixed column count so every page holds the same number of lines. Breaks at
// the last space that fits, and mid-word only when there isn't one (long URLs, minified code).
// Tabs become 4 spaces so wrapping matches what's drawn.
export function wrapLines(text, columns) {
  const out = [];
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length === 0) {
      out.push('');
      continue;
    }
    while (line.length > columns) {
      const space = line.lastIndexOf(' ', columns);
      const cut = space > 0 ? space + 1 : columns;
      out.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut);
    }
    out.push(line);
  }
  // A trailing newline shouldn't create an extra blank page.
  while (out.length > 1 && out[out.length - 1] === '') {
    out.pop();
  }
  return out;
}

export function paginate(lines, linesPerPage) {
  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  return pages.length === 0 ? [[]] : pages;
}

// Where a file's ink is saved, inside the hidden .notechalant folder. The whole relative path
// is encoded into one file name, so two files called notes.txt in different folders don't collide.
export function inkFileName(path) {
  return encodeURIComponent(path) + '.json';
}

// Ink on disk: { version, file, pages: { "0": [stroke, ...] } } with points as [x, y] pairs
// rounded to one decimal, in page units. About a third the size of { x, y } objects.
export function packInk(path, pages) {
  const packed = {};
  for (const index of Object.keys(pages)) {
    if (pages[index].length === 0) continue;
    packed[index] = pages[index].map(packItem);
  }
  return { version: 1, file: path, pages: packed };
}

// Text items from clean up (ink/inkItems.js) keep the handwriting they replaced.
function packItem(item) {
  if (isText(item)) {
    return {
      type: 'text',
      text: item.text,
      color: item.color,
      box: [round(item.box.x), round(item.box.y), round(item.box.width), round(item.box.height)],
      strokes: item.strokes.map(packItem),
    };
  }
  return {
    color: item.color,
    width: round(item.width),
    points: item.points.map(function (p) {
      return [round(p.x), round(p.y)];
    }),
  };
}

// Anything malformed is skipped instead of breaking the file open.
export function unpackInk(data) {
  const pages = {};
  if (!data || typeof data.pages !== 'object' || data.pages === null) {
    return pages;
  }
  for (const index of Object.keys(data.pages)) {
    const items = data.pages[index];
    if (!Array.isArray(items)) continue;
    pages[index] = items.map(unpackItem).filter(function (item) {
      return item !== null;
    });
  }
  return pages;
}

function unpackItem(s) {
  if (!s || typeof s !== 'object') {
    return null;
  }
  if (s.type === 'text') {
    const strokes = Array.isArray(s.strokes) ? s.strokes.map(unpackItem).filter((x) => x !== null && !isText(x)) : [];
    if (typeof s.text !== 'string' || !Array.isArray(s.box) || s.box.length !== 4 || strokes.length === 0) {
      return null;
    }
    return {
      type: 'text',
      text: s.text,
      color: typeof s.color === 'string' ? s.color : '#1c1c1a',
      box: { x: Number(s.box[0]), y: Number(s.box[1]), width: Number(s.box[2]), height: Number(s.box[3]) },
      strokes: strokes,
    };
  }
  if (!Array.isArray(s.points) || s.points.length === 0) {
    return null;
  }
  return {
    color: typeof s.color === 'string' ? s.color : '#1c1c1a',
    width: Number(s.width) || 4,
    points: s.points.map(function (p) {
      return { x: Number(p[0]), y: Number(p[1]) };
    }),
  };
}

// Converts ink between page units (saved) and screen pixels (drawn) by a scale factor.
export function scaleStrokes(items, factor) {
  return scaleItems(items, factor);
}

// PDF sizes are in points (1/72 inch). Page units are CSS pixels (1/96 inch), so a letter
// page comes out 816 x 1056, the same as a text page.
export const PDF_POINTS_TO_PAGE_UNITS = 96 / 72;

// How many canvas pixels per page unit to render a PDF page at. Sharp at the shown size on
// high-DPI screens, never below 1, and capped so a poster-sized page can't eat all the memory.
export function renderResolution(pageWidth, pageHeight, shownScale, devicePixelRatio, maxPixels) {
  const wanted = Math.max(1, shownScale) * (devicePixelRatio || 1);
  const cap = Math.sqrt(maxPixels / (pageWidth * pageHeight));
  return Math.min(wanted, cap);
}

// Fits a page inside the available area with a margin, centered. Small pages are scaled up
// (to a limit) so there's room to write on them.
export function fitPage(pageWidth, pageHeight, areaWidth, areaHeight, margin, maxScale) {
  const scale = Math.max(
    0.01,
    Math.min((areaWidth - margin * 2) / pageWidth, (areaHeight - margin * 2) / pageHeight, maxScale),
  );
  const width = pageWidth * scale;
  const height = pageHeight * scale;
  return { scale: scale, width: width, height: height, left: (areaWidth - width) / 2, top: (areaHeight - height) / 2 };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

// ---- Saving a copy with the ink on it ----

// What a saved copy is written as. A PDF stays a PDF with the ink added as vector strokes.
// Images stay images (SVG and the rarer formats become PNG). Everything else that has pages
// (Word, Excel, PowerPoint, text) becomes a PDF of the pages as shown, since there's no way to
// put handwriting back into those formats where it was written.
export function copyFormat(name) {
  const kind = kindOf(name);
  const ext = extensionOf(name);
  if (kind === 'image') {
    if (ext === 'jpg' || ext === 'jpeg') return { extension: ext, mime: 'image/jpeg' };
    if (ext === 'webp') return { extension: 'webp', mime: 'image/webp' };
    return { extension: 'png', mime: 'image/png' };
  }
  return { extension: 'pdf', mime: 'application/pdf' };
}

// "report.docx" saved as a PDF becomes "report-annotated.pdf", or "report-annotated-2.pdf"
// and so on if that's taken. `taken(name)` says whether a name is already used. Never returns
// the original name, so a copy can't replace the file it came from.
export function copyName(name, extension, taken) {
  const dot = name.lastIndexOf('.');
  const base = dot <= 0 ? name : name.slice(0, dot);
  for (let n = 1; ; n++) {
    const candidate = base + (n === 1 ? '-annotated' : '-annotated-' + n) + '.' + extension;
    if (candidate !== name && !taken(candidate)) {
      return candidate;
    }
  }
}

// The transform PDF.js uses to show a page (its PageViewport), from PDF user space to page
// units. `view` is the visible box [x1, y1, x2, y2] in points and `rotation` the page's /Rotate.
// Returned as [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f.
export function pdfViewTransform(view, rotation, scale) {
  const centerX = (view[2] + view[0]) / 2;
  const centerY = (view[3] + view[1]) / 2;
  let a, b, c, d;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  const offsetX = (a === 0 ? Math.abs(centerY - view[1]) : Math.abs(centerX - view[0])) * scale;
  const offsetY = (a === 0 ? Math.abs(centerX - view[0]) : Math.abs(centerY - view[1])) * scale;
  return [
    a * scale,
    b * scale,
    c * scale,
    d * scale,
    offsetX - a * scale * centerX - c * scale * centerY,
    offsetY - b * scale * centerX - d * scale * centerY,
  ];
}

// Maps a point back through a pdfViewTransform: page units to PDF user space.
export function invertPoint(m, x, y) {
  const det = m[0] * m[3] - m[1] * m[2];
  const dx = x - m[4];
  const dy = y - m[5];
  return { x: (m[3] * dx - m[2] * dy) / det, y: (m[0] * dy - m[1] * dx) / det };
}

// A stroke's outline the way the canvas draws it (drawStroke in inkCanvas.js): quadratic curves
// through the midpoints between points, ending in a straight line. The quadratics become cubics,
// since PDF only has cubic curves. Returns [{ op: 'move' | 'line' | 'curve', points }].
export function strokePath(points) {
  const path = [{ op: 'move', points: [points[0]] }];
  if (points.length === 1) {
    // A zero-length line with round caps draws as a dot.
    path.push({ op: 'line', points: [points[0]] });
    return path;
  }
  let from = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const control = points[i];
    const to = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    path.push({
      op: 'curve',
      points: [
        { x: from.x + ((control.x - from.x) * 2) / 3, y: from.y + ((control.y - from.y) * 2) / 3 },
        { x: to.x + ((control.x - to.x) * 2) / 3, y: to.y + ((control.y - to.y) * 2) / 3 },
        to,
      ],
    });
    from = to;
  }
  path.push({ op: 'line', points: [points[points.length - 1]] });
  return path;
}

// '#2f6fed' to { r, g, b } between 0 and 1. Anything unreadable comes out black.
export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) {
    return { r: 0, g: 0, b: 0 };
  }
  const value = parseInt(match[1], 16);
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

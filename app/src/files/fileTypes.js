// Pure helpers for opening files. No DOM or file system in here, so it all runs under `npm test`.

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
const OFFICE_EXTENSIONS = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'pages', 'key', 'numbers'];

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

// 'image', 'pdf', 'office', or 'other'. 'other' gets opened as text if it looks like text.
export function kindOf(name) {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.includes(ext)) return 'office';
  return 'other';
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
    packed[index] = pages[index].map(function (stroke) {
      return {
        color: stroke.color,
        width: round(stroke.width),
        points: stroke.points.map(function (p) {
          return [round(p.x), round(p.y)];
        }),
      };
    });
  }
  return { version: 1, file: path, pages: packed };
}

// Anything malformed is skipped instead of breaking the file open.
export function unpackInk(data) {
  const pages = {};
  if (!data || typeof data.pages !== 'object' || data.pages === null) {
    return pages;
  }
  for (const index of Object.keys(data.pages)) {
    const strokes = data.pages[index];
    if (!Array.isArray(strokes)) continue;
    pages[index] = strokes
      .filter(function (s) {
        return s && Array.isArray(s.points) && s.points.length > 0;
      })
      .map(function (s) {
        return {
          color: typeof s.color === 'string' ? s.color : '#1c1c1a',
          width: Number(s.width) || 4,
          points: s.points.map(function (p) {
            return { x: Number(p[0]), y: Number(p[1]) };
          }),
        };
      });
  }
  return pages;
}

// Converts strokes between page units (saved) and screen pixels (drawn) by a scale factor.
export function scaleStrokes(strokes, factor) {
  return strokes.map(function (stroke) {
    return {
      color: stroke.color,
      width: stroke.width * factor,
      points: stroke.points.map(function (p) {
        return { x: p.x * factor, y: p.y * factor };
      }),
    };
  });
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

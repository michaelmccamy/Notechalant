// File helpers: what kind of file something is, text paging, saved ink, and page fitting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindOf,
  looksLikeText,
  wrapLines,
  paginate,
  inkFileName,
  packInk,
  unpackInk,
  scaleStrokes,
  fitPage,
  PDF_POINTS_TO_PAGE_UNITS,
  renderResolution,
  pageBreaks,
  copyFormat,
  copyName,
  pdfViewTransform,
  invertPoint,
  strokePath,
  hexToRgb,
} from '../src/files/fileTypes.js';

test('pageBreaks moves a paragraph that does not fit to the next page whole', function () {
  // Content starts at 100 with 300 per page. Blocks of 120: two fit, the third would cross 400.
  const blocks = [0, 1, 2, 3, 4].map((i) => ({ top: 100 + i * 120, bottom: 100 + i * 120 + 120 }));
  assert.deepEqual(pageBreaks(blocks, 100, 300), [100, 340, 580]);
});

test('pageBreaks cuts a block only when it is taller than a page', function () {
  // One 700-tall image with 300 per page: cut at 300, 600, and the rest on a third page.
  assert.deepEqual(pageBreaks([{ top: 0, bottom: 700 }], 0, 300), [0, 300, 600]);
  // A short line after a tall block starts a new page at the line, not mid-line.
  assert.deepEqual(pageBreaks([{ top: 0, bottom: 250 }, { top: 250, bottom: 400 }], 0, 300), [0, 250]);
});

test('pageBreaks keeps everything on one page when it fits', function () {
  assert.deepEqual(pageBreaks([{ top: 10, bottom: 50 }, { top: 60, bottom: 290 }], 0, 300), [0]);
  assert.deepEqual(pageBreaks([], 0, 300), [0]);
});

test('a letter PDF page (612 x 792 pt) becomes the same size as a text page', function () {
  assert.equal(612 * PDF_POINTS_TO_PAGE_UNITS, 816);
  assert.equal(792 * PDF_POINTS_TO_PAGE_UNITS, 1056);
});

test('renderResolution is sharp on high-DPI screens but capped for huge pages', function () {
  // Shown at 70% on a 2x screen: render at 2x so it's crisp.
  assert.equal(renderResolution(816, 1056, 0.7, 2, 16e6), 2);
  // Shown enlarged 1.5x on a 2x screen: 3x.
  assert.equal(renderResolution(816, 1056, 1.5, 2, 16e6), 3);
  // A poster page would need 9600 x 7200 x 4 pixels. Capped to the pixel budget instead.
  const r = renderResolution(4800, 3600, 1, 2, 16e6);
  assert.ok(r < 2 && Math.abs(4800 * 3600 * r * r - 16e6) < 1);
});

test('kindOf sorts files by extension, ignoring case', function () {
  assert.equal(kindOf('diagram.PNG'), 'image');
  assert.equal(kindOf('lecture3.pdf'), 'pdf');
  assert.equal(kindOf('essay.DOCX'), 'docx');
  assert.equal(kindOf('slides.pptx'), 'pptx');
  assert.equal(kindOf('grades.xlsx'), 'xlsx');
  assert.equal(kindOf('old-essay.doc'), 'office');
  assert.equal(kindOf('notes.md'), 'other');
  assert.equal(kindOf('Makefile'), 'other');
  assert.equal(kindOf('.gitignore'), 'other');
});

test('looksLikeText rejects binary content', function () {
  assert.equal(looksLikeText('hello\nworld'), true);
  assert.equal(looksLikeText('PK\u0003\u0004\u0000\u0000'), false);
});

test('wrapLines breaks at spaces, splits long words, expands tabs, and drops trailing blank lines', function () {
  assert.deepEqual(wrapLines('the mitochondria makes ATP', 12), ['the', 'mitochondria', 'makes ATP']);
  assert.deepEqual(wrapLines('abcdefgh\nend\r\n\n', 3), ['abc', 'def', 'gh', 'end']);
  assert.deepEqual(wrapLines('\tx', 10), ['    x']);
  assert.deepEqual(wrapLines('', 10), ['']);
});

test('paginate splits lines into fixed-size pages and always returns at least one', function () {
  assert.deepEqual(paginate(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
  assert.deepEqual(paginate([], 2), [[]]);
});

test('inkFileName keeps same-named files in different folders apart', function () {
  assert.notEqual(inkFileName('week1/notes.txt'), inkFileName('week2/notes.txt'));
  assert.equal(inkFileName('a b/c.pdf'), 'a%20b%2Fc.pdf.json');
});

test('ink survives packing and unpacking, rounded to one decimal', function () {
  const pages = {
    0: [{ color: '#d93025', width: 4.26, points: [{ x: 10.04, y: 20.06 }, { x: 11, y: 21 }] }],
    2: [],
  };
  const packed = JSON.parse(JSON.stringify(packInk('a.png', pages)));
  assert.equal(packed.file, 'a.png');
  assert.deepEqual(Object.keys(packed.pages), ['0'], 'empty pages are not saved');
  assert.deepEqual(unpackInk(packed), {
    0: [{ color: '#d93025', width: 4.3, points: [{ x: 10, y: 20.1 }, { x: 11, y: 21 }] }],
  });
});

test('unpackInk skips malformed data instead of throwing', function () {
  assert.deepEqual(unpackInk(null), {});
  assert.deepEqual(unpackInk({ pages: { 0: 'nope', 1: [{ points: [] }, null] } }), { 1: [] });
});

test('scaling strokes to the screen and back returns the original', function () {
  const strokes = [{ color: '#000', width: 4, points: [{ x: 100, y: 50 }] }];
  const onScreen = scaleStrokes(strokes, 0.5);
  assert.deepEqual(onScreen[0].points[0], { x: 50, y: 25 });
  assert.equal(onScreen[0].width, 2);
  assert.deepEqual(scaleStrokes(onScreen, 2), strokes);
});

test('fitPage centers the page inside the margin and caps upscaling', function () {
  // A letter page in a wide area is limited by height.
  const fit = fitPage(816, 1056, 1200, 800, 24, 4);
  assert.ok(Math.abs(fit.height - 752) < 1e-9);
  assert.ok(Math.abs(fit.left - (1200 - fit.width) / 2) < 1e-9);
  assert.equal(fit.top, 24);
  // A 100px icon would fill the area but stops at 4x.
  assert.equal(fitPage(100, 100, 1200, 800, 24, 4).scale, 4);
});

test('copyFormat keeps PDFs and images, and turns other documents into PDFs', function () {
  assert.equal(copyFormat('a.pdf').extension, 'pdf');
  assert.equal(copyFormat('a.JPG').mime, 'image/jpeg');
  assert.equal(copyFormat('a.png').extension, 'png');
  assert.equal(copyFormat('a.svg').extension, 'png');
  assert.equal(copyFormat('a.docx').extension, 'pdf');
  assert.equal(copyFormat('notes.txt').extension, 'pdf');
});

test('copyName adds -annotated and counts up past names already used', function () {
  const none = () => false;
  assert.equal(copyName('report.docx', 'pdf', none), 'report-annotated.pdf');
  assert.equal(copyName('Makefile', 'pdf', none), 'Makefile-annotated.pdf');
  const used = new Set(['scan-annotated.png', 'scan-annotated-2.png']);
  assert.equal(copyName('scan.png', 'png', (n) => used.has(n)), 'scan-annotated-3.png');
});

test('pdfViewTransform matches PDF.js on an unrotated letter page', function () {
  const m = pdfViewTransform([0, 0, 612, 792], 0, PDF_POINTS_TO_PAGE_UNITS);
  // The top left of the shown page is (0, 792) in PDF space, and the bottom right is (612, 0).
  const topLeft = invertPoint(m, 0, 0);
  const bottomRight = invertPoint(m, 816, 1056);
  assert.ok(Math.abs(topLeft.x) < 1e-9 && Math.abs(topLeft.y - 792) < 1e-9);
  assert.ok(Math.abs(bottomRight.x - 612) < 1e-9 && Math.abs(bottomRight.y) < 1e-9);
});

test('pdfViewTransform round trips on rotated pages with an offset crop box', function () {
  const view = [36, 18, 576, 774];
  for (const rotation of [0, 90, 180, 270, -90]) {
    const m = pdfViewTransform(view, rotation, 2);
    const shown = { x: m[0] * 100 + m[2] * 200 + m[4], y: m[1] * 100 + m[3] * 200 + m[5] };
    const back = invertPoint(m, shown.x, shown.y);
    assert.ok(Math.abs(back.x - 100) < 1e-9 && Math.abs(back.y - 200) < 1e-9, 'rotation ' + rotation);
    // The crop box's corner lands on a corner of the shown page, never off it.
    const corner = { x: m[0] * 36 + m[2] * 18 + m[4], y: m[1] * 36 + m[3] * 18 + m[5] };
    assert.ok(corner.x > -1e-9 && corner.y > -1e-9, 'rotation ' + rotation);
  }
});

test('strokePath curves through midpoints and ends on the last point', function () {
  const path = strokePath([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 3 }]);
  assert.deepEqual(path.map((s) => s.op), ['move', 'curve', 'line']);
  assert.deepEqual(path[1].points[0], { x: 2, y: 0 });
  assert.deepEqual(path[1].points[2], { x: 4.5, y: 1.5 });
  assert.deepEqual(path[2].points[0], { x: 6, y: 3 });
  assert.deepEqual(strokePath([{ x: 1, y: 1 }]).map((s) => s.op), ['move', 'line']);
});

test('hexToRgb reads pen colors', function () {
  assert.deepEqual(hexToRgb('#ff0000'), { r: 1, g: 0, b: 0 });
  assert.deepEqual(hexToRgb('nope'), { r: 0, g: 0, b: 0 });
});

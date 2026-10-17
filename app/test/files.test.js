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
} from '../src/files/fileTypes.js';

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
  assert.equal(kindOf('essay.docx'), 'office');
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

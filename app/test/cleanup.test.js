// Tests clean up: text items replacing handwriting, saving and loading them, the notes' count of
// transcribed ink through clean up and undo, and sizing the typed text to the handwriting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTextItem,
  scaleItems,
  handwriting,
  handwritingPages,
  strokesSignature,
  sameSignature,
  strokeBounds,
} from '../src/ink/inkItems.js';
import { packInk, unpackInk } from '../src/files/fileTypes.js';
import { emptyNotes, untranscribed, markCleanedUp, handwritingRestored } from '../src/notes/noteData.js';
import { fitFontSize } from '../src/ink/textLayer.js';

function stroke(points, width) {
  return { color: '#2f6fed', width: width || 4, points: points.map(([x, y]) => ({ x, y })) };
}

// An H: two downs and a crossbar.
const H = [
  stroke([[100, 100], [100, 200]]),
  stroke([[160, 100], [160, 200]]),
  stroke([[100, 150], [160, 150]]),
];

test('a text item covers the handwriting box, padded by half the pen width', function () {
  const item = makeTextItem('H', H);
  assert.equal(item.type, 'text');
  assert.equal(item.color, '#2f6fed');
  assert.deepEqual(item.box, { x: 98, y: 98, width: 64, height: 104 });
  assert.equal(item.strokes, H);
  assert.deepEqual(strokeBounds([]), { x: 0, y: 0, width: 0, height: 0 });
});

test('scaling a page scales text boxes and the handwriting inside them', function () {
  const page = [stroke([[10, 10], [20, 20]]), makeTextItem('H', H)];
  const scaled = scaleItems(page, 0.5);
  assert.deepEqual(scaled[0].points, [{ x: 5, y: 5 }, { x: 10, y: 10 }]);
  assert.equal(scaled[0].width, 2);
  assert.deepEqual(scaled[1].box, { x: 49, y: 49, width: 32, height: 52 });
  assert.deepEqual(scaled[1].strokes[0].points, [{ x: 50, y: 50 }, { x: 50, y: 100 }]);
  assert.equal(scaled[1].text, 'H');
});

test('text items survive saving and loading, with their handwriting', function () {
  const pages = { 0: [stroke([[1, 2], [3, 4]]), makeTextItem('$2+2$', H)] };
  const loaded = unpackInk(JSON.parse(JSON.stringify(packInk('board', pages))));
  assert.equal(loaded[0].length, 2);
  assert.deepEqual(loaded[0][1].box, { x: 98, y: 98, width: 64, height: 104 });
  assert.equal(loaded[0][1].text, '$2+2$');
  assert.equal(loaded[0][1].strokes.length, 3);
  assert.deepEqual(loaded[0][1].strokes[2].points, [{ x: 100, y: 150 }, { x: 160, y: 150 }]);
});

test('broken text items are skipped when loading, not fatal', function () {
  const loaded = unpackInk({
    pages: {
      0: [
        { type: 'text', text: 'no box', strokes: [{ color: '#000', width: 4, points: [[0, 0]] }] },
        { type: 'text', text: 'no strokes', box: [0, 0, 10, 10], strokes: [] },
        { color: '#000', width: 4, points: [[5, 5]] },
      ],
    },
  });
  assert.equal(loaded[0].length, 1);
  assert.equal(loaded[0][0].points[0].x, 5);
});

test('saved copies get the original handwriting back in place of text', function () {
  const extra = stroke([[0, 0], [1, 1]]);
  const page = [extra, makeTextItem('H', H)];
  assert.deepEqual(handwriting(page), [extra, ...H]);
  assert.deepEqual(handwritingPages({ 2: page })[2], [extra, ...H]);
});

test('signature tells whether the same handwriting is still there', function () {
  const sig = strokesSignature(H);
  assert.ok(sameSignature(sig, strokesSignature(scaleItems(H, 1))));
  assert.ok(!sameSignature(sig, strokesSignature(H.slice(0, 2))), 'one stroke undone');
  assert.ok(!sameSignature(sig, strokesSignature([H[0], H[1], stroke([[0, 0], [9, 9]])])), 'different last stroke');
  assert.equal(strokesSignature([makeTextItem('H', H)]), null, 'text is never handwriting to clean up');
  assert.ok(!sameSignature(null, sig));
});

test('the notes count stays right through clean up and undo', function () {
  const notes = emptyNotes();
  const before = stroke([[0, 0], [5, 5]]);
  // Ink: one old stroke already transcribed, then the H.
  notes.transcribed[0] = 1;
  let page = [before, ...H];
  assert.equal(untranscribed(notes, 0, page).length, 3);

  // Clean up turns the H into one text item at index 1.
  page = [before, makeTextItem('H', H)];
  markCleanedUp(notes, 0, 1);
  assert.equal(notes.transcribed[0], 2);
  assert.equal(untranscribed(notes, 0, page).length, 0, 'the text item is not sent again');

  // Undo brings the 3 strokes back where the item was. They stay counted as read.
  page = [before, ...H];
  handwritingRestored(notes, 0, 1, 3);
  assert.equal(notes.transcribed[0], 4);
  assert.equal(untranscribed(notes, 0, page).length, 0, 'restored handwriting is not cleaned up again');

  // New writing after that is still picked up.
  page.push(stroke([[300, 100], [300, 200]]));
  assert.equal(untranscribed(notes, 0, page).length, 1);
});

test('restoring handwriting that was never counted leaves the count alone', function () {
  const notes = emptyNotes();
  notes.transcribed[0] = 1;
  handwritingRestored(notes, 0, 3, 5);
  assert.equal(notes.transcribed[0], 1);
});

test('typed text is sized to the handwriting box', function () {
  // "HI" measured at 100px is 120 x 115. A 240 x 200 box: height allows 174px, width 200px.
  assert.equal(Math.round(fitFontSize(120, 115, 240, 200)), 174);
  // A wide, short box: the width limits it.
  assert.equal(Math.round(fitFontSize(400, 115, 200, 300)), 50);
  // A single thin stroke (an I) 4px wide and 150px tall still gets readable text.
  assert.ok(fitFontSize(30, 115, 4, 150) > 100);
  // Clamped at both ends.
  assert.equal(fitFontSize(100, 100, 1, 1), 10);
  assert.equal(fitFontSize(10, 10, 5000, 5000), 600);
  assert.equal(fitFontSize(0, 0, 100, 100), 10);
});

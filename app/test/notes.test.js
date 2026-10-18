// Per-file notes: which strokes still need reading, note blocks, export, and the auto timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyNotes,
  notesForExistingInk,
  untranscribed,
  markTranscribed,
  addBlock,
  editBlock,
  removeBlock,
  orderedBlocks,
  contextTail,
  toMarkdown,
  packNotes,
  unpackNotes,
  shouldAutoTranscribe,
  strokesBox,
  lineBlocks,
  canRewrite,
} from '../src/notes/noteData.js';
import { parseMarkdown, hasMath } from '../src/notes/markdown.js';
import { cleanTranscription } from '../src/recognize.js';

const strokes = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));

test('only strokes written since the last transcription are sent', function () {
  const notes = emptyNotes();
  assert.equal(untranscribed(notes, 0, strokes(3)).length, 3);
  markTranscribed(notes, 0, 3, 3);
  assert.equal(untranscribed(notes, 0, strokes(5)).length, 2);
  assert.equal(untranscribed(notes, 1, strokes(1)).length, 1, 'pages are tracked separately');
});

test('undoing transcribed strokes and writing again picks up the new writing', function () {
  const notes = emptyNotes();
  markTranscribed(notes, 0, 4, 4);
  assert.equal(untranscribed(notes, 0, strokes(2)).length, 0, 'after undoing two strokes');
  assert.equal(untranscribed(notes, 0, strokes(3)).length, 1, 'then writing one');
});

test('marking never counts past what is on the page, in case strokes were undone mid-request', function () {
  const notes = emptyNotes();
  markTranscribed(notes, 0, 5, 3);
  assert.equal(notes.transcribed[0], 3);
});

test('ink that existed before the file had notes is not sent', function () {
  const notes = notesForExistingInk({ 0: strokes(4), 2: strokes(1) });
  assert.deepEqual(notes.transcribed, { 0: 4, 2: 1 });
  assert.equal(untranscribed(notes, 0, strokes(4)).length, 0);
});

test('blocks read in page order, edit to empty deletes, and export groups by page', function () {
  const notes = emptyNotes();
  const b = addBlock(notes, 'Krebs cycle', 2, 100);
  addBlock(notes, 'Glycolysis', 0, 200);
  addBlock(notes, '$ATP$', 2, 300);
  assert.deepEqual(
    orderedBlocks(notes).map((x) => x.text),
    ['Glycolysis', 'Krebs cycle', '$ATP$'],
  );
  assert.equal(toMarkdown('lecture4.pdf', notes, 3), '# lecture4.pdf\n\n## Page 1\n\nGlycolysis\n\n## Page 3\n\nKrebs cycle\n\n$ATP$\n');
  assert.equal(toMarkdown('board', notes, 1), '# board\n\nGlycolysis\n\nKrebs cycle\n\n$ATP$\n');
  editBlock(notes, b.id, 'Citric acid cycle');
  assert.equal(notes.blocks[0].text, 'Citric acid cycle');
  editBlock(notes, b.id, '  ');
  assert.equal(notes.blocks.length, 2);
  removeBlock(notes, notes.blocks[0].id);
  assert.deepEqual(
    notes.blocks.map((x) => x.text),
    ['$ATP$'],
  );
  assert.equal(contextTail(notes, 3), 'TP$');
});

test('notes survive packing and unpacking, and junk is dropped', function () {
  const notes = emptyNotes();
  addBlock(notes, 'hello', 1, 5);
  markTranscribed(notes, 1, 2, 2);
  const back = unpackNotes(JSON.parse(JSON.stringify(packNotes('a.pdf', notes))));
  assert.deepEqual(back, notes);
  assert.equal(unpackNotes(null), null);
  assert.deepEqual(unpackNotes({ blocks: [null, { text: 'x' }, { id: 'a', text: 'ok', page: '2' }], transcribed: { 0: -1, 1: 3 } }), {
    blocks: [{ id: 'a', text: 'ok', page: 2, createdAt: 0 }],
    transcribed: { 1: 3 },
  });
});

// The line from the bug report: "7x + 4" written first, then "=" added after a pause.
const equation = { x0: 180, y0: 350, x1: 860, y1: 560 };
const withLine = (box, extra) => {
  const notes = emptyNotes();
  const block = addBlock(notes, '$7x + 4$', 0, 10, { box: box, strokes: [0, 1, 2, 3, 4, 5] });
  Object.assign(block, extra);
  return { notes, block };
};

test('writing added to the end of a line joins that line', function () {
  const { notes, block } = withLine(equation);
  const equalsSign = { x0: 970, y0: 395, x1: 1075, y1: 485 };
  assert.deepEqual(lineBlocks(notes, 0, equalsSign), [block]);
  // Adding a coefficient in front counts too.
  assert.deepEqual(lineBlocks(notes, 0, { x0: 60, y0: 400, x1: 150, y1: 520 }), [block]);
});

test('a new line below, writing far across the page, or another page start a new note', function () {
  const { notes } = withLine(equation);
  assert.deepEqual(lineBlocks(notes, 0, { x0: 200, y0: 620, x1: 700, y1: 800 }), [], 'next line down');
  assert.deepEqual(lineBlocks(notes, 0, { x0: 1300, y0: 380, x1: 1500, y1: 540 }), [], 'far to the right');
  assert.deepEqual(lineBlocks(notes, 1, { x0: 970, y0: 395, x1: 1075, y1: 485 }), [], 'same spot, other page');
  assert.deepEqual(lineBlocks(notes, 0, null), [], 'no ink');
});

test('hand-edited notes and notes saved before boxes existed are never rewritten', function () {
  const equalsSign = { x0: 970, y0: 395, x1: 1075, y1: 485 };
  assert.deepEqual(lineBlocks(withLine(equation, { edited: true }).notes, 0, equalsSign), []);
  const old = emptyNotes();
  addBlock(old, 'from before', 0, 5);
  assert.deepEqual(lineBlocks(old, 0, equalsSign), []);
});

test('tutor notes: a review alone can grow, but conversations, questions, drawings, and fixes stay', function () {
  const equalsSign = { x0: 970, y0: 395, x1: 1075, y1: 485 };
  const review = { review: { verdict: 'correct', message: 'ok', issues: [] }, thread: [], pending: false, error: '' };
  const talked = { review: null, thread: [{ role: 'student', text: 'why?' }], pending: false, error: '' };
  assert.equal(lineBlocks(withLine(equation, { tutor: review }).notes, 0, equalsSign).length, 1, 'review only');
  assert.equal(lineBlocks(withLine(equation, { tutor: talked }).notes, 0, equalsSign).length, 0, 'conversation');
  assert.equal(lineBlocks(withLine(equation, { asked: true }).notes, 0, equalsSign).length, 0, 'typed question');
  assert.equal(lineBlocks(withLine(equation, { text: '', sketch: 'data:image/png;base64,AAAA' }).notes, 0, equalsSign).length, 0, 'drawing');
  assert.equal(canRewrite(withLine(equation, { edited: true }).block), false, 'edited, by hand or by a tutor fix');
  assert.equal(canRewrite(withLine(equation).block), true);
});

test('writing that bridges two pieces of the same line returns both, oldest first', function () {
  const notes = emptyNotes();
  const left = addBlock(notes, 'a', 0, 1, { box: { x0: 0, y0: 100, x1: 300, y1: 200 }, strokes: [0] });
  const right = addBlock(notes, 'b', 0, 2, { box: { x0: 700, y0: 100, x1: 1000, y1: 200 }, strokes: [1] });
  assert.deepEqual(lineBlocks(notes, 0, { x0: 350, y0: 110, x1: 650, y1: 190 }), [left, right]);
});

test('undone strokes are dropped from their note', function () {
  const { notes, block } = withLine(equation);
  markTranscribed(notes, 0, 6, 6);
  untranscribed(notes, 0, strokes(4));
  assert.deepEqual(block.strokes, [0, 1, 2, 3]);
});

test('editing a note marks it, and boxes survive saving', function () {
  const { notes, block } = withLine(equation);
  editBlock(notes, block.id, '$7x + 4 = 18$');
  assert.equal(block.edited, true);
  const back = unpackNotes(JSON.parse(JSON.stringify(packNotes('board', notes))));
  assert.deepEqual(back.blocks[0], block);
  assert.deepEqual(strokesBox([{ points: [{ x: 5, y: 9 }, { x: 1, y: 20 }] }]), { x0: 1, y0: 9, x1: 5, y1: 20 });
  assert.equal(strokesBox([]), null);
  assert.equal(contextTail(notes, 100, [block.id]), '');
});

test('auto transcribe waits for a pause and does not retry a failure until the ink changes', function () {
  const base = { auto: true, loaded: true, busy: false, writing: false, pending: 2, attemptKey: 'a:0:2', failedKey: null, now: 3000, lastInkChangeAt: 1000, idleMs: 2000 };
  assert.equal(shouldAutoTranscribe(base), true);
  assert.equal(shouldAutoTranscribe({ ...base, now: 2500 }), false);
  assert.equal(shouldAutoTranscribe({ ...base, writing: true }), false);
  assert.equal(shouldAutoTranscribe({ ...base, busy: true }), false);
  assert.equal(shouldAutoTranscribe({ ...base, pending: 0 }), false);
  assert.equal(shouldAutoTranscribe({ ...base, auto: false }), false);
  assert.equal(shouldAutoTranscribe({ ...base, loaded: false }), false);
  assert.equal(shouldAutoTranscribe({ ...base, failedKey: 'a:0:2' }), false);
  assert.equal(shouldAutoTranscribe({ ...base, failedKey: 'a:0:1' }), true);
});

test('parseMarkdown handles headings, lists, and multi-line paragraphs', function () {
  assert.deepEqual(parseMarkdown('# Title\n- a\n- b\n1. one\nplain $$x\n= 1$$\nnext\n\nsecond'), [
    { type: 'heading', level: 1, text: 'Title' },
    { type: 'list', ordered: false, items: ['a', 'b'] },
    { type: 'list', ordered: true, items: ['one'] },
    { type: 'paragraph', text: 'plain $$x\n= 1$$\nnext' },
    { type: 'paragraph', text: 'second' },
  ]);
  assert.equal(hasMath('$x^2$'), true);
  assert.equal(hasMath('plain words'), false);
});

test('cleanTranscription strips code fences and the nothing marker', function () {
  assert.equal(cleanTranscription('```markdown\nhello\n```'), 'hello');
  assert.equal(cleanTranscription('  hi  '), 'hi');
  assert.equal(cleanTranscription('(nothing recognized)'), '');
  assert.equal(cleanTranscription(undefined), '');
});

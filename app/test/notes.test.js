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

// Tutor mode: checking what the model sends, applying fixes, saving feedback with the notes,
// and the server rejecting bad requests before calling Gemini.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTutor,
  worthReviewing,
  normalizeReview,
  applyFix,
  resolveIssue,
  addMessage,
  packTutor,
  unpackTutor,
  validSketch,
} from '../src/tutor/tutorData.js';
import { emptyNotes, addBlock, editBlock, packNotes, unpackNotes, contextBefore, findBlock, toMarkdown } from '../src/notes/noteData.js';
import { tutor } from '../../server/tutor.mjs';

const MATH_ISSUE = { kind: 'math', wrong: '$2x + 3x = 6x$', fix: '$2x + 3x = 5x$', why: 'Add the coefficients: 2 + 3 = 5.' };

test('normalizeReview keeps a well-formed review', function () {
  const review = normalizeReview({ verdict: 'issues', message: 'One slip.', issues: [MATH_ISSUE], options: [] });
  assert.deepEqual(review, { verdict: 'issues', message: 'One slip.', issues: [MATH_ISSUE], options: [] });
});

test('normalizeReview returns null when the tutor has nothing to say', function () {
  assert.equal(normalizeReview({ verdict: 'none', message: '' }), null);
  assert.equal(normalizeReview({ verdict: 'correct', message: '' }), null);
  assert.equal(normalizeReview(null), null);
  assert.equal(normalizeReview('nope'), null);
  assert.equal(normalizeReview({ verdict: 'shout', message: 'hi' }), null);
});

test('normalizeReview drops broken issues and limits options', function () {
  const review = normalizeReview({
    verdict: 'question',
    message: 'What do you want help with?',
    issues: [MATH_ISSUE],
    options: ['Check my steps', '', 42, 'Give me a hint', 'Explain it', 'One too many'],
  });
  // A question carries no corrections, and at most three options.
  assert.deepEqual(review.issues, []);
  assert.deepEqual(review.options, ['Check my steps', 'Give me a hint', 'Explain it']);

  const odd = normalizeReview({ verdict: 'issues', message: 'Hmm', issues: [{ wrong: 'a' }, { kind: 'weird', wrong: 'teh', fix: 'the' }] });
  assert.deepEqual(odd.issues, [{ kind: 'other', wrong: 'teh', fix: 'the', why: '' }]);
});

test('normalizeReview treats "issues" with none usable as a plain message', function () {
  assert.equal(normalizeReview({ verdict: 'issues', message: 'Looks fine actually.', issues: [] }).verdict, 'correct');
  assert.equal(normalizeReview({ verdict: 'issues', message: '', issues: [] }), null);
});

test('applyFix replaces the wrong text, or returns null once it is gone', function () {
  assert.equal(applyFix('so $2x + 3x = 6x$ then', MATH_ISSUE), 'so $2x + 3x = 5x$ then');
  assert.equal(applyFix('already edited', MATH_ISSUE), null);
});

test('resolveIssue removes one issue, and the last one marks it all fixed', function () {
  const two = { verdict: 'issues', message: 'Two things.', issues: [MATH_ISSUE, { kind: 'spelling', wrong: 'teh', fix: 'the', why: '' }], options: [] };
  const one = resolveIssue(two, 0);
  assert.equal(one.issues.length, 1);
  assert.equal(one.issues[0].wrong, 'teh');
  const none = resolveIssue(one, 0);
  assert.equal(none.verdict, 'correct');
  assert.deepEqual(none.issues, []);
});

test('worthReviewing skips stray marks', function () {
  assert.equal(worthReviewing('x'), false);
  assert.equal(worthReviewing('   '), false);
  assert.equal(worthReviewing('Their going home'), true);
});

test('tutor feedback is saved with the notes, without pending or errors', function () {
  const notes = emptyNotes();
  const block = addBlock(notes, 'so $2x + 3x = 6x$', 0, 1000);
  block.tutor = emptyTutor();
  block.tutor.review = normalizeReview({ verdict: 'issues', message: 'One slip.', issues: [MATH_ISSUE] });
  addMessage(block.tutor, 'student', 'Why?');
  addMessage(block.tutor, 'tutor', 'Add the coefficients.');
  block.tutor.pending = true;
  block.tutor.error = 'offline';

  const saved = JSON.parse(JSON.stringify(packNotes('a.pdf', notes)));
  assert.deepEqual(Object.keys(saved.blocks[0].tutor).sort(), ['review', 'thread']);
  // Packing doesn't change the notes that are open.
  assert.equal(block.tutor.pending, true);

  const loaded = unpackNotes(saved);
  assert.equal(loaded.blocks[0].tutor.review.issues[0].fix, MATH_ISSUE.fix);
  assert.equal(loaded.blocks[0].tutor.thread.length, 2);
  assert.equal(loaded.blocks[0].tutor.pending, false);
});

test('unpackTutor drops empty or malformed feedback', function () {
  assert.equal(unpackTutor(null), null);
  assert.equal(unpackTutor({ review: { verdict: 'none' }, thread: [] }), null);
  const tutorData = unpackTutor({ review: null, thread: [{ role: 'hacker', text: 'hi' }, { text: '' }, 5] });
  assert.deepEqual(tutorData.thread, [{ role: 'student', text: 'hi' }]);
  assert.deepEqual(packTutor(tutorData), { review: null, thread: [{ role: 'student', text: 'hi' }] });
});

test('contextBefore gives the tutor only the notes written before the block', function () {
  const notes = emptyNotes();
  addBlock(notes, 'First', 0, 1);
  const second = addBlock(notes, 'Second', 0, 2);
  addBlock(notes, 'Third', 0, 3);
  assert.equal(contextBefore(notes, second.id, 100), 'First');
  assert.equal(findBlock(notes, second.id), second);
  assert.equal(findBlock(notes, 'missing'), null);
});

const SKETCH = 'data:image/png;base64,iVBORw0KGgo=';

test('normalizeReview keeps explanations of the page', function () {
  const review = normalizeReview({ verdict: 'explain', message: 'Osmosis is water moving across a membrane.' });
  assert.equal(review.verdict, 'explain');
  assert.deepEqual(review.issues, []);
});

test('validSketch accepts only small PNG data URLs', function () {
  assert.equal(validSketch(SKETCH), SKETCH);
  assert.equal(validSketch('data:image/jpeg;base64,abc'), null);
  assert.equal(validSketch('javascript:alert(1)'), null);
  assert.equal(validSketch('data:image/png;base64,' + 'A'.repeat(500000)), null);
});

test('a drawing is saved as a note with its picture, and a caption can be cleared', function () {
  const notes = emptyNotes();
  const drawing = addBlock(notes, '', 0, 1);
  drawing.sketch = SKETCH;
  const question = addBlock(notes, 'What does mitosis mean?', 0, 2);
  question.asked = true;
  addBlock(notes, '', 0, 3); // empty with no drawing: dropped on load

  const loaded = unpackNotes(JSON.parse(JSON.stringify(packNotes('bio.pdf', notes))));
  assert.equal(loaded.blocks.length, 2);
  assert.equal(loaded.blocks[0].sketch, SKETCH);
  assert.equal(loaded.blocks[1].asked, true);

  editBlock(loaded, loaded.blocks[0].id, 'Free-body diagram');
  assert.equal(loaded.blocks[0].text, 'Free-body diagram');
  editBlock(loaded, loaded.blocks[0].id, '   ');
  assert.equal(loaded.blocks[0].text, '');
  assert.equal(loaded.blocks.length, 2);

  const md = toMarkdown('bio.pdf', loaded, 1);
  assert.ok(md.includes('*(drawing)*'));
  assert.ok(md.includes('**Q:** What does mitosis mean?'));
});

test('the tutor server rejects requests before calling Gemini', async function () {
  const noKey = await tutor({ text: 'hi there' }, {});
  assert.equal(noKey.status, 500);
  const env = { GEMINI_API_KEY: 'test', GEMINI_MODEL: 'test' };
  assert.equal((await tutor(null, env)).status, 400);
  assert.equal((await tutor({ text: '   ' }, env)).status, 400);
  // A sketch that isn't a PNG doesn't count as something to look at.
  assert.equal((await tutor({ text: '', sketch: 'data:text/html;base64,PGI+' }, env)).status, 400);
});

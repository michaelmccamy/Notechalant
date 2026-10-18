// A file's notes, as plain data. No DOM or storage in here, so it all runs under `npm test`.
//
//   { blocks: [{ id, text, page, createdAt, box, strokes, edited }], transcribed: { pageIndex: strokeCount } }
//
// Ink stays on the page after it's transcribed. `transcribed[page]` counts how many of that
// page's strokes (oldest first) have been sent already, so only newer strokes go next time.
//
// A block remembers where its ink is: `box` (page units) and `strokes` (indexes into the page's
// stroke list). Writing added later on the same line joins that block, and the whole line is
// read again, so "7x + 4" followed by "=" becomes one note, "7x + 4 =". Blocks edited by hand
// (`edited`) are never rewritten.

// How far beside a line new writing can start and still count as the same line, in line heights.
const LINE_REACH = 1.5;
// New writing has to share at least this much of the shorter of the two heights with a line.
const LINE_OVERLAP = 0.5;

export function emptyNotes() {
  return { blocks: [], transcribed: {} };
}

// Notes for a file that already had ink before it had notes: count that ink as handled, so
// opening an annotated file doesn't send all its old circles and arrows off to be read.
export function notesForExistingInk(inkPages) {
  const notes = emptyNotes();
  for (const page of Object.keys(inkPages)) {
    notes.transcribed[page] = inkPages[page].length;
  }
  return notes;
}

// Strokes on a page that haven't been transcribed yet. If strokes were undone or cleared since,
// the count shrinks to match, so redrawing after an undo still gets picked up, and blocks forget
// the undone strokes so they can't later claim new writing that reuses those slots.
export function untranscribed(notes, page, strokes) {
  const done = Math.min(notes.transcribed[page] || 0, strokes.length);
  notes.transcribed[page] = done;
  for (const block of notes.blocks) {
    if (block.page === page && block.strokes) {
      block.strokes = block.strokes.filter((i) => i < strokes.length);
    }
  }
  return strokes.slice(done);
}

// Bounding box of strokes, in page units: { x0, y0, x1, y1 }, or null for no points.
export function strokesBox(strokes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const stroke of strokes) {
    for (const p of stroke.points) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

// Blocks on `page` that writing inside `box` continues: they share most of a line's height and
// sit within LINE_REACH line heights to the left or right. Oldest first. Hand-edited blocks and
// blocks saved before blocks had boxes are left out.
export function lineBlocks(notes, page, box) {
  if (box === null) {
    return [];
  }
  return notes.blocks
    .filter(function (block) {
      if (block.page !== page || !block.box || block.edited || !block.strokes || block.strokes.length === 0) {
        return false;
      }
      const b = block.box;
      const shorter = Math.max(1, Math.min(b.y1 - b.y0, box.y1 - box.y0));
      const taller = Math.max(b.y1 - b.y0, box.y1 - box.y0);
      const overlap = Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0);
      const reach = Math.max(taller * LINE_REACH, 60);
      return overlap >= shorter * LINE_OVERLAP && box.x0 <= b.x1 + reach && box.x1 >= b.x0 - reach;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Marks a page's strokes as sent, up to `count`, never past what's on the page now.
export function markTranscribed(notes, page, count, strokesNow) {
  notes.transcribed[page] = Math.min(count, strokesNow);
}

// `ink` is { box, strokes } for the ink the text came from, or omitted.
export function addBlock(notes, text, page, now, ink) {
  const time = now === undefined ? Date.now() : now;
  const block = { id: time.toString(36) + Math.random().toString(36).slice(2, 7), text: text, page: page, createdAt: time };
  if (ink) {
    block.box = ink.box;
    block.strokes = ink.strokes;
  }
  notes.blocks.push(block);
  return block;
}

// Saving empty text deletes the block, so clearing a block in the editor removes it. An edited
// block keeps its text from then on: writing on its line starts a new block instead.
export function editBlock(notes, id, text) {
  if (text.trim() === '') {
    removeBlock(notes, id);
    return;
  }
  for (const block of notes.blocks) {
    if (block.id === id) {
      block.text = text;
      block.edited = true;
    }
  }
}

export function removeBlock(notes, id) {
  notes.blocks = notes.blocks.filter((block) => block.id !== id);
}

// Reading order: by page, then in the order they were written.
export function orderedBlocks(notes) {
  return notes.blocks.slice().sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

// The last few hundred characters, sent with each recognition request as context. Blocks being
// read again (`skipIds`) are left out, so the model doesn't see their old text twice.
export function contextTail(notes, maxChars, skipIds) {
  const text = orderedBlocks(notes)
    .filter((block) => !(skipIds && skipIds.includes(block.id)))
    .map((block) => block.text)
    .join('\n\n');
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

// Markdown for Copy and Export. Multi-page files get a heading per page.
export function toMarkdown(title, notes, pageCount) {
  const lines = ['# ' + title, ''];
  let lastPage = null;
  for (const block of orderedBlocks(notes)) {
    if (pageCount > 1 && block.page !== lastPage) {
      lines.push('## Page ' + (block.page + 1), '');
      lastPage = block.page;
    }
    lines.push(block.text, '');
  }
  return lines.join('\n');
}

// Saved form. Anything malformed is dropped instead of breaking the file open.
export function packNotes(file, notes) {
  return { version: 1, file: file, blocks: notes.blocks, transcribed: notes.transcribed };
}

export function unpackNotes(data) {
  const notes = emptyNotes();
  if (!data || typeof data !== 'object') {
    return null;
  }
  if (Array.isArray(data.blocks)) {
    notes.blocks = data.blocks
      .filter((b) => b && typeof b.text === 'string' && typeof b.id === 'string')
      .map(function (b) {
        const block = { id: b.id, text: b.text, page: Number(b.page) || 0, createdAt: Number(b.createdAt) || 0 };
        const box = b.box;
        if (box && ['x0', 'y0', 'x1', 'y1'].every((k) => Number.isFinite(box[k])) && Array.isArray(b.strokes)) {
          block.box = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
          block.strokes = b.strokes.filter((i) => Number.isInteger(i) && i >= 0);
        }
        if (b.edited === true) {
          block.edited = true;
        }
        return block;
      });
  }
  if (data.transcribed && typeof data.transcribed === 'object') {
    for (const page of Object.keys(data.transcribed)) {
      const count = Number(data.transcribed[page]);
      if (count >= 0) notes.transcribed[page] = count;
    }
  }
  return notes;
}

// Pure so it can be tested. Decides whether the auto timer should send the current page now.
export function shouldAutoTranscribe(state) {
  return (
    state.auto &&
    state.loaded &&
    !state.busy &&
    !state.writing &&
    state.pending > 0 &&
    state.attemptKey !== state.failedKey &&
    state.now - state.lastInkChangeAt >= state.idleMs
  );
}

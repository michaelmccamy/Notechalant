// A file's notes, as plain data. No DOM or storage in here, so it all runs under `npm test`.
//
//   { blocks: [{ id, text, page, createdAt }], transcribed: { pageIndex: strokeCount } }
//
// Ink stays on the page after it's transcribed. `transcribed[page]` counts how many of that
// page's strokes (oldest first) have been sent already, so only newer strokes go next time.

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
// the count shrinks to match, so redrawing after an undo still gets picked up.
export function untranscribed(notes, page, strokes) {
  const done = Math.min(notes.transcribed[page] || 0, strokes.length);
  notes.transcribed[page] = done;
  return strokes.slice(done);
}

// Marks a page's strokes as sent, up to `count`, never past what's on the page now.
export function markTranscribed(notes, page, count, strokesNow) {
  notes.transcribed[page] = Math.min(count, strokesNow);
}

export function addBlock(notes, text, page, now) {
  const time = now === undefined ? Date.now() : now;
  const block = { id: time.toString(36) + Math.random().toString(36).slice(2, 7), text: text, page: page, createdAt: time };
  notes.blocks.push(block);
  return block;
}

// Saving empty text deletes the block, so clearing a block in the editor removes it.
export function editBlock(notes, id, text) {
  if (text.trim() === '') {
    removeBlock(notes, id);
    return;
  }
  for (const block of notes.blocks) {
    if (block.id === id) block.text = text;
  }
}

export function removeBlock(notes, id) {
  notes.blocks = notes.blocks.filter((block) => block.id !== id);
}

// Reading order: by page, then in the order they were written.
export function orderedBlocks(notes) {
  return notes.blocks.slice().sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

// The last few hundred characters, sent with each recognition request as context.
export function contextTail(notes, maxChars) {
  const text = orderedBlocks(notes)
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
      .map((b) => ({ id: b.id, text: b.text, page: Number(b.page) || 0, createdAt: Number(b.createdAt) || 0 }));
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

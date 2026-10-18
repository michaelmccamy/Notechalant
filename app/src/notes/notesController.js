// Turns handwriting into each file's notes. In auto mode it waits for the pen to pause, sends
// the current page's new strokes to recognition, and adds the text to that file's notes. The
// ink stays on the page. A request that fails isn't retried until the ink changes, so a dead
// server doesn't turn into a request every second.

import {
  notesForExistingInk,
  untranscribed,
  markTranscribed,
  strokesBox,
  lineBlocks,
  addBlock,
  editBlock,
  removeBlock,
  contextTail,
  toMarkdown,
  shouldAutoTranscribe,
} from './noteData.js';
import { loadNotes, saveNotes } from './notesStorage.js';
import { strokesToPng } from './strokeImage.js';
import { createNotesPanel } from './notesPanel.js';

const CONTEXT_CHARS = 400;

export function createNotesController({ getActiveTab, getFolder, isWriting, lastInkChangeAt, goToPage, recognize, idleMs, onStatus, onBusyChange }) {
  let auto = true;
  // The tab a request is in flight for, or null.
  let busy = null;
  // The note being read again for its line, shown pulsing in place of a new placeholder.
  let busyBlockId = null;
  let failedKey = null;

  const panel = createNotesPanel({
    onEdit: function (id, text) {
      const tab = getActiveTab();
      editBlock(tab.notes, id, text);
      changed(tab);
    },
    onDelete: function (id) {
      const tab = getActiveTab();
      removeBlock(tab.notes, id);
      changed(tab);
    },
    onGoToPage: goToPage,
    onCopy: async function () {
      const tab = getActiveTab();
      try {
        await navigator.clipboard.writeText(markdownFor(tab));
        onStatus('Notes copied');
      } catch (err) {
        onStatus("Couldn't copy: " + err.message, true);
      }
    },
    onExport: function () {
      const tab = getActiveTab();
      download(tab.name.replace(/\.[^.]+$/, '') + ' notes.md', markdownFor(tab));
    },
  });

  // Loads a newly opened tab's notes. The tab keeps the folder it came from, so a request that
  // finishes after a folder switch still saves to the right place.
  async function attach(tab) {
    tab.notes = null;
    tab.notesFolder = getFolder();
    const saved = await loadNotes(tab, tab.notesFolder);
    tab.notes = saved || notesForExistingInk(tab.ink);
    if (getActiveTab() === tab) {
      show(tab);
    }
  }

  function show(tab) {
    panel.setPending(busy === tab, busy === tab ? busyBlockId : null);
    panel.render(tab, tab.page);
  }

  function pendingOnPage(tab) {
    return untranscribed(tab.notes, tab.page, tab.ink[tab.page] || []);
  }

  function tick() {
    const tab = getActiveTab();
    if (!tab.notes) {
      return;
    }
    const strokes = tab.ink[tab.page] || [];
    const ready = shouldAutoTranscribe({
      auto: auto,
      loaded: true,
      busy: busy !== null,
      writing: isWriting(),
      pending: pendingOnPage(tab).length,
      attemptKey: attemptKey(tab, tab.page, strokes.length),
      failedKey: failedKey,
      now: performance.now(),
      lastInkChangeAt: lastInkChangeAt(),
      idleMs: idleMs,
    });
    if (ready) {
      run(tab, tab.page);
    }
  }

  // The Transcribe button. Unlike auto mode, it retries after a failure.
  function transcribeNow() {
    const tab = getActiveTab();
    if (busy !== null) {
      return;
    }
    if (!tab.notes || pendingOnPage(tab).length === 0) {
      onStatus('Nothing new to transcribe on this page');
      return;
    }
    run(tab, tab.page);
  }

  // Sends the page's new strokes. If they continue a line that already has a note, that line's
  // strokes go along with them and the note is rewritten, so a line read in pieces ends up whole.
  async function run(tab, page) {
    const strokes = tab.ink[page] || [];
    const fresh = untranscribed(tab.notes, page, strokes);
    const sentCount = strokes.length;
    const key = attemptKey(tab, page, sentCount);
    const freshIndexes = fresh.map((_, i) => sentCount - fresh.length + i);
    const lines = lineBlocks(tab.notes, page, strokesBox(fresh));
    const indexes = Array.from(new Set(lines.flatMap((block) => block.strokes).concat(freshIndexes))).sort((a, b) => a - b);
    const sent = indexes.map((i) => strokes[i]);

    busy = tab;
    busyBlockId = lines.length > 0 ? lines[0].id : null;
    onBusyChange(true);
    if (getActiveTab() === tab) {
      panel.setPending(true, busyBlockId);
    }
    onStatus(lines.length > 0 ? 'Reading the whole line again…' : 'Transcribing…');

    let text;
    try {
      text = await recognize(
        strokesToPng(sent),
        contextTail(
          tab.notes,
          CONTEXT_CHARS,
          lines.map((block) => block.id),
        ),
        lines.map((block) => block.text).join('\n'),
      );
    } catch (err) {
      failedKey = key;
      finish();
      onStatus(err.message, true);
      return;
    }

    failedKey = null;
    const strokesNow = (tab.ink[page] || []).length;
    markTranscribed(tab.notes, page, sentCount, strokesNow);
    const ink = { box: strokesBox(sent), strokes: indexes.filter((i) => i < strokesNow) };
    // The line's notes may have been deleted or edited by hand while this was in flight.
    const live = lines.filter((block) => tab.notes.blocks.includes(block) && !block.edited);
    let block = null;
    let status = 'No writing found, kept it as ink';
    if (text && live.length > 0) {
      block = live[0];
      block.text = text;
      block.box = ink.box;
      block.strokes = ink.strokes;
      // Writing that bridged two notes on the same line folds them into one.
      for (const other of live.slice(1)) {
        removeBlock(tab.notes, other.id);
      }
      status = 'Updated the note for this line';
    } else if (text) {
      block = addBlock(tab.notes, text, page, undefined, ink);
      status = 'Added to notes';
    }
    finish();
    await save(tab);
    if (getActiveTab() === tab) {
      panel.render(tab, tab.page, block ? block.id : null);
    }
    onStatus(status);
  }

  function finish() {
    busy = null;
    busyBlockId = null;
    onBusyChange(false);
    panel.setPending(false);
  }

  // Shows an edit or delete right away; the save happens behind it.
  function changed(tab) {
    if (getActiveTab() === tab) {
      panel.render(tab, tab.page);
    }
    save(tab);
  }

  async function save(tab) {
    try {
      await saveNotes(tab, tab.notesFolder, tab.notes);
    } catch (err) {
      onStatus("Couldn't save notes for " + tab.name + ': ' + err.message, true);
    }
  }

  function markdownFor(tab) {
    return toMarkdown(tab.name, tab.notes || { blocks: [], transcribed: {} }, tab.doc.pageCount);
  }

  function setAuto(isOn) {
    auto = isOn;
  }

  return { attach, show, tick, transcribeNow, setAuto };
}

// Identifies one attempt: which file, which page, how many strokes. A failed attempt isn't
// retried automatically until one of these changes.
function attemptKey(tab, page, strokeCount) {
  return tab.id + ':' + page + ':' + strokeCount;
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

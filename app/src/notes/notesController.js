// Turns handwriting into each file's notes. In auto mode it waits for the pen to pause, sends
// the current page's new strokes to recognition, and adds the text to that file's notes. A
// request that fails isn't retried until the ink changes, so a dead server doesn't turn into a
// request every second.
//
// Clean up also swaps the handwriting on the page for the typed text (cleanUp, from main.js).
// It always runs after the Transcribe button, and after a pause in writing when auto clean up
// is on. Otherwise the ink stays as it was written.

import {
  notesForExistingInk,
  untranscribed,
  markTranscribed,
  markCleanedUp,
  handwritingRestored,
  addBlock,
  editBlock,
  removeBlock,
  contextTail,
  toMarkdown,
  shouldAutoTranscribe,
} from './noteData.js';
import { loadNotes, saveNotes } from './notesStorage.js';
import { strokesToPng } from './strokeImage.js';
import { strokesSignature } from '../ink/inkItems.js';
import { createNotesPanel } from './notesPanel.js';

const CONTEXT_CHARS = 400;

export function createNotesController({ getActiveTab, getFolder, isWriting, lastInkChangeAt, goToPage, recognize, cleanUp, idleMs, onStatus, onBusyChange }) {
  let auto = true;
  let autoCleanUp = false;
  // The tab a request is in flight for, or null.
  let busy = null;
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
    panel.setPending(busy === tab);
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
      auto: auto || autoCleanUp,
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
      run(tab, tab.page, false);
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
    run(tab, tab.page, true);
  }

  async function run(tab, page, manual) {
    const strokes = tab.ink[page] || [];
    const fresh = untranscribed(tab.notes, page, strokes);
    const sentCount = strokes.length;
    const start = sentCount - fresh.length;
    const signature = strokesSignature(fresh);
    const key = attemptKey(tab, page, sentCount);

    busy = tab;
    onBusyChange(true);
    if (getActiveTab() === tab) {
      panel.setPending(true);
    }
    onStatus('Transcribing…');

    let text;
    try {
      text = await recognize(strokesToPng(fresh), contextTail(tab.notes, CONTEXT_CHARS));
    } catch (err) {
      failedKey = key;
      finish();
      onStatus(err.message, true);
      return;
    }

    failedKey = null;
    const cleaned = text !== '' && (manual || autoCleanUp) && cleanUp(tab, page, start, sentCount, signature, text);
    if (cleaned) {
      markCleanedUp(tab.notes, page, start);
    } else {
      markTranscribed(tab.notes, page, sentCount, (tab.ink[page] || []).length);
    }
    const block = text ? addBlock(tab.notes, text, page) : null;
    finish();
    await save(tab);
    if (getActiveTab() === tab) {
      panel.render(tab, tab.page, block ? block.id : null);
    }
    if (cleaned) {
      onStatus('Cleaned up and added to notes. Undo brings the handwriting back');
    } else {
      onStatus(block ? 'Added to notes' : 'No writing found, kept it as ink');
    }
  }

  // Undo of a clean up put the handwriting back. Keep it counted as transcribed.
  function onHandwritingRestored(tab, page, index, restored) {
    if (!tab.notes) {
      return;
    }
    handwritingRestored(tab.notes, page, index, restored);
    save(tab);
  }

  function finish() {
    busy = null;
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

  // Circle to ask: an answer goes in the notes like a transcription, so Export .md becomes a
  // study sheet.
  async function addNote(tab, page, text) {
    if (!tab.notes) {
      return;
    }
    const block = addBlock(tab.notes, text, page);
    await save(tab);
    if (getActiveTab() === tab) {
      panel.render(tab, tab.page, block.id);
    }
  }

  function setAuto(isOn) {
    auto = isOn;
  }

  function setAutoCleanUp(isOn) {
    autoCleanUp = isOn;
  }

  return { attach, show, tick, transcribeNow, addNote, setAuto, setAutoCleanUp, onHandwritingRestored };
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

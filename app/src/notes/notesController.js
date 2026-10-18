// Turns handwriting into each file's notes. In auto mode it waits for the pen to pause, sends
// the current page's new strokes to recognition, and adds the text to that file's notes. The
// ink stays on the page. A request that fails isn't retried until the ink changes, so a dead
// server doesn't turn into a request every second.

import {
  notesForExistingInk,
  untranscribed,
  markTranscribed,
  addBlock,
  editBlock,
  removeBlock,
  contextTail,
  toMarkdown,
  shouldAutoTranscribe,
  contextBefore,
  findBlock,
} from './noteData.js';
import { loadNotes, saveNotes } from './notesStorage.js';
import { strokesToPng } from './strokeImage.js';
import { createNotesPanel } from './notesPanel.js';
import { emptyTutor, worthReviewing, applyFix, resolveIssue, addMessage } from '../tutor/tutorData.js';

const CONTEXT_CHARS = 400;
const TUTOR_CONTEXT_CHARS = 1200;
// A drawing with no words is kept with its note as a thumbnail this size.
const SKETCH_THUMB_SIDE = 480;

// tutor is { review(text, context, seen), ask(text, context, thread, seen) } (tutor/tutorClient.js).
// snapshot(tab, page) resolves to what the tutor can see of that page (tutor/pageSnapshot.js),
// or null when the page isn't the one on screen.
export function createNotesController({ getActiveTab, getFolder, isWriting, lastInkChangeAt, goToPage, recognize, tutor, snapshot, idleMs, onStatus, onBusyChange }) {
  let auto = true;
  // Tutor mode: every new transcription is also checked by the tutor.
  let tutorOn = false;
  // The tab a request is in flight for, or null.
  let busy = null;
  let failedKey = null;

  const panel = createNotesPanel({
    onTutorAskPage: function (text) {
      askPage(text);
    },
    onTutorOpen: function (id) {
      const tab = getActiveTab();
      const block = findBlock(tab.notes, id);
      if (block && !block.tutor) {
        block.tutor = emptyTutor();
        panel.render(tab, tab.page, null, id);
      }
    },
    onTutorAsk: function (id, text) {
      askAbout(getActiveTab(), id, text);
    },
    onTutorFix: function (id, index) {
      const tab = getActiveTab();
      const block = findBlock(tab.notes, id);
      const issue = block && block.tutor && block.tutor.review && block.tutor.review.issues[index];
      if (!issue) {
        return;
      }
      const fixed = applyFix(block.text, issue);
      if (fixed === null) {
        onStatus("That text isn't in the note any more, so there's nothing to replace");
      } else {
        block.text = fixed;
      }
      block.tutor.review = resolveIssue(block.tutor.review, index);
      changed(tab);
    },
    onTutorRetry: function (id) {
      const tab = getActiveTab();
      const block = findBlock(tab.notes, id);
      if (!block || !block.tutor) {
        return;
      }
      const lastStudent = block.tutor.thread.length > 0 && block.tutor.thread[block.tutor.thread.length - 1].role === 'student';
      if (lastStudent) {
        sendThread(tab, block);
      } else {
        reviewBlock(tab, block);
      }
    },
    onTutorDismiss: function (id) {
      const tab = getActiveTab();
      const block = findBlock(tab.notes, id);
      if (block) {
        delete block.tutor;
        changed(tab);
      }
    },
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

  async function run(tab, page) {
    const strokes = tab.ink[page] || [];
    const fresh = untranscribed(tab.notes, page, strokes);
    const sentCount = strokes.length;
    const key = attemptKey(tab, page, sentCount);

    busy = tab;
    onBusyChange(true);
    if (getActiveTab() === tab) {
      panel.setPending(true);
    }
    onStatus('Transcribing…');

    const png = strokesToPng(fresh);
    let text;
    try {
      text = await recognize(png, contextTail(tab.notes, CONTEXT_CHARS));
    } catch (err) {
      failedKey = key;
      finish();
      onStatus(err.message, true);
      return;
    }

    failedKey = null;
    markTranscribed(tab.notes, page, sentCount, (tab.ink[page] || []).length);
    const block = text ? addBlock(tab.notes, text, page) : null;
    finish();
    await save(tab);
    if (getActiveTab() === tab) {
      panel.render(tab, tab.page, block ? block.id : null);
    }
    if (block) {
      onStatus('Added to notes');
      if (tutorOn && worthReviewing(block.text)) {
        reviewBlock(tab, block, png);
      }
    } else if (tutorOn && fresh.length > 0) {
      // No words, but a diagram, a graph, or a question mark on the page is still worth a look.
      // The drawing gets a note of its own, which goes away if the tutor has nothing to say.
      const drawing = addBlock(tab.notes, '', page);
      drawing.sketch = strokesToPng(fresh, SKETCH_THUMB_SIDE);
      onStatus('Tutor is looking at your drawing…');
      reviewBlock(tab, drawing, png);
    } else {
      onStatus('No writing found, kept it as ink');
    }
  }

  // ---- Tutor ----
  //
  // Requests run alongside transcription and each other, one per note. Each keeps the tab and
  // block it started with, so an answer that arrives after switching files still lands on the
  // right note and saves to the right place.

  // sketch is the full-size picture of the new ink, when there is one. A retry has only the
  // note's saved thumbnail, or nothing for written notes, and goes by the text and page.
  async function reviewBlock(tab, block, sketch) {
    block.tutor = Object.assign(block.tutor || emptyTutor(), { pending: true, error: '' });
    showTutor(tab);
    let review;
    try {
      const seen = { sketch: sketch || block.sketch || null, page: await snapshot(tab, block.page) };
      review = await tutor.review(block.text, contextBefore(tab.notes, block.id, TUTOR_CONTEXT_CHARS), seen);
    } catch (err) {
      review = err;
    }
    // Dismissed while the tutor was thinking.
    if (!block.tutor) {
      return;
    }
    block.tutor.pending = false;
    if (review instanceof Error) {
      block.tutor.error = review.message;
    } else {
      block.tutor.review = review;
      // A quiet tutor with nothing else on the card leaves the note as it was. A drawing that
      // only got a note so the tutor could look at it goes away again.
      if (block.tutor.review === null && block.tutor.thread.length === 0) {
        delete block.tutor;
        if (block.text === '') {
          removeBlock(tab.notes, block.id);
          onStatus('No writing found, kept it as ink');
        }
      }
      if (block.tutor && block.tutor.review) {
        onStatus(tutorStatus(block.tutor.review));
      }
    }
    showTutor(tab);
    save(tab);
  }

  // A question typed into "Ask about this page". It becomes a note of its own, marked as asked,
  // with the tutor's answer under it.
  function askPage(text) {
    const tab = getActiveTab();
    if (!tab.notes || text.trim() === '') {
      return;
    }
    const block = addBlock(tab.notes, text.trim(), tab.page);
    block.asked = true;
    block.tutor = emptyTutor();
    addMessage(block.tutor, 'student', block.text);
    sendThread(tab, block);
  }

  function askAbout(tab, id, text) {
    const block = findBlock(tab.notes, id);
    if (!block || text.trim() === '') {
      return;
    }
    block.tutor = block.tutor || emptyTutor();
    if (block.tutor.pending) {
      return;
    }
    addMessage(block.tutor, 'student', text.trim());
    sendThread(tab, block);
  }

  async function sendThread(tab, block) {
    block.tutor.pending = true;
    block.tutor.error = '';
    showTutor(tab);
    const thread = block.tutor.thread;
    let reply;
    try {
      const seen = { sketch: block.sketch || null, page: await snapshot(tab, block.page) };
      reply = await tutor.ask(block.text, contextBefore(tab.notes, block.id, TUTOR_CONTEXT_CHARS), thread, seen);
    } catch (err) {
      reply = err;
    }
    // Dismissed while the tutor was thinking.
    if (!block.tutor) {
      return;
    }
    if (reply instanceof Error) {
      block.tutor.error = reply.message;
    } else {
      addMessage(block.tutor, 'tutor', reply);
    }
    block.tutor.pending = false;
    showTutor(tab);
    save(tab);
  }

  function showTutor(tab) {
    if (getActiveTab() === tab) {
      panel.render(tab, tab.page);
    }
  }

  function tutorStatus(review) {
    if (review.verdict === 'issues') {
      return 'Tutor found ' + review.issues.length + (review.issues.length === 1 ? ' thing' : ' things') + ' to fix';
    }
    if (review.verdict === 'question') {
      return 'Tutor has a question for you';
    }
    if (review.verdict === 'explain') {
      return 'Tutor explained it in your notes';
    }
    return 'Tutor checked it. Looks right';
  }

  function setTutor(isOn) {
    tutorOn = isOn;
    panel.setTutorOn(isOn);
    show(getActiveTab());
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

  function setAuto(isOn) {
    auto = isOn;
  }

  return { attach, show, tick, transcribeNow, setAuto, setTutor };
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

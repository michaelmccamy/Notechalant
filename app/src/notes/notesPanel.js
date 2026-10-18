// The right-hand panel: the open file's notes as typed text. Each block is one transcription.
// Click a block to edit it (Ctrl+Enter or click away saves, Esc cancels). On files with several
// pages, a block's page tag jumps to the page it was written on. A block the tutor has looked at
// gets a tutor card under it: corrections with a button to apply each, a question with quick
// answers, and a box to keep talking.

import { orderedBlocks } from './noteData.js';
import { renderMarkdown, hasMath } from './markdown.js';
import { loadKatex, MATH_OPTIONS } from './katex.js';

const TUTOR_KIND_LABELS = { grammar: 'Grammar', spelling: 'Spelling', math: 'Math', fact: 'Fact', other: 'Note' };

export function createNotesPanel({ onEdit, onDelete, onGoToPage, onCopy, onExport, onTutorOpen, onTutorAsk, onTutorFix, onTutorRetry, onTutorDismiss }) {
  const fileEl = document.getElementById('notes-file');
  const blocksEl = document.getElementById('notes-blocks');
  let pendingEl = null;
  let shown = null;
  let tutorOn = false;
  // What's typed in each tutor card's box, by block id. The panel redraws whenever a note or an
  // answer arrives, and this keeps a half-typed question from being wiped.
  const drafts = new Map();

  document.getElementById('notes-copy').addEventListener('click', onCopy);
  document.getElementById('notes-export').addEventListener('click', onExport);

  // tab.notes is null while its notes are still loading. focusTutorId puts the cursor in that
  // block's tutor box (after "Ask tutor" is clicked).
  function render(tab, currentPage, highlightId, focusTutorId) {
    const focused = document.activeElement;
    const refocusId = focusTutorId || (focused && blocksEl.contains(focused) && focused.dataset.tutorInput) || null;
    shown = { tab, currentPage };
    fileEl.textContent = tab.name;
    fileEl.title = tab.path || tab.name;
    blocksEl.replaceChildren();

    if (!tab.notes) {
      blocksEl.appendChild(paragraph('notes-empty', 'Loading notes…'));
      return;
    }
    const blocks = orderedBlocks(tab.notes);
    if (blocks.length === 0) {
      blocksEl.appendChild(paragraph('notes-empty', 'Write on the page. When you pause, your handwriting is typed up here.'));
      blocksEl.appendChild(paragraph('notes-empty notes-hint', 'Circles, arrows, and underlines stay as ink and are left out.'));
    }
    const multiPage = tab.doc.pageCount > 1;
    for (const block of blocks) {
      const el = renderBlock(block, multiPage);
      el.classList.toggle('on-page', multiPage && block.page === currentPage);
      if (block.id === highlightId) {
        el.classList.add('fresh');
      }
      blocksEl.appendChild(el);
      if (block.tutor) {
        blocksEl.appendChild(renderTutor(block));
      }
    }
    if (pendingEl !== null) {
      blocksEl.appendChild(pendingEl);
    }
    const highlighted = highlightId ? blocksEl.querySelector('.fresh') : null;
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
    if (refocusId) {
      const input = blocksEl.querySelector('[data-tutor-input="' + CSS.escape(refocusId) + '"]');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (focusTutorId) {
          input.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }

  function renderTutor(block) {
    const tutor = block.tutor;
    const review = tutor.review;
    const card = document.createElement('div');
    card.className = 'tutor-card' + (review ? ' verdict-' + review.verdict : '');
    card.setAttribute('aria-label', 'Tutor');

    const head = document.createElement('div');
    head.className = 'tutor-head';
    head.appendChild(span('tutor-label', 'Tutor'));
    if (review) {
      head.appendChild(span('tutor-verdict', { issues: 'Check this', question: 'Question', correct: 'Looks right' }[review.verdict]));
    }
    const dismiss = document.createElement('button');
    dismiss.className = 'tutor-dismiss';
    dismiss.textContent = '×';
    dismiss.title = 'Hide the tutor for this note';
    dismiss.setAttribute('aria-label', 'Hide the tutor for this note');
    dismiss.addEventListener('click', function () {
      drafts.delete(block.id);
      onTutorDismiss(block.id);
    });
    head.appendChild(dismiss);
    card.appendChild(head);

    if (review && review.message) {
      card.appendChild(markdown('tutor-message', review.message));
    }

    if (review && review.issues.length > 0) {
      const list = document.createElement('ul');
      list.className = 'tutor-issues';
      review.issues.forEach(function (issue, index) {
        const item = document.createElement('li');
        const change = document.createElement('div');
        change.className = 'tutor-change';
        change.append(span('tutor-kind', TUTOR_KIND_LABELS[issue.kind]), element('del', issue.wrong), span('tutor-arrow', '→'), element('ins', issue.fix));
        item.appendChild(change);
        if (issue.why) {
          item.appendChild(paragraph('tutor-why', issue.why));
        }
        if (block.text.includes(issue.wrong)) {
          const apply = document.createElement('button');
          apply.className = 'tutor-apply';
          apply.textContent = 'Apply fix';
          apply.addEventListener('click', function () {
            onTutorFix(block.id, index);
          });
          item.appendChild(apply);
        }
        list.appendChild(item);
      });
      card.appendChild(list);
    }

    // Quick answers to the tutor's question, until the conversation starts.
    if (review && review.options.length > 0 && tutor.thread.length === 0 && !tutor.pending) {
      const options = document.createElement('div');
      options.className = 'tutor-options';
      for (const option of review.options) {
        const chip = document.createElement('button');
        chip.className = 'tutor-option';
        chip.textContent = option;
        chip.addEventListener('click', function () {
          onTutorAsk(block.id, option);
        });
        options.appendChild(chip);
      }
      card.appendChild(options);
    }

    for (const message of tutor.thread) {
      if (message.role === 'tutor') {
        card.appendChild(markdown('tutor-msg from-tutor', message.text));
      } else {
        card.appendChild(paragraph('tutor-msg from-student', message.text));
      }
    }

    if (tutor.pending) {
      card.appendChild(paragraph('tutor-pending', review || tutor.thread.length > 0 ? 'Thinking…' : 'Tutor is reading…'));
    }

    if (tutor.error) {
      const error = paragraph('tutor-error', tutor.error + ' ');
      const retry = document.createElement('button');
      retry.className = 'tutor-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', function () {
        onTutorRetry(block.id);
      });
      error.appendChild(retry);
      card.appendChild(error);
    }

    card.appendChild(askForm(block, tutor.pending));
    typeset(card, [review ? review.message : '', ...(review ? review.issues.flatMap((i) => [i.wrong, i.fix, i.why]) : []), ...tutor.thread.map((m) => m.text)].join(' '));
    return card;
  }

  function askForm(block, pending) {
    const form = document.createElement('form');
    form.className = 'tutor-ask';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tutor-input';
    input.placeholder = 'Ask the tutor about this…';
    input.setAttribute('aria-label', 'Ask the tutor about this note');
    input.dataset.tutorInput = block.id;
    input.value = drafts.get(block.id) || '';
    input.addEventListener('input', function () {
      drafts.set(block.id, input.value);
    });
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'tutor-send';
    send.textContent = 'Ask';
    send.disabled = pending;
    form.append(input, send);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (pending || input.value.trim() === '') {
        return;
      }
      const text = input.value;
      drafts.delete(block.id);
      onTutorAsk(block.id, text);
    });
    return form;
  }

  function setTutorOn(isOn) {
    tutorOn = isOn;
  }

  function renderBlock(block, multiPage) {
    const el = document.createElement('div');
    el.className = 'note-block';

    if (multiPage) {
      const pageTag = document.createElement('button');
      pageTag.className = 'note-page';
      pageTag.textContent = 'p. ' + (block.page + 1);
      pageTag.title = 'Go to page ' + (block.page + 1);
      pageTag.addEventListener('click', function () {
        onGoToPage(block.page);
      });
      el.appendChild(pageTag);
    }

    const body = document.createElement('div');
    body.className = 'note-body';
    body.title = 'Click to edit';
    renderMarkdown(block.text, body);
    typeset(body, block.text);
    body.addEventListener('click', function () {
      startEditing(el, body, block);
    });
    el.appendChild(body);

    // In tutor mode, any note can be asked about, not just the ones the tutor spoke up on.
    if (tutorOn && !block.tutor) {
      const ask = document.createElement('button');
      ask.className = 'note-ask';
      ask.textContent = 'Ask tutor';
      ask.title = 'Ask the tutor about this note';
      ask.addEventListener('click', function () {
        onTutorOpen(block.id);
      });
      el.appendChild(ask);
    }

    const remove = document.createElement('button');
    remove.className = 'note-delete';
    remove.textContent = '×';
    remove.title = 'Delete this note';
    remove.setAttribute('aria-label', 'Delete this note');
    remove.addEventListener('click', function () {
      onDelete(block.id);
    });
    el.appendChild(remove);
    return el;
  }

  function startEditing(el, body, block) {
    const editor = document.createElement('textarea');
    editor.className = 'note-editor';
    editor.value = block.text;
    body.replaceWith(editor);
    fitHeight(editor);
    editor.focus();

    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (save && editor.value !== block.text) {
        onEdit(block.id, editor.value);
      } else if (shown !== null) {
        render(shown.tab, shown.currentPage);
      }
    }
    editor.addEventListener('input', function () {
      fitHeight(editor);
    });
    editor.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        finish(false);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        finish(true);
      }
    });
    editor.addEventListener('blur', function () {
      finish(true);
    });
  }

  // A placeholder at the bottom while a transcription for the shown file is in flight.
  function setPending(isPending) {
    if (isPending && pendingEl === null) {
      pendingEl = paragraph('note-block pending', 'Transcribing…');
      blocksEl.appendChild(pendingEl);
      pendingEl.scrollIntoView({ block: 'nearest' });
    } else if (!isPending && pendingEl !== null) {
      pendingEl.remove();
      pendingEl = null;
    }
  }

  return { render, setPending, setTutorOn };
}

// Renders any $...$ math inside `el`, loading KaTeX only if `text` has some.
function typeset(el, text) {
  if (hasMath(text)) {
    loadKatex().then((renderMath) => renderMath(el, MATH_OPTIONS));
  }
}

function markdown(className, text) {
  const el = document.createElement('div');
  el.className = className;
  renderMarkdown(text, el);
  return el;
}

function element(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function span(className, text) {
  const el = element('span', text);
  el.className = className;
  return el;
}

function paragraph(className, text) {
  const el = document.createElement('p');
  el.className = className;
  el.textContent = text;
  return el;
}

function fitHeight(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

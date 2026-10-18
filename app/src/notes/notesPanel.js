// The right-hand panel: the open file's notes as typed text. Each block is one transcription.
// Click a block to edit it (Ctrl+Enter or click away saves, Esc cancels). On files with several
// pages, a block's page tag jumps to the page it was written on.

import { orderedBlocks } from './noteData.js';
import { renderMarkdown, hasMath } from './markdown.js';
import { loadKatex, MATH_OPTIONS } from './katex.js';

export function createNotesPanel({ onEdit, onDelete, onGoToPage, onCopy, onExport }) {
  const fileEl = document.getElementById('notes-file');
  const blocksEl = document.getElementById('notes-blocks');
  let pendingEl = null;
  let shown = null;

  document.getElementById('notes-copy').addEventListener('click', onCopy);
  document.getElementById('notes-export').addEventListener('click', onExport);

  // tab.notes is null while its notes are still loading.
  function render(tab, currentPage, highlightId) {
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
    }
    if (pendingEl !== null) {
      blocksEl.appendChild(pendingEl);
    }
    const highlighted = highlightId ? blocksEl.querySelector('.fresh') : null;
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
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
    if (hasMath(block.text)) {
      loadKatex().then((renderMath) => renderMath(body, MATH_OPTIONS));
    }
    body.addEventListener('click', function () {
      startEditing(el, body, block);
    });
    el.appendChild(body);

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

  return { render, setPending };
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

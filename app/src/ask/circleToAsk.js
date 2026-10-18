// Circle to ask. With Ask on, circling or underlining part of the page captures a picture of
// that region (the document and any ink on it) and shows the answer in a large card next to it,
// readable from across a room. Math renders with KaTeX. A tap on the pad (or a click), Esc, or
// the close button dismisses the card.
//
// Where the answer comes from is up to main.js: explainImage() below for a full walkthrough,
// or the tutor for hints. ask() takes the region and a function that turns the pictures into
// { about, text }.

import { renderMarkdown, hasMath } from '../notes/markdown.js';
import { loadKatex, MATH_OPTIONS } from '../notes/katex.js';

const PADDING = 12; // px of page around the region, so the edges of what was marked aren't cut
const MAX_SIDE = 1200; // the picture is scaled down to this, big enough to read small print
const THUMB_SIDE = 480; // the thumbnail kept with a tutor note
const CARD_GAP = 24;

// handlers: onStatus(text, isError)
export function createCircleToAsk(stageEl, pageEl, handlers) {
  const cardEl = document.getElementById('ask-card');
  const titleEl = document.getElementById('ask-title');
  const bodyEl = document.getElementById('ask-body');
  document.getElementById('ask-close').addEventListener('click', dismiss);
  // Each question gets a number, so a late answer to a dismissed question is dropped.
  let asking = 0;

  function isOpen() {
    return !cardEl.hidden;
  }

  function dismiss() {
    asking++;
    cardEl.hidden = true;
  }

  // box is the marked region in page pixels ({ minX, minY, maxX, maxY }). answer({ image,
  // thumb }) resolves to { about, text }. Resolves to that answer, or null if it failed or the
  // card was dismissed first.
  async function ask(box, answer, loadingText) {
    const id = ++asking;
    showCard(box, loadingText || 'Reading what you marked…', null);
    let pictures;
    try {
      pictures = await capture(box);
    } catch (err) {
      showError(id, "Couldn't capture that part of the page: " + err.message);
      return null;
    }
    let result;
    try {
      result = await answer(pictures);
    } catch (err) {
      showError(id, err.message);
      return null;
    }
    if (id !== asking) {
      return null;
    }
    showCard(box, result.about || 'Answer', result.text);
    return result;
  }

  function showError(id, message) {
    if (id !== asking) {
      return;
    }
    cardEl.hidden = true;
    handlers.onStatus(message, true);
  }

  // The whole page as a picture, the same way Save copy does it, cropped to the region.
  async function capture(box) {
    const htmlToImage = await import('html-to-image');
    const ratio = window.devicePixelRatio || 1;
    const full = await htmlToImage.toCanvas(pageEl, {
      pixelRatio: ratio,
      backgroundColor: '#ffffff',
      // The page sits at an offset in the stage. The picture should start at its corner.
      style: { left: '0', top: '0', margin: '0' },
      filter: function (node) {
        return !(node instanceof HTMLElement) || (node.id !== 'debug-trail' && node.id !== 'ask-card');
      },
    });
    const left = Math.max(0, box.minX - PADDING);
    const top = Math.max(0, box.minY - PADDING);
    const right = Math.min(pageEl.clientWidth, box.maxX + PADDING);
    const bottom = Math.min(pageEl.clientHeight, box.maxY + PADDING);
    const source = [left * ratio, top * ratio, (right - left) * ratio, (bottom - top) * ratio];
    return { image: crop(full, source, MAX_SIDE), thumb: crop(full, source, THUMB_SIDE) };
  }

  function crop(full, [x, y, width, height], maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    out.getContext('2d').drawImage(full, x, y, width, height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  // Next to the region: to its right if there's room, else its left, else over it.
  function showCard(box, title, text) {
    titleEl.replaceChildren();
    renderMarkdown(title, titleEl);
    bodyEl.replaceChildren();
    cardEl.classList.toggle('loading', text === null);
    if (text !== null) {
      renderMarkdown(text, bodyEl);
    }
    cardEl.hidden = false;
    if (hasMath(title + (text || ''))) {
      loadKatex()
        .then(function (renderMath) {
          renderMath(titleEl, MATH_OPTIONS);
          renderMath(bodyEl, MATH_OPTIONS);
          place(box);
        })
        .catch(function () {});
    }
    place(box);
  }

  function place(box) {
    const pageLeft = pageEl.offsetLeft;
    const pageTop = pageEl.offsetTop;
    const width = cardEl.offsetWidth;
    const height = cardEl.offsetHeight;
    const stageWidth = stageEl.clientWidth;
    const stageHeight = stageEl.clientHeight;
    let left = pageLeft + box.maxX + CARD_GAP;
    if (left + width > stageWidth - 16) {
      left = pageLeft + box.minX - CARD_GAP - width;
    }
    if (left < 16) {
      left = Math.max(16, (stageWidth - width) / 2);
    }
    const top = Math.max(16, Math.min(pageTop + box.minY, stageHeight - height - 16));
    cardEl.style.left = left + 'px';
    cardEl.style.top = top + 'px';
  }

  return { ask, capture, isOpen, dismiss };
}

// The full explanation: /api/explain, a step-by-step walkthrough with the answer.
export async function explainImage(image) {
  const response = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: image }),
  });
  const body = await response.json().catch(function () {
    return null;
  });
  if (!response.ok) {
    if (body !== null && body.error) {
      throw new Error(body.error);
    }
    throw new Error(response.status === 404 || response.status >= 500 ? 'Recognition server not reachable. Run npm start in server/' : 'Asking failed (' + response.status + ')');
  }
  return { about: (body.about || '').replace(/\.$/, ''), text: body.text || '' };
}

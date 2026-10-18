// Circle to ask. With Ask on, circling part of the page sends a picture of what's inside the
// loop (the document and any ink on it) to /api/explain, and shows the answer in a large card
// next to the circle, readable from across a room. Math renders with KaTeX. A tap on the pad
// (or a click), Esc, or the close button dismisses the card. ask() resolves to the answer, so
// main.js can add it to the notes.

import { strokeBox } from '../ink/shapes.js';
import { renderMarkdown, hasMath } from '../notes/markdown.js';
import { loadKatex, MATH_OPTIONS } from '../notes/katex.js';

const PADDING = 12; // px of page around the loop, so the edges of what was circled aren't cut
const MAX_SIDE = 1200; // the picture is scaled down to this, big enough to read small print
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

  // stroke is the loop, in page pixels. Resolves to { about, text }, or null if it failed or
  // the card was dismissed first.
  async function ask(stroke) {
    const id = ++asking;
    const box = strokeBox(stroke.points);
    showCard(box, 'Reading what you circled…', null);
    let image;
    try {
      image = await capture(box);
    } catch (err) {
      showError(id, "Couldn't capture that part of the page: " + err.message);
      return null;
    }
    let answer;
    try {
      answer = await requestExplanation(image);
    } catch (err) {
      showError(id, err.message);
      return null;
    }
    if (id !== asking) {
      return null;
    }
    showCard(box, answer.about || 'Answer', answer.text);
    return answer;
  }

  function showError(id, message) {
    if (id !== asking) {
      return;
    }
    cardEl.hidden = true;
    handlers.onStatus(message, true);
  }

  // The whole page as a picture, the same way Save copy does it, cropped to the loop's box.
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
    const width = (right - left) * ratio;
    const height = (bottom - top) * ratio;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(width * scale));
    crop.height = Math.max(1, Math.round(height * scale));
    crop.getContext('2d').drawImage(full, left * ratio, top * ratio, width, height, 0, 0, crop.width, crop.height);
    return crop.toDataURL('image/png');
  }

  async function requestExplanation(image) {
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

  // Next to the loop: to its right if there's room, else its left, else over it.
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

  return { ask, isOpen, dismiss };
}

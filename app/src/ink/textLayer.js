// Typesets clean up's text items over the page, each one sized to fit the box its handwriting
// took up. Sits between the page and the ink canvas, so new writing draws on top of it.
// Markdown goes through renderMarkdown (text only, never HTML) and math through KaTeX.

import { renderMarkdown, hasMath } from '../notes/markdown.js';
import { loadKatex, MATH_OPTIONS } from '../notes/katex.js';

const MEASURE_PX = 100;
const MIN_FONT_PX = 10;
const MAX_FONT_PX = 600;

// The font size that makes text measured at MEASURE_PX fit the box. Fits the height first. The
// width counts as at least half the height, so one thin stroke (an I, a 1) doesn't shrink the
// text to nothing.
export function fitFontSize(measuredWidth, measuredHeight, boxWidth, boxHeight) {
  if (measuredWidth <= 0 || measuredHeight <= 0) {
    return MIN_FONT_PX;
  }
  const byHeight = boxHeight / measuredHeight;
  const byWidth = Math.max(boxWidth, boxHeight * 0.5) / measuredWidth;
  const size = MEASURE_PX * Math.min(byHeight, byWidth);
  return Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, size));
}

export function createTextLayer(layerEl) {
  // Items are in the canvas's CSS pixels, the same as the layer's.
  function render(items) {
    layerEl.replaceChildren();
    for (const item of items) {
      const boxEl = document.createElement('div');
      boxEl.className = 'typed-box';
      boxEl.style.left = item.box.x + 'px';
      boxEl.style.top = item.box.y + 'px';
      boxEl.style.width = item.box.width + 'px';
      boxEl.style.height = item.box.height + 'px';

      const textEl = document.createElement('div');
      textEl.className = 'typed-text';
      textEl.style.color = item.color;
      // Only the item clean up just made fades in, not every item when the page redraws.
      if (item.fresh) {
        textEl.classList.add('fade-in');
        delete item.fresh;
      }
      renderMarkdown(item.text, textEl);
      boxEl.appendChild(textEl);
      layerEl.appendChild(boxEl);

      fit(textEl, item.box);
      if (hasMath(item.text)) {
        loadKatex()
          .then(function (renderMath) {
            renderMath(textEl, MATH_OPTIONS);
            fit(textEl, item.box);
          })
          .catch(function () {
            // Without KaTeX the math stays as its LaTeX text, which still reads.
          });
      }
    }
  }

  function fit(textEl, box) {
    textEl.style.fontSize = MEASURE_PX + 'px';
    textEl.style.fontSize = fitFontSize(textEl.offsetWidth, textEl.offsetHeight, box.width, box.height) + 'px';
  }

  return { render };
}

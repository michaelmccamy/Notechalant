// The center area. Shows one page of the current document, scaled to fit, with the ink canvas
// laid exactly over it. The pen moves inside the page, so one page at a time keeps the writing
// area a fixed size. Page Up and Page Down move between pages.

import { fitPage } from './fileTypes.js';

const MARGIN = 24;
// Small images get scaled up to leave room to write, but not past this.
const MAX_SCALE = 4;

export function createPageView({ onPrev, onNext }) {
  const stage = document.getElementById('stage');
  const pageEl = document.getElementById('page');
  const contentEl = document.getElementById('page-content');
  const messageEl = document.getElementById('page-message');
  const footerName = document.getElementById('page-file');
  const footerCount = document.getElementById('page-count');
  const prevButton = document.getElementById('page-prev');
  const nextButton = document.getElementById('page-next');

  let doc = null;
  let index = 0;
  let scale = 1;

  prevButton.addEventListener('click', onPrev);
  nextButton.addEventListener('click', onNext);

  // Renders page `pageIndex` of `newDoc` and returns the scale from page units to screen pixels.
  function show(newDoc, pageIndex) {
    doc = newDoc;
    index = pageIndex;
    contentEl.replaceChildren();

    const drawable = doc.pageCount > 0;
    pageEl.hidden = !drawable;
    messageEl.hidden = drawable;
    if (drawable) {
      const size = doc.pageSize(index);
      contentEl.style.width = size.width + 'px';
      contentEl.style.height = size.height + 'px';
      doc.renderPage(index, contentEl);
    } else {
      messageEl.querySelector('.page-message-title').textContent = doc.name;
      messageEl.querySelector('.page-message-text').textContent = doc.message;
    }

    footerName.textContent = doc.path || doc.name;
    footerCount.textContent = drawable ? 'Page ' + (index + 1) + ' of ' + doc.pageCount : '';
    prevButton.disabled = !drawable || index === 0;
    nextButton.disabled = !drawable || index >= doc.pageCount - 1;
    return layout();
  }

  // Fits the current page to the stage. Call again whenever the stage changes size.
  function layout() {
    if (doc === null || doc.pageCount === 0) {
      return scale;
    }
    const size = doc.pageSize(index);
    const fit = fitPage(size.width, size.height, stage.clientWidth, stage.clientHeight, MARGIN, MAX_SCALE);
    scale = fit.scale;
    pageEl.style.left = fit.left + 'px';
    pageEl.style.top = fit.top + 'px';
    pageEl.style.width = fit.width + 'px';
    pageEl.style.height = fit.height + 'px';
    contentEl.style.transform = 'scale(' + scale + ')';
    return scale;
  }

  function getScale() {
    return scale;
  }

  return { show, layout, getScale, stage };
}

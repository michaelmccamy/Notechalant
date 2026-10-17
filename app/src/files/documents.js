// Turns a file into pages you can write on. Every document has the same shape:
//
//   { name, path, pageCount, pageSize(i) -> { width, height }, renderPage(i, el), dispose(), message }
//
// Page sizes are in "page units" (pixels at 100% zoom). Ink is saved in page units, so it stays on
// the same spot of the page whatever size the window is. A document with pageCount 0 can't be
// drawn on, and `message` says why.

import { kindOf, looksLikeText, wrapLines, paginate } from './fileTypes.js';

// Text files are laid out on US Letter pages at 96 dpi.
const TEXT_PAGE = { width: 816, height: 1056, padding: 56, fontSize: 15, lineHeight: 22 };
const MONO_FONT = "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const WHITEBOARD = { width: 1600, height: 1000 };

export function createWhiteboard() {
  return {
    name: 'Whiteboard',
    path: null,
    pageCount: 1,
    pageSize: function () {
      return WHITEBOARD;
    },
    renderPage: function () {},
    dispose: function () {},
    message: '',
  };
}

// file is a File (from a FileSystemFileHandle). path is its path inside the opened folder.
export async function openDocument(file, path) {
  const kind = kindOf(file.name);
  if (kind === 'image') {
    return openImage(file, path);
  }
  if (kind === 'pdf') {
    return unsupported(file, path, 'PDF support is coming next.');
  }
  if (kind === 'office') {
    return unsupported(file, path, "Word, PowerPoint, and Excel files can't be shown in the browser. Save it as a PDF and open that.");
  }
  if (file.size > MAX_TEXT_BYTES) {
    return unsupported(file, path, 'This file is too large to open as text.');
  }
  const sample = await file.slice(0, 8192).text();
  if (!looksLikeText(sample)) {
    return unsupported(file, path, "This file type can't be shown.");
  }
  return openText(file, path, await file.text());
}

async function openImage(file, path) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    return unsupported(file, path, "This image couldn't be read.");
  }
  // SVGs without a size report 0 (or a 150px default). Give them a usable page.
  const size = {
    width: img.naturalWidth > 0 ? img.naturalWidth : 1000,
    height: img.naturalHeight > 0 ? img.naturalHeight : 1000,
  };
  return {
    name: file.name,
    path: path,
    pageCount: 1,
    pageSize: function () {
      return size;
    },
    renderPage: function (index, el) {
      const shown = document.createElement('img');
      shown.src = url;
      shown.alt = file.name;
      shown.className = 'page-image';
      shown.draggable = false;
      el.appendChild(shown);
    },
    dispose: function () {
      URL.revokeObjectURL(url);
    },
    message: '',
  };
}

function openText(file, path, text) {
  const usableWidth = TEXT_PAGE.width - TEXT_PAGE.padding * 2;
  const usableHeight = TEXT_PAGE.height - TEXT_PAGE.padding * 2;
  const columns = Math.max(20, Math.floor(usableWidth / charWidth()));
  const linesPerPage = Math.floor(usableHeight / TEXT_PAGE.lineHeight);
  const pages = paginate(wrapLines(text, columns), linesPerPage);

  return {
    name: file.name,
    path: path,
    pageCount: pages.length,
    pageSize: function () {
      return TEXT_PAGE;
    },
    renderPage: function (index, el) {
      const pre = document.createElement('pre');
      pre.className = 'page-text';
      pre.style.padding = TEXT_PAGE.padding + 'px';
      pre.style.font = TEXT_PAGE.fontSize + 'px/' + TEXT_PAGE.lineHeight + 'px ' + MONO_FONT;
      pre.textContent = pages[index].join('\n');
      el.appendChild(pre);
    },
    dispose: function () {},
    message: '',
  };
}

function unsupported(file, path, message) {
  return {
    name: file.name,
    path: path,
    pageCount: 0,
    pageSize: function () {
      return { width: 1, height: 1 };
    },
    renderPage: function () {},
    dispose: function () {},
    message: message,
  };
}

let measuredCharWidth = 0;

// Width of one monospace character at the text page font size, measured once.
function charWidth() {
  if (measuredCharWidth === 0) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = TEXT_PAGE.fontSize + 'px ' + MONO_FONT;
    measuredCharWidth = ctx.measureText('M').width || TEXT_PAGE.fontSize * 0.6;
  }
  return measuredCharWidth;
}

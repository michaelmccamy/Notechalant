// Turns a file into pages you can write on. Every document has the same shape:
//
//   { name, path, pageCount, pageSize(i) -> { width, height }, renderPage(i, el, scale), dispose(), message }
//
// Page sizes are in "page units" (pixels at 100% zoom). Ink is saved in page units, so it stays on
// the same spot of the page whatever size the window is. renderPage draws into `el`, which is
// page-sized in page units, and `scale` is how much it will be shown enlarged or shrunk. A document
// with pageCount 0 can't be drawn on, and `message` says why.

import {
  kindOf,
  looksLikeText,
  wrapLines,
  paginate,
  PDF_POINTS_TO_PAGE_UNITS,
  renderResolution,
} from './fileTypes.js';
import { openDocx, openXlsx, openPptx } from './officeDocuments.js';

const OFFICE_OPENERS = {
  docx: { open: openDocx, label: 'Word document' },
  xlsx: { open: openXlsx, label: 'spreadsheet' },
  pptx: { open: openPptx, label: 'presentation' },
};

// Text files are laid out on US Letter pages at 96 dpi.
const TEXT_PAGE = { width: 816, height: 1056, padding: 56, fontSize: 15, lineHeight: 22 };
const MONO_FONT = "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const WHITEBOARD = { width: 1600, height: 1000 };
// About 64 MB of canvas per rendered PDF page at most.
const MAX_PDF_CANVAS_PIXELS = 16 * 1024 * 1024;

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
    return openPdf(file, path);
  }
  if (OFFICE_OPENERS[kind]) {
    try {
      const doc = await OFFICE_OPENERS[kind].open(file, path);
      return doc.pageCount > 0 ? doc : unsupported(file, path, 'This ' + OFFICE_OPENERS[kind].label + ' is empty.');
    } catch (err) {
      console.warn("Couldn't read " + file.name, err);
      return unsupported(file, path, 'This ' + OFFICE_OPENERS[kind].label + " couldn't be read. Saving it as a PDF and opening that will work.");
    }
  }
  if (kind === 'office') {
    return unsupported(file, path, 'This older file format can\'t be shown. Save it as .docx, .pptx, .xlsx, or PDF and open that.');
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

// PDF.js is about 1.5 MB with its worker, so it only loads the first time a PDF is opened.
let pdfjsPromise = null;

function loadPdfJs() {
  if (pdfjsPromise === null) {
    pdfjsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
      function ([pdfjs, worker]) {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
      },
    );
    // A failed load (offline, say) shouldn't stop the next PDF from trying again.
    pdfjsPromise.catch(function () {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

async function openPdf(file, path) {
  // The loading task is what frees the PDF and its worker memory later (PDF.js 6 has no destroy()
  // on the document itself).
  let loading = null;
  let pdf;
  try {
    const pdfjs = await loadPdfJs();
    loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    pdf = await loading.promise;
  } catch (err) {
    if (loading !== null) {
      loading.destroy();
    }
    if (err.name === 'PasswordException') {
      return unsupported(file, path, 'This PDF is password protected.');
    }
    return unsupported(file, path, "This PDF couldn't be read.");
  }

  // Page sizes up front, since pages in one PDF can differ (a landscape chart in a portrait doc).
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const viewport = (await pdf.getPage(i)).getViewport({ scale: PDF_POINTS_TO_PAGE_UNITS });
    sizes.push({ width: viewport.width, height: viewport.height });
  }

  // Only the latest page request renders. Paging quickly cancels the render still going, and a
  // page that finishes loading after a newer request is skipped.
  let task = null;
  let latest = 0;
  let disposed = false;

  function cancel() {
    latest++;
    if (task !== null) {
      task.cancel();
      task = null;
    }
  }

  return {
    name: file.name,
    path: path,
    pageCount: pdf.numPages,
    pageSize: function (index) {
      return sizes[index];
    },
    renderPage: function (index, el, scale) {
      cancel();
      const request = latest;
      const canvas = document.createElement('canvas');
      canvas.className = 'page-pdf';
      el.appendChild(canvas);
      const size = sizes[index];
      const resolution = renderResolution(size.width, size.height, scale, window.devicePixelRatio, MAX_PDF_CANVAS_PIXELS);

      pdf
        .getPage(index + 1)
        .then(function (page) {
          if (request !== latest) {
            return;
          }
          const viewport = page.getViewport({ scale: PDF_POINTS_TO_PAGE_UNITS * resolution });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const thisTask = page.render({ canvas: canvas, viewport: viewport });
          task = thisTask;
          return thisTask.promise.finally(function () {
            if (task === thisTask) {
              task = null;
            }
          });
        })
        .catch(function (err) {
          if (!disposed && err.name !== 'RenderingCancelledException') {
            console.error('PDF page ' + (index + 1) + ' failed to render', err);
          }
        });
    },
    dispose: function () {
      disposed = true;
      cancel();
      loading.destroy();
    },
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

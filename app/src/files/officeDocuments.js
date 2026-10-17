// Word, Excel, and PowerPoint files, rendered in the browser. Each renderer loads only the first
// time a file of its kind is opened.
//
// Word and Excel render to HTML that can run longer than a page. That HTML is laid out once in a
// hidden measuring area, cut into pages between paragraphs and rows (pageBreaks), and each page
// shows a copy of its slice. PowerPoint slides are pages already, so each slide renders on its own.

import { pageBreaks } from './fileTypes.js';

// Spreadsheets go on landscape letter pages, at least this wide, wider for wide sheets.
const SHEET_MIN_WIDTH = 1056;
const SHEET_PADDING = 40;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLUMNS = 50;

let docxCount = 0;

export async function openDocx(file, path) {
  const { renderAsync } = await import('docx-preview');
  const root = createMeasureRoot();
  // A class name per document, so two open Word files can't restyle each other.
  const className = 'docx' + ++docxCount;
  try {
    await renderAsync(file, root, root, {
      className: className,
      inWrapper: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderChanges: false,
      renderComments: false,
      useBase64URL: true,
    });
    await document.fonts.ready;
  } catch (err) {
    root.remove();
    throw err;
  }

  const pages = [];
  for (const section of root.querySelectorAll('section.' + className)) {
    // docx-preview sets the page size in points ("841.9pt"). The computed style gives pixels.
    const style = getComputedStyle(section);
    const width = section.offsetWidth;
    const height = parseFloat(style.minHeight) || Math.round((width * 11) / 8.5);
    pages.push(...slicePages(section, width, height, parseFloat(style.paddingTop), parseFloat(style.paddingBottom), wordBlocks(section)));
  }
  return slicedDocument(file, path, root, pages);
}

export async function openXlsx(file, path) {
  const { default: readExcelFile } = await import('read-excel-file/browser');
  const sheets = await readExcelFile(file);
  const root = createMeasureRoot();
  const pages = [];

  for (const { sheet, data } of sheets) {
    const section = document.createElement('div');
    section.className = 'sheet-page';
    section.style.padding = SHEET_PADDING + 'px';
    const title = document.createElement('div');
    title.className = 'sheet-title';
    title.textContent = sheet;
    section.append(title, sheetTable(data));
    section.style.width = 'max-content';
    root.appendChild(section);

    // Shrink-wrap first to find how wide the table wants to be, then fix the page width.
    const width = Math.max(SHEET_MIN_WIDTH, Math.ceil(section.offsetWidth));
    section.style.width = width + 'px';
    const height = Math.round((width * 816) / 1056);
    const rows = Array.from(section.querySelectorAll('tr'), (row) => box(row, section));
    // The first row is the column headings. Later pages repeat it, like a printed spreadsheet.
    pages.push(...slicePages(section, width, height, SHEET_PADDING, SHEET_PADDING, rows, rows[0] || null));
  }
  return slicedDocument(file, path, root, pages);
}

export async function openPptx(file, path) {
  const { parseZip, buildPresentation, renderSlide, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer');
  const presentation = buildPresentation(await parseZip(await file.arrayBuffer(), RECOMMENDED_ZIP_LIMITS));
  const size = { width: presentation.width, height: presentation.height };
  let handle = null;

  function release() {
    if (handle !== null) {
      handle.dispose();
      handle = null;
    }
  }

  return {
    name: file.name,
    path: path,
    pageCount: presentation.slides.length,
    pageSize: function () {
      return size;
    },
    renderPage: function (index, el) {
      release();
      handle = renderSlide(presentation, presentation.slides[index], {
        onNodeError: function (nodeId, err) {
          console.warn('Slide ' + (index + 1) + ': part of the slide could not be drawn', nodeId, err);
        },
      });
      el.appendChild(handle.element);
    },
    dispose: release,
    message: '',
  };
}

// Hidden area where documents are laid out and measured. It stays attached while the document
// is open, because Word's generated styles live inside it and the page copies need them.
function createMeasureRoot() {
  const root = document.createElement('div');
  root.className = 'measure-root';
  root.setAttribute('aria-hidden', 'true');
  document.body.appendChild(root);
  return root;
}

// Cuts one tall element into pages. Page 1 shows it from the very top (so a header stays put);
// later pages start at a page break and sit below the top margin. `repeat` ({ top, bottom }, or
// null) is a strip shown again at the top of every later page, such as a table's heading row.
function slicePages(source, width, height, padTop, padBottom, blocks, repeat) {
  const total = source.offsetHeight;
  if (total <= height + 1) {
    return [{ source, width, height, start: 0, end: total, top: 0, repeat: null }];
  }
  const repeatHeight = repeat ? repeat.bottom - repeat.top : 0;
  const starts = pageBreaks(blocks, padTop, height - padTop - padBottom - repeatHeight);
  const contentEnd = total - padBottom;
  return starts.map(function (start, k) {
    const end = k + 1 < starts.length ? starts[k + 1] : contentEnd;
    if (k === 0) {
      return { source, width, height, start: 0, end, top: 0, repeat: null };
    }
    return { source, width, height, start, end, top: padTop + repeatHeight, repeat: repeat };
  });
}

// Shows rows `start` to `end` of `source` at `top` on the page, by clipping a copy of it.
function sliceOf(source, width, start, end, top) {
  const clip = document.createElement('div');
  clip.className = 'page-slice';
  clip.style.top = top + 'px';
  clip.style.width = width + 'px';
  clip.style.height = end - start + 'px';
  const copy = source.cloneNode(true);
  copy.style.position = 'absolute';
  copy.style.left = '0';
  copy.style.top = -start + 'px';
  copy.style.margin = '0';
  clip.appendChild(copy);
  return clip;
}

function slicedDocument(file, path, root, pages) {
  return {
    name: file.name,
    path: path,
    pageCount: pages.length,
    pageSize: function (index) {
      return { width: pages[index].width, height: pages[index].height };
    },
    renderPage: function (index, el) {
      const page = pages[index];
      if (page.repeat) {
        const r = page.repeat;
        el.appendChild(sliceOf(page.source, page.width, r.top, r.bottom, page.top - (r.bottom - r.top)));
      }
      el.appendChild(sliceOf(page.source, page.width, page.start, page.end, page.top));
    },
    dispose: function () {
      root.remove();
    },
    message: '',
  };
}

// The pieces of a Word page that shouldn't be cut: each paragraph, and each table row.
function wordBlocks(section) {
  const blocks = [];
  for (const article of section.querySelectorAll(':scope > article')) {
    for (const child of article.children) {
      const rows = child.tagName === 'TABLE' ? child.querySelectorAll('tr') : [child];
      for (const el of rows) {
        const b = box(el, section);
        if (b.bottom > b.top) blocks.push(b);
      }
    }
  }
  return blocks.sort((a, b) => a.top - b.top);
}

// An element's top and bottom relative to `container`, in layout pixels.
function box(el, container) {
  const outer = container.getBoundingClientRect();
  const inner = el.getBoundingClientRect();
  return { top: inner.top - outer.top, bottom: inner.bottom - outer.top };
}

// Builds the table with textContent only, so nothing in a spreadsheet is ever treated as HTML.
function sheetTable(data) {
  const table = document.createElement('table');
  table.className = 'sheet-table';
  const rows = data.slice(0, MAX_SHEET_ROWS);
  rows.forEach(function (row, r) {
    const tr = document.createElement('tr');
    for (const value of row.slice(0, MAX_SHEET_COLUMNS)) {
      const cell = document.createElement(r === 0 ? 'th' : 'td');
      cell.textContent = formatCell(value);
      if (typeof value === 'number') cell.className = 'num';
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  });
  if (data.length > MAX_SHEET_ROWS) {
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = MAX_SHEET_COLUMNS;
    cell.className = 'sheet-more';
    cell.textContent = data.length - MAX_SHEET_ROWS + ' more rows not shown';
    tr.appendChild(cell);
    table.appendChild(tr);
  }
  return table;
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

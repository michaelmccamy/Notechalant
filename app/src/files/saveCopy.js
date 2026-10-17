// Builds a new file with the ink drawn onto the document. The original file is only read.
//
//   PDF          the original PDF with the ink added to each page as vector strokes
//   image        the image with the ink drawn on, same format (SVG and others become PNG)
//   whiteboard   a PNG
//   everything else with pages (Word, Excel, PowerPoint, text)
//                a PDF with one picture per page, as shown on screen, with the ink on it
//
// pdf-lib and html-to-image load only the first time a copy is saved.

import { drawStroke } from '../ink/inkCanvas.js';
import { copyFormat, pdfViewTransform, invertPoint, strokePath, hexToRgb, PDF_POINTS_TO_PAGE_UNITS } from './fileTypes.js';

// Pages turned into pictures are drawn at twice their size, so text stays readable when zoomed.
const PICTURE_SCALE = 2;
const JPEG_QUALITY = 0.92;

// doc is an open document (documents.js) and ink maps page index to strokes in page units.
// onProgress(done, total) is called as pages finish. Returns { blob, extension }.
export async function buildCopy(doc, ink, onProgress) {
  if (doc.pageCount === 0) {
    throw new Error("This file can't be shown, so there's nothing to save");
  }
  if (doc.file === null) {
    const canvas = blankCanvas(doc.pageSize(0), 1);
    drawInk(canvas, ink[0], 1);
    return { blob: await canvasBlob(canvas, 'image/png'), extension: 'png' };
  }
  const format = copyFormat(doc.name);
  if (doc.kind === 'pdf') {
    return { blob: await inkOnPdf(doc.file, ink, onProgress), extension: 'pdf' };
  }
  if (doc.kind === 'image') {
    const blob = await inkOnImage(doc, ink, format.mime);
    // Browsers that can't write a format (WebP in Safari) quietly make a PNG instead.
    return { blob: blob, extension: blob.type === format.mime ? format.extension : 'png' };
  }
  return { blob: await picturesToPdf(doc, ink, onProgress), extension: 'pdf' };
}

async function inkOnPdf(file, ink, onProgress) {
  const pdfLib = await import('pdf-lib');
  let pdf;
  try {
    pdf = await pdfLib.PDFDocument.load(await file.arrayBuffer());
  } catch (err) {
    if (err.name === 'EncryptedPDFError' || /encrypt/i.test(err.message)) {
      throw new Error('This PDF is protected against changes, so a copy with ink can’t be made');
    }
    throw err;
  }
  const pages = pdf.getPages();
  for (let i = 0; i < pages.length; i++) {
    const strokes = ink[i] || [];
    if (strokes.length > 0) {
      pages[i].pushOperators(...pdfStrokes(pdfLib, pages[i], strokes));
    }
    onProgress(i + 1, pages.length);
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

// The strokes as PDF drawing operators, placed where PDF.js showed them.
function pdfStrokes(pdfLib, page, strokes) {
  const m = pdfViewTransform(visibleBox(page), page.getRotation().angle, PDF_POINTS_TO_PAGE_UNITS);
  const ops = [
    pdfLib.pushGraphicsState(),
    pdfLib.setLineCap(pdfLib.LineCapStyle.Round),
    pdfLib.setLineJoin(pdfLib.LineJoinStyle.Round),
  ];
  for (const stroke of strokes) {
    const color = hexToRgb(stroke.color);
    ops.push(pdfLib.setStrokingRgbColor(color.r, color.g, color.b));
    ops.push(pdfLib.setLineWidth(stroke.width / PDF_POINTS_TO_PAGE_UNITS));
    for (const segment of strokePath(stroke.points)) {
      const p = segment.points.map((point) => invertPoint(m, point.x, point.y));
      if (segment.op === 'move') ops.push(pdfLib.moveTo(p[0].x, p[0].y));
      else if (segment.op === 'line') ops.push(pdfLib.lineTo(p[0].x, p[0].y));
      else ops.push(pdfLib.appendBezierCurve(p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y));
    }
    ops.push(pdfLib.stroke());
  }
  ops.push(pdfLib.popGraphicsState());
  return ops;
}

// What PDF.js shows of a page: the crop box, trimmed to the media box.
function visibleBox(page) {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const box = [
    Math.max(crop.x, media.x),
    Math.max(crop.y, media.y),
    Math.min(crop.x + crop.width, media.x + media.width),
    Math.min(crop.y + crop.height, media.y + media.height),
  ];
  if (box[2] <= box[0] || box[3] <= box[1]) {
    return [media.x, media.y, media.x + media.width, media.y + media.height];
  }
  return box;
}

async function inkOnImage(doc, ink, mime) {
  const size = doc.pageSize(0);
  const url = URL.createObjectURL(doc.file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // JPEG has no transparency, so transparent parts would come out black without a white base.
    const canvas = mime === 'image/jpeg' ? blankCanvas(size, 1) : sizedCanvas(size, 1);
    canvas.getContext('2d').drawImage(img, 0, 0, size.width, size.height);
    drawInk(canvas, ink[0], 1);
    return await canvasBlob(canvas, mime);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function picturesToPdf(doc, ink, onProgress) {
  const [pdfLib, htmlToImage] = await Promise.all([import('pdf-lib'), import('html-to-image')]);
  const pdf = await pdfLib.PDFDocument.create();
  pdf.setTitle(doc.name);
  // The page is drawn off screen while it's turned into a picture. It can't be hidden with
  // visibility or display, because the picture copies those styles and would come out blank.
  const host = document.createElement('div');
  host.className = 'copy-host';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  let fontCss;
  try {
    for (let i = 0; i < doc.pageCount; i++) {
      const size = doc.pageSize(i);
      const pageEl = document.createElement('div');
      pageEl.className = 'copy-page';
      pageEl.style.width = size.width + 'px';
      pageEl.style.height = size.height + 'px';
      host.replaceChildren(pageEl);
      doc.renderPage(i, pageEl, PICTURE_SCALE);
      await imagesLoaded(pageEl);
      // Fonts are gathered once. They're the same for every page and slow to collect.
      if (fontCss === undefined) {
        fontCss = await htmlToImage.getFontEmbedCSS(pageEl).catch(() => '');
      }
      const canvas = await htmlToImage.toCanvas(pageEl, {
        width: size.width,
        height: size.height,
        canvasWidth: size.width,
        canvasHeight: size.height,
        pixelRatio: PICTURE_SCALE,
        backgroundColor: '#ffffff',
        fontEmbedCSS: fontCss,
      });
      // html-to-image shrinks pictures past the browser's canvas limit, so go by the real size.
      drawInk(canvas, ink[i], canvas.width / size.width);
      const jpeg = await pdf.embedJpg(await (await canvasBlob(canvas, 'image/jpeg')).arrayBuffer());
      const width = size.width / PDF_POINTS_TO_PAGE_UNITS;
      const height = size.height / PDF_POINTS_TO_PAGE_UNITS;
      pdf.addPage([width, height]).drawImage(jpeg, { x: 0, y: 0, width: width, height: height });
      onProgress(i + 1, doc.pageCount);
    }
  } finally {
    host.remove();
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

async function imagesLoaded(el) {
  await Promise.all(
    Array.from(el.querySelectorAll('img'), function (img) {
      return img.decode().catch(function () {});
    }),
  );
}

function sizedCanvas(size, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  return canvas;
}

function blankCanvas(size, scale) {
  const canvas = sizedCanvas(size, scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

// Strokes are in page units, and `scale` is canvas pixels per page unit.
function drawInk(canvas, strokes, scale) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const stroke of strokes || []) {
    drawStroke(ctx, stroke);
  }
  ctx.restore();
}

function canvasBlob(canvas, mime) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(
      function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('The page was too large to save as a picture'));
      },
      mime,
      JPEG_QUALITY,
    );
  });
}

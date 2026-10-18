// What the tutor sees of the document: a picture of the page as it's shown, with the student's
// ink drawn on top (so a circled paragraph or an arrow to a figure comes through), plus the
// page's text when the document has it (PDFs and text files).
//
// The picture is taken of the page already on screen, so it needs no extra rendering and works
// the same for PDFs, Word, Excel, PowerPoint, images, and text.

import { drawStroke } from '../ink/inkCanvas.js';

// Big enough to read a page of print, small enough to send quickly (a few hundred KB as JPEG).
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.8;
const MAX_TEXT_CHARS = 6000;

// doc is the open document, index the shown page, contentEl the page element (pageView.content),
// and strokes that page's ink in page units. Returns { image, text, name, number }, or null when
// there's no document to show (the whiteboard) or the picture couldn't be taken.
export async function snapshotPage(doc, index, contentEl, strokes) {
  if (!doc || doc.file === null || doc.pageCount === 0) {
    return null;
  }
  const [image, text] = await Promise.all([pagePicture(doc, index, contentEl, strokes), pageText(doc, index)]);
  if (image === null && text === '') {
    return null;
  }
  return { image: image, text: text, name: doc.name, number: index + 1, pageCount: doc.pageCount };
}

async function pagePicture(doc, index, contentEl, strokes) {
  try {
    const htmlToImage = await import('html-to-image');
    const size = doc.pageSize(index);
    const ratio = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
    const canvas = await htmlToImage.toCanvas(contentEl, {
      width: size.width,
      height: size.height,
      canvasWidth: size.width,
      canvasHeight: size.height,
      pixelRatio: ratio,
      backgroundColor: '#ffffff',
      // The page is shown scaled to fit the window. The picture is of the page at its own size.
      style: { transform: 'none' },
      // Documents use system fonts or carry their own, and fetching web fonts is slow.
      skipFonts: true,
    });
    const scale = canvas.width / size.width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const stroke of strokes || []) {
      drawStroke(ctx, stroke);
    }
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch (err) {
    console.warn("Couldn't take a picture of the page for the tutor", err);
    return null;
  }
}

async function pageText(doc, index) {
  if (typeof doc.pageText !== 'function') {
    return '';
  }
  try {
    return (await doc.pageText(index)).slice(0, MAX_TEXT_CHARS);
  } catch (err) {
    return '';
  }
}

// Owns everything drawn on the canvas.
// A stroke is { color, width, points: [{ x, y }] } in CSS pixels. The list can also hold text
// items from clean up (ink/inkItems.js). The canvas skips those, and options.onTextItems gets
// the current list whenever it changes, so a DOM layer can typeset them.
// Inputs either set an absolute position (mouse) or move the cursor by a delta (pen hardware).

import { isText } from './inkItems.js';

const MIN_POINT_DISTANCE = 1.5;
const CURSOR_RADIUS = 6;
const FADE_MS = 500;

export function createInkCanvas(canvas, options) {
  const ctx = canvas.getContext('2d');
  const onTextItems = (options && options.onTextItems) || function () {};

  let strokes = [];
  let current = null;
  let undoStack = [];

  let color = '#1c1c1a';
  let width = 4;

  const cursor = { x: 0, y: 0, visible: false, down: false };
  let cssWidth = 0;
  let cssHeight = 0;
  let needsRender = true;
  // Goes up every time the ink changes, so callers can tell when there's something to save.
  let revision = 0;
  // Goes up when text items may have come or gone, so the text layer only rebuilds then.
  let textVersion = 0;
  let shownTextVersion = -1;
  // Handwriting fading out after clean up: { strokes, start }.
  let fading = [];
  // Shape snapping (ink/shapes.js) or null. Takes a finished stroke, returns { stroke } or null.
  let snap = null;

  function inkChanged() {
    revision++;
    needsRender = true;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cssWidth = rect.width;
    cssHeight = rect.height;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsRender = true;
  }

  function startStroke(x, y) {
    current = { color: color, width: width, points: [{ x: x, y: y }] };
  }

  function finishStroke() {
    if (current === null) {
      return;
    }
    strokes.push(current);
    undoStack.push({ type: 'stroke' });
    const snapped = snap === null ? null : snap(current);
    if (snapped !== null) {
      // The first Undo puts the stroke back as drawn, the next removes it.
      strokes[strokes.length - 1] = snapped.stroke;
      undoStack.push({ type: 'snap', stroke: snapped.stroke, original: current });
      inkChanged();
    }
    current = null;
  }

  function setSnap(fn) {
    snap = fn;
  }

  // Absolute positioning, used by the mouse and by moveBy.
  function moveTo(x, y, penDown) {
    cursor.x = x;
    cursor.y = y;
    cursor.visible = true;
    cursor.down = penDown;

    if (penDown && current === null) {
      startStroke(x, y);
      inkChanged();
    } else if (!penDown && current !== null) {
      finishStroke();
      inkChanged();
    } else if (penDown) {
      const last = current.points[current.points.length - 1];
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy >= MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) {
        current.points.push({ x: x, y: y });
        inkChanged();
      }
    }
    needsRender = true;
  }

  // Relative positioning, used by the pen. The cursor stays inside the canvas.
  function moveBy(dx, dy, penDown) {
    let x = cursor.x + dx;
    let y = cursor.y + dy;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > cssWidth) x = cssWidth;
    if (y > cssHeight) y = cssHeight;
    moveTo(x, y, penDown);
  }

  // Pointer mode: x and y from -1 to 1 across the page, clamped to it.
  function pointAt(x, y, penDown) {
    const px = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * cssWidth;
    const py = ((Math.max(-1, Math.min(1, y)) + 1) / 2) * cssHeight;
    moveTo(px, py, penDown);
  }

  // Removes up to `count` dots (strokes under 6 px across) from the end, with their undo
  // entries. A double tap to recenter leaves two, and they aren't meant as ink.
  function dropTrailingDots(count) {
    finishStroke();
    for (let i = 0; i < count && strokes.length > 0; i++) {
      const last = strokes[strokes.length - 1];
      const top = undoStack[undoStack.length - 1];
      if (isText(last) || top === undefined || top.type !== 'stroke' || !isDot(last)) {
        break;
      }
      strokes.pop();
      undoStack.pop();
    }
    inkChanged();
  }

  function isDot(stroke) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return maxX - minX < 6 && maxY - minY < 6;
  }

  // A copy, for the debug trail.
  function getCursor() {
    return { x: cursor.x, y: cursor.y, down: cursor.down };
  }

  function centerCursor() {
    finishStroke();
    cursor.x = cssWidth / 2;
    cursor.y = cssHeight / 2;
    cursor.visible = true;
    needsRender = true;
  }

  function hideCursor() {
    cursor.visible = false;
    needsRender = true;
  }

  // Returns what was undone, or null. Undoing a clean up returns { type: 'cleanup', index,
  // restored }: the handwriting is back at `index`, `restored` strokes in place of one item.
  function undo() {
    finishStroke();
    const action = undoStack.pop();
    if (action === undefined) {
      return null;
    }
    let result = { type: action.type };
    if (action.type === 'stroke') {
      strokes.pop();
    } else if (action.type === 'clear') {
      strokes = action.strokes;
      textVersion++;
    } else if (action.type === 'snap') {
      const index = strokes.indexOf(action.stroke);
      if (index === -1) {
        return null;
      }
      strokes[index] = action.original;
    } else if (action.type === 'cleanup') {
      const index = strokes.indexOf(action.item);
      if (index === -1) {
        return null;
      }
      strokes.splice(index, 1, ...action.strokes);
      textVersion++;
      result = { type: 'cleanup', index: index, restored: action.strokes.length };
    }
    inkChanged();
    return result;
  }

  function clear() {
    finishStroke();
    if (strokes.length === 0) {
      return;
    }
    undoStack.push({ type: 'clear', strokes: strokes });
    strokes = [];
    textVersion++;
    inkChanged();
  }

  // Swaps strokes start..end-1 for a text item, fading the handwriting out. Undo brings it back.
  // A stroke being drawn right now isn't in the list yet, so it carries on untouched.
  function replaceWithText(start, end, item) {
    const removed = strokes.splice(start, end - start, item);
    undoStack.push({ type: 'cleanup', item: item, strokes: removed });
    fading.push({ strokes: removed, start: performance.now() });
    textVersion++;
    inkChanged();
  }

  function setColor(newColor) {
    color = newColor;
    needsRender = true;
  }

  function setWidth(newWidth) {
    width = newWidth;
  }

  // Pages and tabs swap stroke lists through these two. Loading strokes doesn't count as
  // a change, so opening a file doesn't trigger a save.
  function getStrokes() {
    return strokes;
  }

  function setStrokes(newStrokes) {
    finishStroke();
    strokes = newStrokes;
    undoStack = [];
    fading = [];
    textVersion++;
    needsRender = true;
  }

  function isEmpty() {
    return strokes.length === 0 && current === null;
  }

  // True while the pen is down. Nothing gets saved or swapped mid-stroke.
  function isWriting() {
    return current !== null;
  }

  function getRevision() {
    return revision;
  }

  function render() {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    for (let i = 0; i < strokes.length; i++) {
      if (!isText(strokes[i])) {
        drawStroke(ctx, strokes[i]);
      }
    }
    drawFading();
    if (current !== null) {
      drawStroke(ctx, current);
    }
    if (cursor.visible) {
      drawCursor();
    }
  }

  function drawFading() {
    const now = performance.now();
    fading = fading.filter(function (f) {
      return now - f.start < FADE_MS;
    });
    for (const f of fading) {
      ctx.globalAlpha = 1 - (now - f.start) / FADE_MS;
      for (const stroke of f.strokes) {
        drawStroke(ctx, stroke);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawCursor() {
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, CURSOR_RADIUS, 0, Math.PI * 2);
    if (cursor.down) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  // White background, ink only, no cursor. This is what recognition sees.
  function toPngDataUrl() {
    finishStroke();
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cssWidth));
    out.height = Math.max(1, Math.round(cssHeight));
    const outCtx = out.getContext('2d');
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, out.width, out.height);
    for (let i = 0; i < strokes.length; i++) {
      if (!isText(strokes[i])) {
        drawStroke(outCtx, strokes[i]);
      }
    }
    return out.toDataURL('image/png');
  }

  function frame() {
    if (needsRender || fading.length > 0) {
      render();
      needsRender = false;
    }
    if (textVersion !== shownTextVersion) {
      shownTextVersion = textVersion;
      onTextItems(strokes.filter(isText));
    }
    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);

  return {
    moveTo,
    moveBy,
    pointAt,
    dropTrailingDots,
    centerCursor,
    getCursor,
    hideCursor,
    undo,
    clear,
    replaceWithText,
    setSnap,
    setColor,
    setWidth,
    getStrokes,
    setStrokes,
    isEmpty,
    isWriting,
    getRevision,
    resize,
    toPngDataUrl,
  };
}

// Draws a smooth curve through the points by using each point as a control
// point and the midpoints between neighbors as the curve's endpoints. Saved copies draw ink
// with this too, so they match the screen.
export function drawStroke(ctx, stroke) {
  const points = stroke.points;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

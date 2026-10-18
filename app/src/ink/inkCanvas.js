// Owns everything drawn on the canvas.
// A stroke is { color, width, points: [{ x, y }] } in CSS pixels. The list can also hold text
// items from clean up (ink/inkItems.js). The canvas skips those, and options.onTextItems gets
// the current list whenever it changes, so a DOM layer can typeset them.
// Inputs either set an absolute position (mouse) or move the cursor by a delta (pen hardware).
//
// In eraser mode, pen down removes every stroke the cursor passes over. Whole strokes go, not
// parts of them, which is forgiving when the air pen wobbles. One pass is one undo step.
// onErase(indices) runs when strokes are removed, with their indices before removal, in order,
// and whatever it returns comes back as onRestore(indices, info) if the erase is undone. The
// notes use these, since they track ink by stroke position.

import { isText } from './inkItems.js';
import { lazyFollow } from './writing.js';

const MIN_POINT_DISTANCE = 1.5;
// Hold to snap: holding the cursor within HOLD_RADIUS px for HOLD_MS with the pen down, on a
// stroke at least HOLD_MIN_PATH px long, asks the hold handler for a clean version of it.
const HOLD_RADIUS = 6;
const HOLD_MS = 600;
const HOLD_MIN_PATH = 15;
const CURSOR_RADIUS = 6;
const FADE_MS = 500;
const ERASER_RADIUS = 12;
// Steps along the path between two eraser positions, so a fast move can't skip over a stroke.
const ERASER_STEP = 4;

export function createInkCanvas(canvas, options) {
  const ctx = canvas.getContext('2d');
  const onTextItems = (options && options.onTextItems) || function () {};
  const onErase = (options && options.onErase) || function () {};
  const onRestore = (options && options.onRestore) || function () {};

  let strokes = [];
  let current = null;
  let undoStack = [];

  let erasing = false;
  // While the eraser is down: the strokes it has touched so far, hidden until pen up.
  let erased = null;
  let lastErase = null;

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
  // Called with each finished stroke, after snapping. Circle to ask listens here.
  let onStrokeFinished = null;
  // Writing mode (ink/writing.js). lazyRadius is the lazy brush's string length in px, 0 for
  // off. While drawing, the ink comes from brush, which trails the cursor. smoother turns a
  // finished stroke's points into smoothed ones, or is null.
  let lazyRadius = 0;
  let brush = null;
  let smoother = null;
  // Hold to snap: takes the stroke being drawn and returns { stroke } with clean points, or null.
  let hold = null;
  let holdAnchor = null;

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
    brush = { x: x, y: y };
    holdAnchor = { x: x, y: y, t: performance.now() };
  }

  // While the pen is down: once the cursor has stayed put for HOLD_MS, the stroke is handed to
  // the hold handler once. If it comes back clean, it's shown that way at once and drawing stops
  // until the pen lifts. heldFrom keeps what was drawn, for Undo.
  function checkHold() {
    if (hold === null || current.held) {
      return;
    }
    const now = performance.now();
    if (Math.hypot(cursor.x - holdAnchor.x, cursor.y - holdAnchor.y) > HOLD_RADIUS) {
      holdAnchor = { x: cursor.x, y: cursor.y, t: now };
      return;
    }
    if (now - holdAnchor.t < HOLD_MS || pathLength(current.points) < HOLD_MIN_PATH) {
      return;
    }
    current.held = true;
    const result = hold(current);
    if (result !== null) {
      current.heldFrom = current.points;
      current.points = result.stroke.points;
      inkChanged();
    }
  }

  function finishStroke() {
    if (current === null) {
      return;
    }
    brush = null;
    holdAnchor = null;
    if (current.heldFrom) {
      // Snapped by holding: kept as is. The first Undo puts back what was drawn.
      const drawn = { color: current.color, width: current.width, points: current.heldFrom };
      const clean = { color: current.color, width: current.width, points: current.points };
      current = null;
      strokes.push(clean);
      undoStack.push({ type: 'stroke' });
      undoStack.push({ type: 'snap', stroke: clean, original: drawn });
      inkChanged();
      if (onStrokeFinished !== null) {
        onStrokeFinished(clean);
      }
      return;
    }
    delete current.held;
    if (smoother !== null) {
      current.points = smoother(current.points);
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
    const finished = strokes[strokes.length - 1];
    current = null;
    if (onStrokeFinished !== null) {
      onStrokeFinished(finished);
    }
  }

  function setStrokeListener(fn) {
    onStrokeFinished = fn;
  }

  function setSnap(fn) {
    snap = fn;
  }

  function setLazyRadius(radius) {
    lazyRadius = radius;
  }

  function setSmoother(fn) {
    smoother = fn;
  }

  function setHold(fn) {
    hold = fn;
  }

  // Absolute positioning, used by the mouse and by moveBy.
  function moveTo(x, y, penDown) {
    cursor.x = x;
    cursor.y = y;
    cursor.visible = true;
    cursor.down = penDown;

    if (erasing) {
      eraseTo(x, y, penDown);
      needsRender = true;
      return;
    }

    if (penDown && current === null) {
      startStroke(x, y);
      inkChanged();
    } else if (!penDown && current !== null) {
      finishStroke();
      inkChanged();
    } else if (penDown && current.heldFrom) {
      // Already snapped by holding: nothing more is drawn until the pen lifts.
    } else if (penDown) {
      checkHold();
      if (current.heldFrom) {
        needsRender = true;
        return;
      }
      if (lazyRadius > 0) {
        brush = lazyFollow(brush, cursor, lazyRadius);
      } else {
        brush = { x: x, y: y };
      }
      const last = current.points[current.points.length - 1];
      const dx = brush.x - last.x;
      const dy = brush.y - last.y;
      if (dx * dx + dy * dy >= MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) {
        current.points.push({ x: brush.x, y: brush.y });
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

  function eraseTo(x, y, penDown) {
    if (!penDown) {
      finishErase();
      return;
    }
    if (erased === null) {
      erased = new Set();
      lastErase = { x: x, y: y };
    }
    const dx = x - lastErase.x;
    const dy = y - lastErase.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / ERASER_STEP));
    for (let s = 1; s <= steps; s++) {
      const px = lastErase.x + (dx * s) / steps;
      const py = lastErase.y + (dy * s) / steps;
      for (const stroke of strokes) {
        const hit = isText(stroke) ? textHit(stroke, px, py, ERASER_RADIUS) : strokeHit(stroke, px, py, ERASER_RADIUS);
        if (!erased.has(stroke) && hit) {
          erased.add(stroke);
          needsRender = true;
        }
      }
    }
    lastErase = { x: x, y: y };
  }

  // Pen up: the touched strokes leave for good, as one undo step.
  function finishErase() {
    if (erased === null) {
      return;
    }
    const touched = erased;
    erased = null;
    lastErase = null;
    if (touched.size === 0) {
      return;
    }
    const removed = [];
    const kept = [];
    strokes.forEach(function (stroke, index) {
      if (touched.has(stroke)) {
        removed.push({ index: index, stroke: stroke });
      } else {
        kept.push(stroke);
      }
    });
    strokes = kept;
    // Clean up's typed words can be erased too. The text layer redraws without them.
    textVersion++;
    const info = onErase(removed.map((r) => r.index));
    undoStack.push({ type: 'erase', removed: removed, info: info });
    inkChanged();
  }

  function setErasing(isOn) {
    finishStroke();
    finishErase();
    erasing = isOn;
    needsRender = true;
  }

  function isErasing() {
    return erasing;
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
    finishErase();
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
    finishErase();
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
    } else if (action.type === 'erase') {
      // Back where they were. Lowest index first, so each lands at its old position.
      strokes = strokes.slice();
      for (const r of action.removed) {
        strokes.splice(r.index, 0, r.stroke);
      }
      textVersion++;
      onRestore(action.removed.map((r) => r.index), action.info);
    }
    inkChanged();
    return result;
  }

  function clear() {
    finishStroke();
    finishErase();
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
    finishErase();
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
    return current !== null || erased !== null;
  }

  function getRevision() {
    return revision;
  }

  function render() {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    for (let i = 0; i < strokes.length; i++) {
      if (!isText(strokes[i]) && (erased === null || !erased.has(strokes[i]))) {
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
    if (erasing) {
      // The eraser: a ring as wide as what it removes, filled while it's down.
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, ERASER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = cursor.down ? 'rgba(86, 97, 90, 0.18)' : 'rgba(255, 255, 255, 0.6)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#56615a';
      ctx.stroke();
      return;
    }
    // With the lazy brush, a faint string from the cursor to where the ink is going down.
    if (cursor.down && brush !== null && lazyRadius > 0) {
      ctx.beginPath();
      ctx.moveTo(brush.x, brush.y);
      ctx.lineTo(cursor.x, cursor.y);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(86, 97, 90, 0.5)';
      ctx.stroke();
    }
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
    setLazyRadius,
    setSmoother,
    setHold,
    setStrokeListener,
    setErasing,
    isErasing,
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

// True when the point is within `radius` of the stroke's line, counting the stroke's own width.
// A typed word from clean up is hit anywhere in its box.
export function textHit(item, x, y, radius) {
  const box = item.box;
  return x >= box.x - radius && x <= box.x + box.width + radius && y >= box.y - radius && y <= box.y + box.height + radius;
}

function pathLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

export function strokeHit(stroke, x, y, radius) {
  const reach = radius + stroke.width / 2;
  const points = stroke.points;
  if (points.length === 1) {
    return Math.hypot(points[0].x - x, points[0].y - y) <= reach;
  }
  for (let i = 1; i < points.length; i++) {
    if (segmentDistance(points[i - 1], points[i], x, y) <= reach) {
      return true;
    }
  }
  return false;
}

function segmentDistance(a, b, x, y) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
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

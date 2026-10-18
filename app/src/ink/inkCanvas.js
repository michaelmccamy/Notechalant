// Owns everything drawn on the canvas.
// A stroke is { color, width, points: [{ x, y }] } in CSS pixels.
// Inputs either set an absolute position (mouse) or move the cursor by a delta (pen hardware).
//
// In eraser mode, pen down removes every stroke the cursor passes over. Whole strokes go, not
// parts of them, which is forgiving when the air pen wobbles. One pass is one undo step.
// onErase(indices) runs when strokes are removed, with their indices before removal, in order,
// and whatever it returns comes back as onRestore(indices, info) if the erase is undone. The
// notes use these, since they track ink by stroke position.

const MIN_POINT_DISTANCE = 1.5;
const CURSOR_RADIUS = 6;
const ERASER_RADIUS = 12;
// Steps along the path between two eraser positions, so a fast move can't skip over a stroke.
const ERASER_STEP = 4;

export function createInkCanvas(canvas, hooks) {
  const ctx = canvas.getContext('2d');
  const onErase = (hooks && hooks.onErase) || function () {};
  const onRestore = (hooks && hooks.onRestore) || function () {};

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
    current = null;
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
        if (!erased.has(stroke) && strokeHit(stroke, px, py, ERASER_RADIUS)) {
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

  function undo() {
    finishStroke();
    finishErase();
    const action = undoStack.pop();
    if (action === undefined) {
      return;
    }
    if (action.type === 'stroke') {
      strokes.pop();
    } else if (action.type === 'clear') {
      strokes = action.strokes;
    } else if (action.type === 'erase') {
      // Back where they were. Lowest index first, so each lands at its old position.
      strokes = strokes.slice();
      for (const r of action.removed) {
        strokes.splice(r.index, 0, r.stroke);
      }
      onRestore(action.removed.map((r) => r.index), action.info);
    }
    inkChanged();
  }

  function clear() {
    finishStroke();
    finishErase();
    if (strokes.length === 0) {
      return;
    }
    undoStack.push({ type: 'clear', strokes: strokes });
    strokes = [];
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
      if (erased === null || !erased.has(strokes[i])) {
        drawStroke(ctx, strokes[i]);
      }
    }
    if (current !== null) {
      drawStroke(ctx, current);
    }
    if (cursor.visible) {
      drawCursor();
    }
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
      drawStroke(outCtx, strokes[i]);
    }
    return out.toDataURL('image/png');
  }

  function frame() {
    if (needsRender) {
      render();
      needsRender = false;
    }
    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);

  return {
    moveTo,
    moveBy,
    centerCursor,
    hideCursor,
    undo,
    clear,
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

// A page's ink is a list of items. Most are handwritten strokes, { color, width, points }.
// Clean up replaces a run of strokes with one text item:
//
//   { type: 'text', text, color, box: { x, y, width, height }, strokes: [the handwriting] }
//
// The text is what recognition read, drawn in the box the handwriting took up. The original
// strokes ride along inside it, so Undo can put them back and saved copies can still draw
// them. No DOM in here, so it all runs under `npm test`.

export function isText(item) {
  return item.type === 'text';
}

// Bounding box of some strokes, widened by half the pen width so thick ink fits inside.
export function strokeBounds(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const pad = stroke.width / 2;
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x - pad);
      minY = Math.min(minY, p.y - pad);
      maxX = Math.max(maxX, p.x + pad);
      maxY = Math.max(maxY, p.y + pad);
    }
  }
  if (minX === Infinity) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function makeTextItem(text, strokes) {
  return {
    type: 'text',
    text: text,
    color: strokes.length > 0 ? strokes[0].color : '#1c1c1a',
    box: strokeBounds(strokes),
    strokes: strokes,
  };
}

// Converts items between page units (saved) and screen pixels (drawn) by a scale factor.
export function scaleItems(items, factor) {
  return items.map(function (item) {
    if (isText(item)) {
      return {
        type: 'text',
        text: item.text,
        color: item.color,
        box: { x: item.box.x * factor, y: item.box.y * factor, width: item.box.width * factor, height: item.box.height * factor },
        strokes: scaleItems(item.strokes, factor),
      };
    }
    return {
      color: item.color,
      width: item.width * factor,
      points: item.points.map(function (p) {
        return { x: p.x * factor, y: p.y * factor };
      }),
    };
  });
}

// Handwriting only, with text items swapped back for the strokes they replaced. Saved copies
// use this, since they draw ink as vector strokes and can't typeset.
export function handwriting(items) {
  const strokes = [];
  for (const item of items) {
    if (isText(item)) {
      strokes.push(...item.strokes);
    } else {
      strokes.push(item);
    }
  }
  return strokes;
}

export function handwritingPages(pages) {
  const out = {};
  for (const index of Object.keys(pages)) {
    out[index] = handwriting(pages[index]);
  }
  return out;
}

// Where a run of strokes starts and ends, to check it's still the same handwriting after a
// recognition request comes back (the user may have undone it, or switched pages and back).
export function strokesSignature(strokes) {
  if (strokes.length === 0 || strokes.some(isText)) {
    return null;
  }
  const first = strokes[0].points[0];
  const lastPoints = strokes[strokes.length - 1].points;
  const last = lastPoints[lastPoints.length - 1];
  return { count: strokes.length, first: { x: first.x, y: first.y }, last: { x: last.x, y: last.y } };
}

export function sameSignature(a, b) {
  const close = function (p, q) {
    return Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
  };
  return a !== null && b !== null && a.count === b.count && close(a.first, b.first) && close(a.last, b.last);
}

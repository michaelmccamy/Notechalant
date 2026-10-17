// Draws strokes (in page units) onto a white PNG cropped to the writing. This is what the
// recognition model sees: just the new handwriting, not the document underneath it.

const PADDING = 24;
// Big pages (a 4000px photo) would make huge images. Shrink anything larger than this.
const MAX_SIDE = 1600;

export function strokesToPng(strokes) {
  const box = boundsOf(strokes);
  const width = box.maxX - box.minX + PADDING * 2;
  const height = box.maxY - box.minY + PADDING * 2;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(PADDING - box.minX, PADDING - box.minY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Always black: light pen colors (yellow, say) are hard for the model to read on white.
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  for (const stroke of strokes) {
    // At least 3 units wide, so thin ink on a large page still reads clearly.
    ctx.lineWidth = Math.max(3, stroke.width);
    const points = stroke.points;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

function boundsOf(strokes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return minX === Infinity ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : { minX, minY, maxX, maxY };
}

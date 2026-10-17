// Mouse, trackpad, or touch acting as a pen. Writes straight to the ink layer.

export function attachMouse(canvas, ink) {
  let drawing = false;

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) {
      return;
    }
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const p = position(event);
    ink.moveTo(p.x, p.y, true);
  });

  canvas.addEventListener('pointermove', function (event) {
    const p = position(event);
    ink.moveTo(p.x, p.y, drawing);
  });

  function stop(event) {
    if (!drawing) {
      return;
    }
    drawing = false;
    const p = position(event);
    ink.moveTo(p.x, p.y, false);
  }

  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
}

// Scrolling line graph on a canvas. The newest sample sits at the right edge and the window
// covers the last windowMs of pen time. Spans where the pen button is down are shaded, so a
// stroke lines up with the gyro that drew it.

export function drawLiveGraph(canvas, samples, series, options) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(canvas);
  const muted = styles.getPropertyValue('--muted').trim() || '#6b6b66';
  const border = styles.getPropertyValue('--border').trim() || '#e3e3df';

  if (samples.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('Waiting for pen data', 8, height / 2);
    return;
  }

  // Scale to the biggest value on screen, never tighter than minRange, so a still pen
  // shows as small noise instead of filling the graph.
  let biggest = options.minRange;
  for (let i = 0; i < samples.length; i++) {
    for (let k = 0; k < series.length; k++) {
      biggest = Math.max(biggest, Math.abs(samples[i][series[k].key]));
    }
  }
  const range = niceCeiling(biggest * 1.1);
  const newest = samples[samples.length - 1].t;
  const x = function (t) {
    return width - ((newest - t) / options.windowMs) * width;
  };
  const y = function (v) {
    return height / 2 - (v / range) * (height / 2 - 4);
  };

  ctx.fillStyle = 'rgba(47, 111, 237, 0.08)';
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].pen === 1) {
      ctx.fillRect(x(samples[i - 1].t), 0, x(samples[i].t) - x(samples[i - 1].t) + 0.5, height);
    }
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(width, y(0));
  ctx.stroke();

  ctx.lineWidth = 1.5;
  for (let k = 0; k < series.length; k++) {
    ctx.strokeStyle = series[k].color;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const px = x(samples[i].t);
      const py = y(samples[i][series[k].key]);
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  ctx.fillStyle = muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('±' + range + ' ' + options.unit, 4, 12);
}

// 1, 2, 5, 10, 20, 50, ... so the scale label stays readable.
function niceCeiling(n) {
  const power = Math.pow(10, Math.floor(Math.log10(n)));
  const steps = [1, 2, 5, 10];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] * power >= n) {
      return steps[i] * power;
    }
  }
  return 10 * power;
}

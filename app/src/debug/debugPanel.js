// Debug mode, toggled with D (or T). Three parts plus the tuning controls:
//   Live view    scrolling gx/gy/gz and dx/dy graphs for the last 5 s, pen state, bias,
//                and a faint cursor trail on the page that shows even with the pen up
//   Axis wizard  hold still, draw a line right, draw a line down, then sets the screen directions
//   Record       saves raw samples, dx/dy, and settings to a .jsonl file (debug/recorder.js)
//
// It sees every hardware input because it wraps the motion module that the input hub calls.
// The inputs themselves and the sample format are untouched.

import { createDebugRecorder, debugFileName } from './recorder.js';
import { drawLiveGraph } from './liveGraph.js';
import { createTuningControls, formatVector } from './tuning.js';

const WINDOW_MS = 5000;
const TRAIL_BREAK_PX = 80; // a longer jump is a recenter, not movement, so the trail breaks there
const GYRO_SERIES = [
  { key: 'gx', color: '#d93025' },
  { key: 'gy', color: '#1f9d55' },
  { key: 'gz', color: '#2f6fed' },
];
const MOVE_SERIES = [
  { key: 'dx', color: '#8e44ad' },
  { key: 'dy', color: '#f29900' },
];
const WIZARD_TEXT = {
  still: 'Step 1 of 3: hold the pen still',
  right: 'Step 2 of 3: draw a line to the right, the way you write',
  down: 'Step 3 of 3: draw a line down, the way you write',
};

// handlers: onRecalibrate(), onStatus(text, isError), getSource() -> active input name or null
export function createDebugPanel(motion, ink, handlers) {
  const panel = document.getElementById('debug');
  const trailCanvas = document.getElementById('debug-trail');
  const gyroCanvas = document.getElementById('debug-gyro');
  const moveCanvas = document.getElementById('debug-move');
  const readoutEl = document.getElementById('debug-readout');
  const biasEl = document.getElementById('debug-bias');
  const upEl = document.getElementById('debug-up');
  const wizardButton = document.getElementById('debug-wizard');
  const wizardText = document.getElementById('debug-wizard-text');
  const wizardBar = document.getElementById('debug-wizard-bar');
  const recordButton = document.getElementById('debug-record');
  const tuning = createTuningControls(motion, handlers);
  const recorder = createDebugRecorder();

  // Last WINDOW_MS of { t, gx, gy, gz, pen, dx, dy }, and of cursor positions for the trail.
  let history = [];
  let trail = [];
  let latest = null;
  let frameRequested = false;
  let wizardRunning = false;
  // Space also draws (input/hub.js), so recordings log it next to the pen's own touch state.
  let spaceDown = false;
  window.addEventListener('keydown', function (event) {
    if (event.code === 'Space') {
      spaceDown = true;
    }
  });
  window.addEventListener('keyup', function (event) {
    if (event.code === 'Space') {
      spaceDown = false;
    }
  });
  window.addEventListener('blur', function () {
    spaceDown = false;
  });

  function onSample(sample, movement) {
    if (history.length > 0 && sample.t < history[history.length - 1].t) {
      // The pen restarted or a recording started over, so the old window no longer lines up.
      history = [];
      trail = [];
    }
    latest = { t: sample.t, gx: sample.gx, gy: sample.gy, gz: sample.gz, pen: sample.pen, dx: movement.dx, dy: movement.dy, ready: movement.ready };
    history.push(latest);
    while (history[0].t < sample.t - WINDOW_MS) {
      history.shift();
    }
    // The hub moves the cursor right after this returns, so this is one sample behind.
    // At 100 Hz that's invisible on a trail.
    const cursor = ink.getCursor();
    trail.push({ t: sample.t, x: cursor.x, y: cursor.y, down: cursor.down });
    while (trail[0].t < sample.t - WINDOW_MS) {
      trail.shift();
    }
    if (recorder.isRecording()) {
      recorder.add(sample, movement, motion.config, motion.getState().bias, spaceDown);
    }
  }

  // What the input hub calls instead of the motion module. Same shape, plus a tap.
  const tapped = {
    update: function (sample, penDown) {
      const movement = motion.update(sample, penDown);
      onSample(sample, movement);
      return movement;
    },
    reset: function () {
      motion.reset();
    },
    recenter: function () {
      motion.recenter();
    },
    getState: motion.getState,
    config: motion.config,
  };

  // ---------- Live view ----------

  function render() {
    frameRequested = false;
    if (panel.hidden) {
      return;
    }
    drawLiveGraph(gyroCanvas, history, GYRO_SERIES, { windowMs: WINDOW_MS, minRange: 20, unit: '°/s' });
    drawLiveGraph(moveCanvas, history, MOVE_SERIES, { windowMs: WINDOW_MS, minRange: 2, unit: 'px' });
    drawTrail();
    showReadout();
    showRecording();
    requestFrame();
  }

  function requestFrame() {
    if (!frameRequested) {
      frameRequested = true;
      requestAnimationFrame(render);
    }
  }

  function showReadout() {
    if (latest === null) {
      readoutEl.textContent = 'Waiting for pen data';
    } else {
      let rate = 0;
      for (let i = history.length - 1; i >= 0 && history[i].t > latest.t - 1000; i--) {
        rate++;
      }
      readoutEl.textContent =
        'Pen ' + (latest.pen === 1 ? 'down' : 'up') +
        '   dx ' + fixed(latest.dx) + '  dy ' + fixed(latest.dy) + ' px' +
        '   ' + rate + '/s';
    }
    const state = motion.getState();
    upEl.textContent = state.up === null ? '' : 'up ' + state.up.map((n) => n.toFixed(2)).join(' ');
    if (state.calibrating) {
      const moved = state.moved ? 'Moved, starting over. ' : '';
      biasEl.textContent = state.progress > 0 || state.moved ? moved + 'Hold still… ' + Math.round(state.progress * 100) + '%' : 'Not calibrated yet';
    } else {
      const b = state.bias;
      biasEl.textContent = 'gx ' + fixed(b.gx) + '  gy ' + fixed(b.gy) + '  gz ' + fixed(b.gz) + ' °/s';
    }
  }

  function drawTrail() {
    const dpr = window.devicePixelRatio || 1;
    const width = trailCanvas.clientWidth;
    const height = trailCanvas.clientHeight;
    if (trailCanvas.width !== Math.round(width * dpr) || trailCanvas.height !== Math.round(height * dpr)) {
      trailCanvas.width = Math.round(width * dpr);
      trailCanvas.height = Math.round(height * dpr);
    }
    const ctx = trailCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) > TRAIL_BREAK_PX) {
        continue;
      }
      // Older parts fade out, and pen up is lighter and thinner than pen down.
      const age = 1 - (latest.t - b.t) / WINDOW_MS;
      ctx.strokeStyle = 'rgba(47, 111, 237, ' + (b.down ? 0.45 : 0.25) * age + ')';
      ctx.lineWidth = b.down ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  document.getElementById('debug-recalibrate').addEventListener('click', function () {
    handlers.onRecalibrate();
  });

  // ---------- Axis wizard ----------

  function onWizard(message) {
    wizardRunning = message.step === 'still' || message.step === 'right' || message.step === 'down';
    wizardButton.textContent = wizardRunning ? 'Cancel' : 'Run axis wizard';
    wizardText.classList.toggle('active', wizardRunning);
    wizardBar.hidden = !wizardRunning;
    if (wizardRunning) {
      wizardText.textContent = WIZARD_TEXT[message.step];
      wizardBar.value = message.progress;
    } else if (message.step === 'done') {
      wizardText.textContent = describeResult(message.result);
      tuning.refresh();
      handlers.onStatus('Axes set from the wizard. Copy JSON to make them the default');
    } else if (message.step === 'failed') {
      wizardText.textContent = message.reason;
    } else {
      wizardText.textContent = 'Cancelled';
    }
  }

  function describeResult(result) {
    return (
      'Right: mostly ' + describeAxis(result.right) + '. Down: mostly ' + describeAxis(result.down) + '. ' +
      'Pen points along [' + formatVector(motion.config.penAxis) + '] for roll compensation. Fixed vectors: right [' +
      formatVector(motion.config.xVector) + '], down [' + formatVector(motion.config.yVector) + '].'
    );
  }

  function describeAxis(measured) {
    const d = measured.dominant;
    return (d.sign < 0 ? '-' : '+') + d.axis + ' (' + Math.round(d.share * 100) + '% of ' + Math.round(measured.degrees) + '°)';
  }

  wizardButton.addEventListener('click', function () {
    if (wizardRunning) {
      motion.cancelAxisWizard();
    } else {
      motion.startAxisWizard(onWizard);
    }
  });

  // ---------- Recording ----------

  function showRecording() {
    if (recorder.isRecording()) {
      const p = recorder.progress();
      recordButton.textContent = 'Stop and save (' + p.seconds.toFixed(1) + ' s)';
    }
  }

  recordButton.addEventListener('click', function () {
    if (!recorder.isRecording()) {
      recorder.start({ source: handlers.getSource(), recordedAt: new Date().toISOString() });
      recordButton.classList.add('recording');
      recordButton.textContent = 'Stop and save (0.0 s)';
      handlers.onStatus('Recording. Click again to save');
      return;
    }
    const samples = recorder.progress().samples;
    const text = recorder.stop();
    recordButton.classList.remove('recording');
    recordButton.textContent = 'Record';
    if (samples === 0) {
      handlers.onStatus('Nothing recorded. Connect the pen or load a recording first', true);
      return;
    }
    const name = debugFileName(new Date());
    download(name, text);
    handlers.onStatus('Saved ' + name + ' (' + samples + ' samples). Put it in data/recordings/debug/');
  });

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ---------- Show and hide ----------

  document.getElementById('debug-close').addEventListener('click', hide);

  function show() {
    panel.hidden = false;
    trailCanvas.hidden = false;
    requestFrame();
  }

  // Recording keeps going while hidden, so hiding the panel to write doesn't lose data.
  function hide() {
    motion.cancelAxisWizard();
    panel.hidden = true;
    trailCanvas.hidden = true;
  }

  function toggle() {
    if (panel.hidden) {
      show();
    } else {
      hide();
    }
  }

  return { motion: tapped, toggle };
}

function fixed(n) {
  return (n >= 0 ? ' ' : '') + n.toFixed(2);
}

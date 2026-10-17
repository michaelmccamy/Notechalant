// Wires the pieces together. Each module does one job.
//
//   serial / wifi / replay  ->  hub.onPenData(sample)  ->  motion.update  ->  ink.moveBy
//   mouse                   ->  ink.moveTo

import { createInkCanvas } from './ink/inkCanvas.js';
import { attachMouse } from './input/mouse.js';
import { createInputHub } from './input/hub.js';
import { parseRecording } from './input/parseSample.js';
import { connectSerial, serialSupported } from './input/serial.js';
import { connectWebSocket } from './input/websocket.js';
import { playRecording } from './input/replay.js';
import { createMotion } from './motion/index.js';
import { createToolbar } from './ui/toolbar.js';
import { recognizeImage } from './recognize.js';

const DEFAULT_WS_URL = 'ws://192.168.4.1:81';
const WS_URL_KEY = 'notechalant.wsUrl';

const canvas = document.getElementById('ink');
const ink = createInkCanvas(canvas);
const motion = createMotion();
const hub = createInputHub({ ink: ink, motion: motion });

attachMouse(canvas, ink);

// Only one hardware source runs at a time. `active` holds its name and how to stop it.
let active = null;

async function stopActive() {
  if (active === null) {
    return;
  }
  const previous = active;
  active = null;
  toolbar.setActiveSource(null);
  liftPen();
  await previous.stop();
}

// Ends any stroke a source left open when it stopped mid-write.
function liftPen() {
  ink.moveBy(0, 0, false);
}

function startSource(name, stop) {
  active = { name: name, stop: stop };
  toolbar.setActiveSource(name);
  hub.recalibrate();
}

// Called when a source stops on its own (cable pulled, replay done). If the user already
// switched to another source, the old one's message is dropped so it can't overwrite the new status.
function sourceEnded(name, message) {
  if (active === null || active.name !== name) {
    return;
  }
  active = null;
  toolbar.setActiveSource(null);
  liftPen();
  toolbar.setStatus(message);
}

const toolbar = createToolbar({
  onColor: function (color) {
    ink.setColor(color);
  },

  onUndo: function () {
    ink.undo();
  },

  onClear: function () {
    ink.clear();
    toolbar.hideResult();
  },

  onRecognize: async function () {
    if (ink.isEmpty()) {
      toolbar.setStatus('Write something first');
      return;
    }
    toolbar.setRecognizing(true);
    try {
      const text = await recognizeImage(ink.toPngDataUrl());
      toolbar.showResult(text);
      toolbar.setStatus('Recognized');
    } catch (err) {
      toolbar.setStatus(err.message, true);
    } finally {
      toolbar.setRecognizing(false);
    }
  },

  onSerial: async function () {
    if (active !== null && active.name === 'serial') {
      await stopActive();
      toolbar.setStatus('USB disconnected');
      return;
    }
    if (!serialSupported()) {
      toolbar.setStatus('USB needs Chrome or Edge', true);
      return;
    }
    await stopActive();
    try {
      const connection = await connectSerial(hub.onPenData, function () {
        sourceEnded('serial', 'USB disconnected');
      });
      startSource('serial', connection.disconnect);
      toolbar.setStatus('USB connected. Hold still to calibrate');
    } catch (err) {
      // Closing the port picker without choosing also lands here.
      toolbar.setStatus(err.message, true);
    }
  },

  onWifi: async function () {
    if (active !== null && active.name === 'wifi') {
      await stopActive();
      toolbar.setStatus('WiFi disconnected');
      return;
    }
    const url = window.prompt('Pen WebSocket address', loadWsUrl());
    if (!url) {
      return;
    }
    saveWsUrl(url);
    await stopActive();
    toolbar.setStatus('Connecting to ' + url);
    let opened = false;
    const connection = connectWebSocket(
      url,
      hub.onPenData,
      function () {
        opened = true;
        toolbar.setStatus('WiFi connected. Hold still to calibrate');
      },
      function () {
        sourceEnded('wifi', opened ? 'WiFi disconnected' : 'Could not reach ' + url);
      },
    );
    startSource('wifi', connection.disconnect);
  },

  isReplaying: function () {
    return active !== null && active.name === 'recording';
  },

  onStopReplay: async function () {
    await stopActive();
    toolbar.setStatus('Replay stopped');
  },

  onRecordingFile: async function (file) {
    const samples = parseRecording(await file.text());
    if (samples.length === 0) {
      toolbar.setStatus('No valid samples in ' + file.name, true);
      return;
    }
    await stopActive();
    const seconds = ((samples[samples.length - 1].t - samples[0].t) / 1000).toFixed(1);
    toolbar.setStatus('Replaying ' + file.name + ' (' + samples.length + ' samples, ' + seconds + 's)');
    const playback = playRecording(samples, hub.onPenData, function () {
      sourceEnded('recording', 'Replay finished');
    });
    startSource('recording', playback.stop);
  },
});

function loadWsUrl() {
  try {
    return localStorage.getItem(WS_URL_KEY) || DEFAULT_WS_URL;
  } catch (err) {
    return DEFAULT_WS_URL;
  }
}

function saveWsUrl(url) {
  try {
    localStorage.setItem(WS_URL_KEY, url);
  } catch (err) {
    // Storage can be blocked. Not worth failing over.
  }
}

// Keyboard shortcuts.
// Space  hold for pen down (stands in for the button)
// Ctrl/Cmd+Z  undo
// C  recenter cursor
// R  recalibrate motion
// Esc  close the result panel
window.addEventListener('keydown', function (event) {
  if (event.target instanceof HTMLInputElement) {
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    hub.setSpacebar(true);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    ink.undo();
  } else if (event.key === 'c' || event.key === 'C') {
    ink.centerCursor();
  } else if (event.key === 'r' || event.key === 'R') {
    hub.recalibrate();
    toolbar.setStatus('Recalibrating. Hold still');
  } else if (event.key === 'Escape') {
    toolbar.hideResult();
  }
});

window.addEventListener('keyup', function (event) {
  if (event.code === 'Space') {
    // Stops Space from also clicking whichever toolbar button has focus.
    event.preventDefault();
    hub.setSpacebar(false);
  }
});

// Losing focus while holding Space would otherwise leave the pen stuck down.
window.addEventListener('blur', function () {
  hub.setSpacebar(false);
});

ink.centerCursor();
ink.hideCursor();

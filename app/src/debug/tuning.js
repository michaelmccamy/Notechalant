// Tuning controls in the debug panel. They edit the motion module's live config, so changes
// apply to whichever input is running (Bluetooth, USB, Relay, WiFi, or a recording) on the
// very next sample. Settings are saved in localStorage, and Copy JSON puts the whole config on
// the clipboard to paste over DEFAULT_CONFIG in motion/index.js.
//
// The axis dropdowns are presets for the motion module's direction vectors: gz with Invert is
// [0, 0, -1]. Vectors from the axis wizard show as "Measured", and Invert is off for them
// because the wizard already gets the signs right.

import { DEFAULT_CONFIG, sanitizeConfig, smoothingToCutoff } from '../motion/index.js';

const STORAGE_KEY = 'notechalant.motion';
// Only the knobs on the panel are saved, so a later change to another default
// (calibration time, say) isn't hidden by an old saved value.
const TUNED_KEYS = ['pixelsPerDegree', 'acceleration', 'drawingGain', 'travelGain', 'rollCompensation', 'penAxis', 'horizontalSign', 'xVector', 'yVector', 'smoothing', 'deadzone'];
const AXIS_NAMES = ['gx', 'gy', 'gz'];

export function loadMotionSettings() {
  try {
    const clean = sanitizeConfig(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    return pickTuned(clean);
  } catch (err) {
    return {};
  }
}

function saveMotionSettings(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pickTuned(config)));
  } catch (err) {
    // Storage can be blocked. The settings still work until the page reloads.
  }
}

// [0, 0, -1] is { axis: 'gz', invert: true }. A measured vector isn't a single axis, so null.
function vectorToAxis(v) {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(v[i]) > 0.999) {
      return { axis: AXIS_NAMES[i], invert: v[i] < 0 };
    }
  }
  return null;
}

function axisToVector(axis, invert) {
  const v = [0, 0, 0];
  v[AXIS_NAMES.indexOf(axis)] = invert ? -1 : 1;
  return v;
}

export function formatVector(v) {
  return v
    .map(function (n) {
      return n.toFixed(2);
    })
    .join(', ');
}

function pickTuned(config) {
  const picked = {};
  for (let i = 0; i < TUNED_KEYS.length; i++) {
    picked[TUNED_KEYS[i]] = config[TUNED_KEYS[i]];
  }
  return picked;
}

// handlers: onStatus(text, isError). refresh() shows and saves changes made elsewhere,
// like the axis wizard's.
export function createTuningControls(motion, handlers) {
  const config = motion.config;
  const sliders = {
    pixelsPerDegree: document.getElementById('tune-sensitivity'),
    smoothing: document.getElementById('tune-smoothing'),
    deadzone: document.getElementById('tune-deadzone'),
    acceleration: document.getElementById('tune-acceleration'),
    drawingGain: document.getElementById('tune-drawing'),
    travelGain: document.getElementById('tune-travel'),
  };
  // One dropdown and one Invert checkbox per screen direction.
  const directions = {
    xVector: { select: document.getElementById('tune-x-axis'), invert: document.getElementById('tune-invert-x') },
    yVector: { select: document.getElementById('tune-y-axis'), invert: document.getElementById('tune-invert-y') },
  };
  const rollInput = document.getElementById('tune-roll');
  const outputs = {
    pixelsPerDegree: document.getElementById('tune-sensitivity-value'),
    smoothing: document.getElementById('tune-smoothing-value'),
    deadzone: document.getElementById('tune-deadzone-value'),
    acceleration: document.getElementById('tune-acceleration-value'),
    drawingGain: document.getElementById('tune-drawing-value'),
    travelGain: document.getElementById('tune-travel-value'),
  };

  Object.assign(config, loadMotionSettings());

  function showValues() {
    Object.keys(sliders).forEach(function (key) {
      sliders[key].value = config[key];
    });
    rollInput.checked = config.rollCompensation;
    Object.keys(directions).forEach(function (key) {
      const d = directions[key];
      const axis = vectorToAxis(config[key]);
      d.select.value = axis === null ? 'measured' : axis.axis;
      d.select.title = 'gx, gy, gz: ' + formatVector(config[key]);
      d.select.options[0].disabled = axis !== null;
      d.invert.checked = axis !== null && axis.invert;
      d.invert.disabled = axis === null;
    });
    outputs.pixelsPerDegree.textContent = config.pixelsPerDegree + ' px/°';
    outputs.smoothing.textContent =
      config.smoothing > 0 ? config.smoothing.toFixed(2) + ' (' + smoothingToCutoff(config.smoothing).toFixed(1) + ' Hz)' : 'off';
    outputs.deadzone.textContent = config.deadzone > 0 ? config.deadzone.toFixed(1) + ' °/s' : 'off';
    outputs.acceleration.textContent = config.acceleration > 0 ? config.acceleration.toFixed(2) : 'off';
    outputs.drawingGain.textContent = '×' + config.drawingGain.toFixed(2);
    outputs.travelGain.textContent = '×' + config.travelGain.toFixed(2);
  }

  function changed() {
    showValues();
    saveMotionSettings(config);
  }

  // Drop focus once a change is done, so Space draws instead of toggling the control again.
  function blurOnChange(el) {
    el.addEventListener('change', function () {
      el.blur();
    });
  }

  Object.keys(sliders).forEach(function (key) {
    sliders[key].addEventListener('input', function () {
      config[key] = Number(sliders[key].value);
      changed();
    });
    blurOnChange(sliders[key]);
  });

  rollInput.addEventListener('input', function () {
    config.rollCompensation = rollInput.checked;
    changed();
  });
  blurOnChange(rollInput);

  Object.keys(directions).forEach(function (key) {
    const d = directions[key];
    function pick() {
      config[key] = axisToVector(d.select.value, d.invert.checked);
      changed();
    }
    d.select.addEventListener('input', pick);
    d.invert.addEventListener('input', pick);
    blurOnChange(d.select);
    blurOnChange(d.invert);
  });

  document.getElementById('tune-copy').addEventListener('click', async function () {
    const text = JSON.stringify(config, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      handlers.onStatus('Motion settings copied as JSON');
    } catch (err) {
      console.log(text);
      handlers.onStatus('Could not copy. Settings printed to the console', true);
    }
  });

  document.getElementById('tune-reset').addEventListener('click', function () {
    Object.assign(config, pickTuned(DEFAULT_CONFIG));
    showValues();
    saveMotionSettings(config);
    handlers.onStatus('Motion settings reset to defaults');
  });

  showValues();

  return { refresh: changed };
}

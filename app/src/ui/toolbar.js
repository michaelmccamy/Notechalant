// Toolbar wiring. Buttons only call the handlers passed in, so the logic stays in main.js.

const COLORS = ['#1c1c1a', '#2f6fed', '#d93025', '#1f9d55', '#f29900'];
const COLOR_NAMES = ['Black', 'Blue', 'Red', 'Green', 'Orange'];

// Buttons hold an icon and a .label span. Changing only the label keeps the icon.
function setLabel(button, text) {
  const label = button.querySelector('.label');
  (label || button).textContent = text;
}

export function createToolbar(handlers) {
  const statusEl = document.getElementById('status');
  const colorsEl = document.getElementById('colors');
  const fileInput = document.getElementById('recording-file');
  const autoInput = document.getElementById('auto-transcribe');
  const relayIndicators = document.getElementById('relay-indicators');
  const relayIndicator = document.getElementById('relay-indicator');
  const penIndicator = document.getElementById('pen-indicator');
  const bluetoothIndicators = document.getElementById('bluetooth-indicators');
  const bluetoothPenIndicator = document.getElementById('bluetooth-pen-indicator');

  const buttons = {
    relay: document.getElementById('connect-relay'),
    bluetooth: document.getElementById('connect-bluetooth'),
    undo: document.getElementById('undo'),
    clear: document.getElementById('clear'),
    saveCopy: document.getElementById('save-copy'),
    transcribe: document.getElementById('transcribe'),
    notes: document.getElementById('toggle-notes'),
    serial: document.getElementById('connect-serial'),
    wifi: document.getElementById('connect-wifi'),
    recording: document.getElementById('load-recording'),
  };

  const swatches = [];
  for (let i = 0; i < COLORS.length; i++) {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    // The stylesheet draws the dot and the selected ring from --ink.
    swatch.style.setProperty('--ink', COLORS[i]);
    swatch.title = COLOR_NAMES[i] + ' pen';
    swatch.setAttribute('aria-label', COLOR_NAMES[i] + ' pen');
    swatch.addEventListener('click', function () {
      selectColor(i);
      handlers.onColor(COLORS[i]);
    });
    colorsEl.appendChild(swatch);
    swatches.push(swatch);
  }

  function selectColor(index) {
    for (let i = 0; i < swatches.length; i++) {
      swatches[i].classList.toggle('selected', i === index);
      swatches[i].setAttribute('aria-pressed', String(i === index));
    }
  }
  selectColor(0);

  buttons.undo.addEventListener('click', handlers.onUndo);
  buttons.clear.addEventListener('click', handlers.onClear);
  buttons.saveCopy.addEventListener('click', handlers.onSaveCopy);
  buttons.transcribe.addEventListener('click', handlers.onTranscribe);
  buttons.notes.addEventListener('click', handlers.onToggleNotes);
  autoInput.addEventListener('change', function () {
    handlers.onAutoChange(autoInput.checked);
  });
  buttons.relay.addEventListener('click', handlers.onRelay);
  buttons.bluetooth.addEventListener('click', handlers.onBluetooth);
  buttons.serial.addEventListener('click', handlers.onSerial);
  buttons.wifi.addEventListener('click', handlers.onWifi);
  buttons.recording.addEventListener('click', function () {
    if (handlers.isReplaying()) {
      handlers.onStopReplay();
    } else {
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', function () {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) {
      handlers.onRecordingFile(file);
    }
  });

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  // source is 'relay', 'bluetooth', 'serial', 'wifi', 'recording', or null.
  // The connection buttons keep their names; the filled one is the source that's on.
  function setActiveSource(source) {
    for (const [name, btn] of [
      ['relay', buttons.relay],
      ['bluetooth', buttons.bluetooth],
      ['serial', buttons.serial],
      ['wifi', buttons.wifi],
    ]) {
      btn.classList.toggle('active', source === name);
      btn.setAttribute('aria-pressed', String(source === name));
    }
    buttons.recording.classList.toggle('active', source === 'recording');
    setLabel(buttons.recording, source === 'recording' ? 'Stop replay' : 'Load recording');
    if (source !== 'relay') {
      relayIndicators.hidden = true;
    }
    if (source !== 'bluetooth') {
      bluetoothIndicators.hidden = true;
    }
  }

  // status is { relay, pens, rate } from connectRelay.
  function setRelayStatus(status) {
    relayIndicators.hidden = false;
    relayIndicator.textContent = status.relay ? 'Relay: connected' : 'Relay: not connected';
    relayIndicator.classList.toggle('ok', status.relay);
    const penOnline = status.relay && status.pens > 0;
    penIndicator.textContent = penOnline ? 'Pen: online, ' + status.rate + '/s' : 'Pen: offline';
    penIndicator.classList.toggle('ok', penOnline);
  }

  // status is { connected, rate } from connectBluetooth.
  function setBluetoothStatus(status) {
    bluetoothIndicators.hidden = false;
    bluetoothPenIndicator.textContent = status.connected ? 'Pen: online, ' + status.rate + '/s' : 'Pen: reconnecting';
    bluetoothPenIndicator.classList.toggle('ok', status.connected);
  }

  function setTranscribing(isBusy) {
    buttons.transcribe.disabled = isBusy;
    setLabel(buttons.transcribe, isBusy ? 'Reading…' : 'Transcribe');
  }

  function setSavingCopy(isBusy) {
    buttons.saveCopy.disabled = isBusy;
    setLabel(buttons.saveCopy, isBusy ? 'Saving…' : 'Save copy');
  }

  function setAuto(isOn) {
    autoInput.checked = isOn;
  }

  function setNotesShown(isShown) {
    buttons.notes.classList.toggle('active', isShown);
    buttons.notes.setAttribute('aria-pressed', String(isShown));
  }

  return { setStatus, setActiveSource, setRelayStatus, setBluetoothStatus, setTranscribing, setSavingCopy, setAuto, setNotesShown, buttons };
}

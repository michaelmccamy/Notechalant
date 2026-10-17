// Toolbar wiring. Buttons only call the handlers passed in, so the logic stays in main.js.

const COLORS = ['#1c1c1a', '#2f6fed', '#d93025', '#1f9d55', '#f29900'];

export function createToolbar(handlers) {
  const statusEl = document.getElementById('status');
  const colorsEl = document.getElementById('colors');
  const fileInput = document.getElementById('recording-file');
  const autoInput = document.getElementById('auto-transcribe');
  const relayIndicators = document.getElementById('relay-indicators');
  const relayIndicator = document.getElementById('relay-indicator');
  const penIndicator = document.getElementById('pen-indicator');

  const buttons = {
    relay: document.getElementById('connect-relay'),
    undo: document.getElementById('undo'),
    clear: document.getElementById('clear'),
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
    swatch.style.background = COLORS[i];
    swatch.title = COLORS[i];
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
    }
  }
  selectColor(0);

  buttons.undo.addEventListener('click', handlers.onUndo);
  buttons.clear.addEventListener('click', handlers.onClear);
  buttons.transcribe.addEventListener('click', handlers.onTranscribe);
  buttons.notes.addEventListener('click', handlers.onToggleNotes);
  autoInput.addEventListener('change', function () {
    handlers.onAutoChange(autoInput.checked);
  });
  buttons.relay.addEventListener('click', handlers.onRelay);
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

  // source is 'relay', 'serial', 'wifi', 'recording', or null.
  function setActiveSource(source) {
    buttons.relay.classList.toggle('active', source === 'relay');
    buttons.serial.classList.toggle('active', source === 'serial');
    buttons.wifi.classList.toggle('active', source === 'wifi');
    buttons.recording.classList.toggle('active', source === 'recording');
    buttons.relay.textContent = source === 'relay' ? 'Relay on' : 'Relay';
    buttons.serial.textContent = source === 'serial' ? 'USB on' : 'USB';
    buttons.wifi.textContent = source === 'wifi' ? 'WiFi on' : 'WiFi';
    buttons.recording.textContent = source === 'recording' ? 'Stop replay' : 'Load recording';
    if (source !== 'relay') {
      relayIndicators.hidden = true;
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

  function setTranscribing(isBusy) {
    buttons.transcribe.disabled = isBusy;
    buttons.transcribe.textContent = isBusy ? 'Reading…' : 'Transcribe';
  }

  function setAuto(isOn) {
    autoInput.checked = isOn;
  }

  function setNotesShown(isShown) {
    buttons.notes.classList.toggle('active', isShown);
    buttons.notes.setAttribute('aria-pressed', String(isShown));
  }

  return { setStatus, setActiveSource, setRelayStatus, setTranscribing, setAuto, setNotesShown, buttons };
}

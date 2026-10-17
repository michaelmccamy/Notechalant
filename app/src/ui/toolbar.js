// Toolbar wiring. Buttons only call the handlers passed in, so the logic stays in main.js.

const COLORS = ['#1c1c1a', '#2f6fed', '#d93025', '#1f9d55', '#f29900'];

export function createToolbar(handlers) {
  const statusEl = document.getElementById('status');
  const colorsEl = document.getElementById('colors');
  const fileInput = document.getElementById('recording-file');
  const resultEl = document.getElementById('result');
  const resultText = document.getElementById('result-text');

  const buttons = {
    undo: document.getElementById('undo'),
    clear: document.getElementById('clear'),
    recognize: document.getElementById('recognize'),
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
  buttons.recognize.addEventListener('click', handlers.onRecognize);
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

  document.getElementById('result-close').addEventListener('click', hideResult);

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  // source is 'serial', 'wifi', 'recording', or null.
  function setActiveSource(source) {
    buttons.serial.classList.toggle('active', source === 'serial');
    buttons.wifi.classList.toggle('active', source === 'wifi');
    buttons.recording.classList.toggle('active', source === 'recording');
    buttons.serial.textContent = source === 'serial' ? 'USB on' : 'USB';
    buttons.wifi.textContent = source === 'wifi' ? 'WiFi on' : 'WiFi';
    buttons.recording.textContent = source === 'recording' ? 'Stop replay' : 'Load recording';
  }

  function setRecognizing(isBusy) {
    buttons.recognize.disabled = isBusy;
    buttons.recognize.textContent = isBusy ? 'Reading…' : 'Recognize';
  }

  function showResult(text) {
    resultText.textContent = text;
    resultEl.hidden = false;
  }

  function hideResult() {
    resultEl.hidden = true;
  }

  return { setStatus, setActiveSource, setRecognizing, showResult, hideResult, buttons };
}

// Wires the pieces together. Each module does one job.
//
//   relay / bluetooth / serial / wifi / replay  ->  hub.onPenData(sample)  ->  motion.update  ->  ink.moveBy
//   mouse                   ->  ink.moveTo
//   explorer / tabs         ->  openDocument  ->  pageView (one page, ink canvas on top)
//   ink changes             ->  captureInk (page units)  ->  saved to .notechalant/ in the folder
//   pen pauses              ->  notes controller  ->  recognize new strokes  ->  that file's notes
//   Save copy               ->  buildCopy (document + ink)  ->  new file next to the original

import { createInkCanvas } from './ink/inkCanvas.js';
import { attachMouse } from './input/mouse.js';
import { createInputHub } from './input/hub.js';
import { parseRecording } from './input/parseSample.js';
import { connectSerial, serialSupported } from './input/serial.js';
import { connectWebSocket } from './input/websocket.js';
import { connectRelay, RELAY_URL } from './input/relay.js';
import { bluetoothSupported, connectBluetooth, requestPen } from './input/bluetooth.js';
import { playRecording } from './input/replay.js';
import { createMotion } from './motion/index.js';
import { createToolbar } from './ui/toolbar.js';
import { recognizeImage } from './recognize.js';
import { createNotesController } from './notes/notesController.js';
import { createWhiteboard, openDocument } from './files/documents.js';
import { createPageView } from './files/pageView.js';
import { createExplorer } from './files/explorer.js';
import { createTabs } from './files/tabs.js';
import { buildCopy } from './files/saveCopy.js';
import {
  foldersSupported,
  pickFolder,
  lastFolder,
  folderFromHandle,
  looseInkKey,
  loadLooseInk,
  saveLooseInk,
  saveCopyAs,
} from './files/folder.js';
import { scaleStrokes, packInk, unpackInk, copyName, OPENABLE_EXTENSIONS } from './files/fileTypes.js';

const DEFAULT_WS_URL = 'ws://192.168.4.1:81';
const WS_URL_KEY = 'notechalant.wsUrl';
const WHITEBOARD_KEY = 'notechalant.whiteboard';
// Ink is saved this long after the last change, so a burst of writing becomes one save.
const SAVE_DELAY_MS = 800;
const TICK_MS = 250;
// How long the pen has to stay still before new writing is typed up.
const TRANSCRIBE_IDLE_MS = 2000;
const AUTO_KEY = 'notechalant.autoTranscribe';
const NOTES_SHOWN_KEY = 'notechalant.notesShown';

const canvas = document.getElementById('ink');
const ink = createInkCanvas(canvas);
const motion = createMotion();
const hub = createInputHub({ ink: ink, motion: motion });

attachMouse(canvas, ink);

// ---- Files and tabs ----
//
// A tab is { id, name, path, looseKey, doc, page, ink, dirty }. `ink` maps page index to strokes
// in page units. The canvas holds the current page's strokes in screen pixels; captureInk copies
// them back into the tab whenever they change. Ink saves to wherever the tab came from:
//   folder file   path is set, ink goes to .notechalant/ in the folder
//   single file   looseKey is set (Open File or dropped in), ink goes to this browser
//   whiteboard    always open, ink goes to this browser, so the app works with nothing opened

const whiteboard = {
  id: 'whiteboard',
  name: 'Whiteboard',
  path: null,
  looseKey: null,
  doc: createWhiteboard(),
  page: 0,
  ink: loadWhiteboard(),
  dirty: false,
  notes: null,
};
let tabs = [whiteboard];
let activeTab = whiteboard;
let folder = null;
let rememberedFolder = null;
// Starts equal to the canvas, so the empty canvas at startup isn't mistaken for new ink.
let capturedRevision = ink.getRevision();
let lastInkChangeAt = 0;
// Saves run one after another, so a folder switch can't skip a save that's already running.
let saveQueue = Promise.resolve();
let saving = false;
// Paths being opened right now, so a double click doesn't open two tabs.
const opening = new Set();

const saveStateEl = document.getElementById('save-state');

const pageView = createPageView({
  onPrev: function () {
    goToPage(activeTab.page - 1);
  },
  onNext: function () {
    goToPage(activeTab.page + 1);
  },
});

const tabStrip = createTabs({
  onSelect: function (id) {
    activate(tabs.find((tab) => tab.id === id));
  },
  onClose: closeTab,
});

const explorer = createExplorer({
  onOpenFolder: openFolder,
  onReopen: reopenFolder,
  onRefresh: function () {
    if (folder !== null) {
      explorer.showFolder(folder);
    }
  },
  onOpenFile: openFile,
  onPickFiles: function () {
    fileInput.click();
  },
});

const fileInput = document.getElementById('open-file-input');
fileInput.accept = OPENABLE_EXTENSIONS.map((ext) => '.' + ext).join(',');
fileInput.addEventListener('change', function () {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  openLooseFiles(files);
});

// Each tab's typed notes, in the panel on the right.
const notes = createNotesController({
  getActiveTab: function () {
    return activeTab;
  },
  getFolder: function () {
    return folder;
  },
  isWriting: function () {
    return ink.isWriting();
  },
  lastInkChangeAt: function () {
    return lastInkChangeAt;
  },
  goToPage: goToPage,
  recognize: recognizeImage,
  idleMs: TRANSCRIBE_IDLE_MS,
  onStatus: function (text, isError) {
    toolbar.setStatus(text, isError);
  },
  onBusyChange: function (isBusy) {
    toolbar.setTranscribing(isBusy);
  },
});

function showNotes(isShown) {
  document.body.classList.toggle('notes-hidden', !isShown);
  toolbar.setNotesShown(isShown);
  saveSetting(NOTES_SHOWN_KEY, isShown ? 'on' : 'off');
}

// Copies the canvas strokes into the active tab if they changed since last time.
function captureInk() {
  const revision = ink.getRevision();
  if (revision === capturedRevision) {
    return;
  }
  capturedRevision = revision;
  activeTab.ink[activeTab.page] = scaleStrokes(ink.getStrokes(), 1 / pageView.getScale());
  activeTab.dirty = true;
  lastInkChangeAt = performance.now();
}

// Draws the active tab's current page and puts its ink on the canvas.
function showPage() {
  // Notebook lines on the whiteboard only. Real documents stay plain white. Set here rather than
  // in activate() so closing a tab that falls back to the whiteboard gets its lines too.
  document.getElementById('page').classList.toggle('whiteboard', activeTab === whiteboard);
  const scale = pageView.show(activeTab.doc, activeTab.page);
  placeInk(scale);
}

function placeInk(scale) {
  ink.resize();
  ink.setStrokes(scaleStrokes(activeTab.ink[activeTab.page] || [], scale));
  capturedRevision = ink.getRevision();
}

function activate(tab) {
  captureInk();
  activeTab = tab;
  renderTabs();
  explorer.setActive(tab.path);
  showPage();
  notes.show(tab);
}

function goToPage(index) {
  if (index < 0 || index >= activeTab.doc.pageCount || index === activeTab.page) {
    return;
  }
  captureInk();
  activeTab.page = index;
  showPage();
  notes.show(activeTab);
}

function renderTabs() {
  tabStrip.render(
    tabs.map(function (tab) {
      return { id: tab.id, name: tab.name, title: tabTitle(tab), closable: tab !== whiteboard };
    }),
    activeTab.id,
  );
}

function tabTitle(tab) {
  if (tab.path) return tab.path;
  if (tab.looseKey) return tab.name + ' (not in a folder, ink saved in this browser)';
  return 'Whiteboard, saved in this browser';
}

function addTab(tab) {
  tab.notes = null;
  notes.attach(tab);
  tabs.splice(tabs.indexOf(activeTab) + 1, 0, tab);
  activate(tab);
  const doc = tab.doc;
  toolbar.setStatus(doc.pageCount > 1 ? 'Opened ' + doc.name + '. Page Up and Page Down change pages' : 'Opened ' + doc.name);
}

// Files opened on their own: from Open File, or dropped onto the page.
async function openLooseFiles(files) {
  for (const file of files) {
    await openLooseFile(file);
  }
}

async function openLooseFile(file) {
  const key = looseInkKey(file);
  const id = 'loose:' + key;
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) {
    activate(existing);
    return;
  }
  if (opening.has(id)) {
    return;
  }
  opening.add(id);
  toolbar.setStatus('Opening ' + file.name + '…');
  try {
    const doc = await openDocument(file, null);
    const savedInk = await loadLooseInk(key);
    addTab({ id: id, name: doc.name, path: null, looseKey: key, doc: doc, page: 0, ink: savedInk, dirty: false });
  } catch (err) {
    toolbar.setStatus("Couldn't open " + file.name + ': ' + err.message, true);
  } finally {
    opening.delete(id);
  }
}

async function openFile(handle, path) {
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) {
    activate(existing);
    return;
  }
  if (opening.has(path)) {
    return;
  }
  opening.add(path);
  const openedFrom = folder;
  toolbar.setStatus('Opening ' + path + '…');
  try {
    const doc = await openDocument(await handle.getFile(), path);
    const savedInk = await openedFrom.loadInk(path);
    if (folder !== openedFrom) {
      doc.dispose();
      return;
    }
    addTab({ id: 'file:' + path, name: doc.name, path: path, looseKey: null, doc: doc, page: 0, ink: savedInk, dirty: false });
  } catch (err) {
    toolbar.setStatus("Couldn't open " + path + ': ' + err.message, true);
  } finally {
    opening.delete(path);
  }
}

async function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab === whiteboard) {
    return;
  }
  if (tab === activeTab) {
    captureInk();
  }
  if (tab.dirty) {
    await saveTab(tab);
  }
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  tab.doc.dispose();
  if (tab === activeTab) {
    activeTab = tabs[Math.min(index, tabs.length - 1)];
    explorer.setActive(activeTab.path);
    showPage();
    notes.show(activeTab);
  }
  renderTabs();
}

async function openFolder() {
  try {
    await useFolder(await pickFolder());
  } catch (err) {
    if (err.name !== 'AbortError') {
      toolbar.setStatus("Couldn't open the folder: " + err.message, true);
    }
  }
}

async function reopenFolder() {
  if (rememberedFolder === null) {
    return;
  }
  try {
    await useFolder(await rememberedFolder.open());
  } catch (err) {
    toolbar.setStatus(err.message, true);
  }
}

// Switching folders saves and closes the old folder's tabs. The whiteboard and single files stay.
async function useFolder(newFolder) {
  captureInk();
  await saveDirty();
  const stayOpen = tabs.filter((tab) => tab.path === null);
  for (const tab of tabs) {
    if (!stayOpen.includes(tab)) {
      tab.doc.dispose();
    }
  }
  tabs = stayOpen;
  folder = newFolder;
  await explorer.showFolder(folder);
  activate(stayOpen.includes(activeTab) ? activeTab : whiteboard);
  toolbar.setStatus('Opened ' + folder.name + '. Pick a file to write on');
}

async function saveTab(tab) {
  tab.dirty = false;
  try {
    if (tab === whiteboard) {
      localStorage.setItem(WHITEBOARD_KEY, JSON.stringify(packInk(null, tab.ink)));
      showSaveState('Saved in browser', false);
    } else if (tab.looseKey) {
      await saveLooseInk(tab.looseKey, tab.name, tab.ink);
      showSaveState('Saved in browser', false);
    } else {
      showSaveState('Saving…', false);
      await folder.saveInk(tab.path, tab.ink);
      showSaveState('Saved', false);
    }
  } catch (err) {
    // Not retried until the ink changes again, so a read-only folder doesn't spam errors.
    showSaveState('Not saved', true);
    toolbar.setStatus("Couldn't save ink for " + (tab.path || tab.name) + ': ' + err.message, true);
  }
}

// Writes a new file with the active tab's ink drawn on it. A folder file's copy goes next to it
// in the folder. A single file or the whiteboard asks where to save, since there's no folder.
// The original is never written to.
let savingCopy = false;

async function saveCopy() {
  if (savingCopy) {
    return;
  }
  captureInk();
  const tab = activeTab;
  const tabFolder = folder;
  if (tab.doc.pageCount === 0) {
    toolbar.setStatus("This file can't be shown, so there's nothing to save", true);
    return;
  }
  if (!Object.values(tab.ink).some((strokes) => strokes.length > 0)) {
    toolbar.setStatus('Write something first');
    return;
  }
  savingCopy = true;
  toolbar.setSavingCopy(true);
  toolbar.setStatus('Saving a copy of ' + tab.name + '…');
  try {
    const copy = await buildCopy(tab.doc, tab.ink, function (done, total) {
      if (total > 1) {
        toolbar.setStatus('Saving a copy of ' + tab.name + ': page ' + done + ' of ' + total + '…');
      }
    });
    if (tab.path !== null) {
      // The folder the file came from, even if another one was opened while the copy was made.
      const savedPath = await tabFolder.saveCopy(tab.path, copy.blob, copy.extension);
      toolbar.setStatus('Saved ' + savedPath + ' in ' + tabFolder.name + '. The original is unchanged');
      if (folder === tabFolder) {
        await explorer.showFolder(folder);
        explorer.setActive(activeTab.path);
      }
    } else {
      const originalName = tab.doc.file ? tab.doc.file.name : null;
      const savedName = await saveCopyAs(copyName(tab.name, copy.extension, () => false), copy.blob, copy.extension, originalName);
      toolbar.setStatus(savedName === null ? 'Copy not saved' : 'Saved ' + savedName + '. The original is unchanged');
    }
  } catch (err) {
    toolbar.setStatus("Couldn't save a copy of " + tab.name + ': ' + err.message, true);
  } finally {
    savingCopy = false;
    toolbar.setSavingCopy(false);
    // A presentation shows one slide at a time, and saving drew every slide, so put the shown one back.
    if (tab === activeTab && tab.doc.kind === 'pptx') {
      captureInk();
      showPage();
    }
  }
}

function saveDirty() {
  saving = true;
  saveQueue = saveQueue.then(async function () {
    for (const tab of tabs.slice()) {
      if (tab.dirty) {
        await saveTab(tab);
      }
    }
    saving = false;
  });
  return saveQueue;
}

function showSaveState(text, isError) {
  saveStateEl.textContent = text;
  saveStateEl.classList.toggle('error', isError);
}

function loadWhiteboard() {
  try {
    return unpackInk(JSON.parse(localStorage.getItem(WHITEBOARD_KEY)));
  } catch (err) {
    return {};
  }
}

// Drag and drop: a file opens on its own, a folder opens in the explorer.
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;

function draggingFiles(event) {
  return event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
}

window.addEventListener('dragenter', function (event) {
  if (draggingFiles(event)) {
    dragDepth++;
    dropOverlay.hidden = false;
  }
});

window.addEventListener('dragleave', function (event) {
  if (draggingFiles(event) && --dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});

window.addEventListener('dragover', function (event) {
  if (draggingFiles(event)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
});

window.addEventListener('drop', function (event) {
  if (!draggingFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  // The dropped items stop being readable once this handler returns, so grab them all now.
  const entries = Array.from(event.dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map(function (item) {
      return {
        file: item.getAsFile(),
        handle: typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null,
      };
    });
  openDropped(entries);
});

async function openDropped(entries) {
  const files = [];
  for (const entry of entries) {
    const handle = entry.handle ? await entry.handle.catch(() => null) : null;
    if (handle && handle.kind === 'directory') {
      try {
        await useFolder(await folderFromHandle(handle));
      } catch (err) {
        toolbar.setStatus(err.message, true);
      }
    } else if (entry.file) {
      files.push(entry.file);
    }
  }
  await openLooseFiles(files);
}

// Keep the page fitted when the window or sidebar changes size.
new ResizeObserver(function () {
  captureInk();
  placeInk(pageView.layout());
}).observe(pageView.stage);

setInterval(function () {
  captureInk();
  notes.tick();
  if (!saving && !ink.isWriting() && performance.now() - lastInkChangeAt > SAVE_DELAY_MS && tabs.some((tab) => tab.dirty)) {
    saveDirty();
  }
}, TICK_MS);

// Closing the page with unsaved ink asks first. Saves are under a second behind, so this is rare.
window.addEventListener('beforeunload', function (event) {
  captureInk();
  if (tabs.some((tab) => tab.dirty)) {
    saveDirty();
    event.preventDefault();
  }
});

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
  },

  onSaveCopy: saveCopy,

  onTranscribe: function () {
    captureInk();
    notes.transcribeNow();
  },

  onAutoChange: function (isOn) {
    notes.setAuto(isOn);
    saveSetting(AUTO_KEY, isOn ? 'on' : 'off');
    toolbar.setStatus(isOn ? 'Auto transcribe on' : 'Auto transcribe off. Press Transcribe or Enter');
  },

  onToggleNotes: function () {
    showNotes(document.body.classList.contains('notes-hidden'));
  },

  // The relay keeps reconnecting on its own, so it only ends when the button is clicked again.
  onRelay: async function () {
    if (active !== null && active.name === 'relay') {
      await stopActive();
      toolbar.setStatus('Relay off');
      return;
    }
    await stopActive();
    toolbar.setStatus('Waiting for relay at ' + RELAY_URL);
    let penOnline = false;
    const connection = connectRelay(RELAY_URL, hub.onPenData, function (status) {
      toolbar.setRelayStatus(status);
      const nowOnline = status.relay && status.pens > 0;
      if (nowOnline && !penOnline) {
        hub.recalibrate();
        toolbar.setStatus('Pen connected. Hold still to calibrate');
      } else if (!nowOnline && penOnline) {
        liftPen();
        toolbar.setStatus(status.relay ? 'Pen disconnected' : 'Relay lost. Retrying');
      }
      penOnline = nowOnline;
    });
    startSource('relay', connection.disconnect);
  },

  // Like the relay, Bluetooth keeps reconnecting to the same pen until the button is clicked again.
  onBluetooth: async function () {
    if (active !== null && active.name === 'bluetooth') {
      await stopActive();
      toolbar.setStatus('Bluetooth off');
      return;
    }
    if (!bluetoothSupported()) {
      toolbar.setStatus('Bluetooth needs Chrome or Edge', true);
      return;
    }
    // The chooser has to open straight from the click, so pick the pen before stopping anything.
    let device;
    try {
      device = await requestPen();
    } catch (err) {
      // Closing the chooser without picking also lands here.
      toolbar.setStatus(err.message, true);
      return;
    }
    await stopActive();
    toolbar.setStatus('Connecting to ' + (device.name || 'pen'));
    let penOnline = false;
    const connection = connectBluetooth(device, hub.onPenData, function (status) {
      toolbar.setBluetoothStatus(status);
      if (status.connected && !penOnline) {
        hub.recalibrate();
        toolbar.setStatus('Pen connected. Hold still to calibrate');
      } else if (!status.connected && penOnline) {
        liftPen();
        toolbar.setStatus('Pen disconnected. Reconnecting');
      }
      penOnline = status.connected;
    });
    startSource('bluetooth', connection.disconnect);
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
  return loadSetting(WS_URL_KEY) || DEFAULT_WS_URL;
}

function saveWsUrl(url) {
  saveSetting(WS_URL_KEY, url);
}

function loadSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Storage can be blocked. Not worth failing over.
  }
}

// Keyboard shortcuts.
// Space  hold for pen down (stands in for the button)
// Page Up / Page Down  previous or next page
// Ctrl/Cmd+Z  undo
// Ctrl/Cmd+S  save a copy with the ink on it
// C  recenter cursor
// R  recalibrate motion
// Enter  transcribe new writing on this page now
// None of them fire while typing in a text field, like the note editor.
window.addEventListener('keydown', function (event) {
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) {
    return;
  }
  if (event.key === 'PageDown' || event.key === 'PageUp') {
    event.preventDefault();
    goToPage(activeTab.page + (event.key === 'PageDown' ? 1 : -1));
  } else if (event.code === 'Space') {
    event.preventDefault();
    hub.setSpacebar(true);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    ink.undo();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveCopy();
  } else if (event.key === 'c' || event.key === 'C') {
    ink.centerCursor();
  } else if (event.key === 'r' || event.key === 'R') {
    hub.recalibrate();
    toolbar.setStatus('Recalibrating. Hold still');
  } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    toolbar.buttons.transcribe.click();
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

notes.attach(whiteboard);
activate(whiteboard);
const autoOn = loadSetting(AUTO_KEY) !== 'off';
toolbar.setAuto(autoOn);
notes.setAuto(autoOn);
showNotes(loadSetting(NOTES_SHOWN_KEY) !== 'off');
ink.centerCursor();
ink.hideCursor();

// Offer the folder from last time. If the browser still allows access, open it straight away.
explorer.showEmpty(null, foldersSupported());
if (foldersSupported()) {
  lastFolder().then(function (remembered) {
    rememberedFolder = remembered;
    if (remembered !== null && remembered.granted) {
      reopenFolder();
    } else if (folder === null) {
      explorer.showEmpty(remembered, true);
    }
  });
}

// Wires the pieces together. Each module does one job.
//
//   relay / serial / wifi / replay  ->  hub.onPenData(sample)  ->  motion.update  ->  ink.moveBy
//   mouse                   ->  ink.moveTo
//   explorer / tabs         ->  openDocument  ->  pageView (one page, ink canvas on top)
//   ink changes             ->  captureInk (page units)  ->  saved to .notechalant/ in the folder

import { createInkCanvas } from './ink/inkCanvas.js';
import { attachMouse } from './input/mouse.js';
import { createInputHub } from './input/hub.js';
import { parseRecording } from './input/parseSample.js';
import { connectSerial, serialSupported } from './input/serial.js';
import { connectWebSocket } from './input/websocket.js';
import { connectRelay, RELAY_URL } from './input/relay.js';
import { playRecording } from './input/replay.js';
import { createMotion } from './motion/index.js';
import { createToolbar } from './ui/toolbar.js';
import { recognizeImage } from './recognize.js';
import { createWhiteboard, openDocument } from './files/documents.js';
import { createPageView } from './files/pageView.js';
import { createExplorer } from './files/explorer.js';
import { createTabs } from './files/tabs.js';
import { foldersSupported, pickFolder, lastFolder } from './files/folder.js';
import { scaleStrokes, packInk, unpackInk } from './files/fileTypes.js';

const DEFAULT_WS_URL = 'ws://192.168.4.1:81';
const WS_URL_KEY = 'notechalant.wsUrl';
const WHITEBOARD_KEY = 'notechalant.whiteboard';
// Ink is saved this long after the last change, so a burst of writing becomes one save.
const SAVE_DELAY_MS = 800;
const TICK_MS = 250;

const canvas = document.getElementById('ink');
const ink = createInkCanvas(canvas);
const motion = createMotion();
const hub = createInputHub({ ink: ink, motion: motion });

attachMouse(canvas, ink);

// ---- Files and tabs ----
//
// A tab is { id, name, path, doc, page, ink, dirty }. `ink` maps page index to strokes in page
// units. The canvas holds the current page's strokes in screen pixels; captureInk copies them
// back into the tab whenever they change. The whiteboard tab is always open and saves to this
// browser, so the app still works with no folder.

const whiteboard = {
  id: 'whiteboard',
  name: 'Whiteboard',
  path: null,
  doc: createWhiteboard(),
  page: 0,
  ink: loadWhiteboard(),
  dirty: false,
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
});

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
}

function goToPage(index) {
  if (index < 0 || index >= activeTab.doc.pageCount || index === activeTab.page) {
    return;
  }
  captureInk();
  activeTab.page = index;
  showPage();
}

function renderTabs() {
  tabStrip.render(
    tabs.map(function (tab) {
      return { id: tab.id, name: tab.name, title: tab.path || 'Whiteboard, saved in this browser', closable: tab !== whiteboard };
    }),
    activeTab.id,
  );
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
  try {
    const doc = await openDocument(await handle.getFile(), path);
    const savedInk = await openedFrom.loadInk(path);
    if (folder !== openedFrom) {
      doc.dispose();
      return;
    }
    const tab = { id: 'file:' + path, name: doc.name, path: path, doc: doc, page: 0, ink: savedInk, dirty: false };
    tabs.splice(tabs.indexOf(activeTab) + 1, 0, tab);
    activate(tab);
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

// Switching folders saves and closes the old folder's tabs. The whiteboard stays.
async function useFolder(newFolder) {
  captureInk();
  await saveDirty();
  for (const tab of tabs) {
    if (tab !== whiteboard) {
      tab.doc.dispose();
    }
  }
  tabs = [whiteboard];
  folder = newFolder;
  await explorer.showFolder(folder);
  activate(whiteboard);
  toolbar.setStatus('Opened ' + folder.name + '. Pick a file to write on');
}

async function saveTab(tab) {
  tab.dirty = false;
  try {
    if (tab === whiteboard) {
      localStorage.setItem(WHITEBOARD_KEY, JSON.stringify(packInk(null, tab.ink)));
      showSaveState('Saved in browser', false);
    } else {
      showSaveState('Saving…', false);
      await folder.saveInk(tab.path, tab.ink);
      showSaveState('Saved', false);
    }
  } catch (err) {
    // Not retried until the ink changes again, so a read-only folder doesn't spam errors.
    showSaveState('Not saved', true);
    toolbar.setStatus("Couldn't save ink for " + (tab.path || 'the whiteboard') + ': ' + err.message, true);
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

// Keep the page fitted when the window or sidebar changes size.
new ResizeObserver(function () {
  captureInk();
  placeInk(pageView.layout());
}).observe(pageView.stage);

setInterval(function () {
  captureInk();
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
// Page Up / Page Down  previous or next page
// Ctrl/Cmd+Z  undo
// C  recenter cursor
// R  recalibrate motion
// Esc  close the result panel
window.addEventListener('keydown', function (event) {
  if (event.target instanceof HTMLInputElement) {
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

activate(whiteboard);
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

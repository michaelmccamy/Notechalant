// Access to a folder on the user's computer through the File System Access API (Chrome and Edge),
// the same way vscode.dev opens local folders. Files are only read. Ink is written to a hidden
// .notechalant folder inside the opened folder, so the user's own files are never modified.

import { inkFileName, packInk, unpackInk } from './fileTypes.js';

const INK_FOLDER = '.notechalant';
const DB_NAME = 'notechalant';
const DB_STORE = 'handles';
const DB_KEY = 'folder';
// Ink for files opened on their own (Open File, or dropped in). There's no folder to save next
// to, so it stays in this browser.
const INK_STORE = 'ink';

export function foldersSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

// Asks the user to pick a folder. Throws an AbortError if they cancel.
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'notechalant', mode: 'readwrite' });
  await rememberFolder(handle);
  return createFolder(handle);
}

// A folder dropped onto the page. Dropping counts as a click, so the permission prompt can show.
export async function folderFromHandle(handle) {
  if ((await permission(handle, true)) !== 'granted') {
    throw new Error('Permission to open ' + handle.name + ' was not given');
  }
  await rememberFolder(handle);
  return createFolder(handle);
}

// Ink for a single opened file, keyed by its name and size since there's no path to go by.
export function looseInkKey(file) {
  return file.name + ':' + file.size;
}

export async function loadLooseInk(key) {
  try {
    return unpackInk(await dbRequest(INK_STORE, 'readonly', (store) => store.get(key)));
  } catch (err) {
    return {};
  }
}

export async function saveLooseInk(key, name, pages) {
  await dbRequest(INK_STORE, 'readwrite', (store) => store.put(packInk(name, pages), key));
}

// The folder from last visit, without asking for permission yet. Returns { name, open } or null.
// open() must run from a click, because the browser only shows the permission prompt then.
export async function lastFolder() {
  const handle = await loadHandle().catch(function () {
    return null;
  });
  if (!handle) {
    return null;
  }
  return {
    name: handle.name,
    granted: (await permission(handle, false)) === 'granted',
    open: async function () {
      if ((await permission(handle, true)) !== 'granted') {
        throw new Error('Permission to open ' + handle.name + ' was not given');
      }
      return createFolder(handle);
    },
  };
}

function createFolder(root) {
  // Sorted folders first, then files, like VS Code. Hidden entries (starting with a dot) are skipped.
  async function list(dirHandle) {
    const entries = [];
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.')) continue;
      entries.push(entry);
    }
    entries.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return entries;
  }

  async function inkDir(create) {
    return root.getDirectoryHandle(INK_FOLDER, { create: create });
  }

  // Ink for a file, as { pageIndex: strokes } in page units. Empty if none was saved yet.
  async function loadInk(path) {
    try {
      const dir = await inkDir(false);
      const file = await (await dir.getFileHandle(inkFileName(path))).getFile();
      return unpackInk(JSON.parse(await file.text()));
    } catch (err) {
      return {};
    }
  }

  async function saveInk(path, pages) {
    const dir = await inkDir(true);
    const handle = await dir.getFileHandle(inkFileName(path), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(packInk(path, pages)));
    await writable.close();
  }

  return { name: root.name, root: root, list: list, loadInk: loadInk, saveInk: saveInk };
}

// Some handles (like the browser's private storage, used in tests) have no permission methods.
async function permission(handle, ask) {
  if (typeof handle.queryPermission !== 'function') {
    return 'granted';
  }
  const options = { mode: 'readwrite' };
  const state = await handle.queryPermission(options);
  if (state === 'granted' || !ask) {
    return state;
  }
  return handle.requestPermission(options);
}

// Folder handles can't go in localStorage, but IndexedDB can store them. Version 2 added ink.
function openDb() {
  return new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = function () {
      for (const name of [DB_STORE, INK_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name);
        }
      }
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

// Runs one request against a store and resolves with its result once the transaction commits.
async function dbRequest(storeName, mode, makeRequest) {
  const db = await openDb();
  try {
    return await new Promise(function (resolve, reject) {
      const tx = db.transaction(storeName, mode);
      const request = makeRequest(tx.objectStore(storeName));
      tx.oncomplete = function () {
        resolve(request.result);
      };
      tx.onerror = function () {
        reject(tx.error);
      };
    });
  } finally {
    db.close();
  }
}

async function rememberFolder(handle) {
  try {
    await dbRequest(DB_STORE, 'readwrite', (store) => store.put(handle, DB_KEY));
  } catch (err) {
    // Not remembering the folder only costs a click next time.
  }
}

async function loadHandle() {
  return (await dbRequest(DB_STORE, 'readonly', (store) => store.get(DB_KEY))) || null;
}

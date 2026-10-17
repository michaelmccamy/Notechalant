// Access to a folder on the user's computer through the File System Access API (Chrome and Edge),
// the same way vscode.dev opens local folders. Files are only read. Ink is written to a hidden
// .notechalant folder inside the opened folder, so the user's own files are never modified.
// Saving a copy adds a new file next to the original and never replaces an existing one.

import { inkFileName, packInk, unpackInk, copyName } from './fileTypes.js';

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

  // Writes `blob` as a new file in the same folder as `path`, named like "notes-annotated.pdf".
  // Returns the new file's path.
  async function saveCopy(path, blob, extension) {
    const parts = path.split('/');
    const name = parts.pop();
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part);
    }
    const taken = new Set();
    for await (const entry of dir.values()) {
      taken.add(entry.name.toLowerCase());
    }
    // Windows and macOS ignore case in file names, so "Notes.pdf" and "notes.pdf" collide.
    const newName = copyName(name, extension, (candidate) => taken.has(candidate.toLowerCase()));
    const handle = await dir.getFileHandle(newName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return parts.concat(newName).join('/');
  }

  return { name: root.name, root: root, list: list, loadInk: loadInk, saveInk: saveInk, saveCopy: saveCopy };
}

// For a copy of a file that isn't in an opened folder. Asks where to save it in Chrome and Edge,
// and downloads it elsewhere. Returns the chosen name, or null if the user cancelled.
// `originalName` can't be picked, so the copy can't replace the file it came from. (A single
// file comes without its location, so the name is all there is to check.)
export async function saveCopyAs(suggestedName, blob, extension, originalName) {
  if (typeof window.showSaveFilePicker === 'function') {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        id: 'notechalant-copy',
        suggestedName: suggestedName,
        types: [{ description: extension.toUpperCase() + ' file', accept: { [blob.type]: ['.' + extension] } }],
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        return null;
      }
      throw err;
    }
    // Nothing is written until createWritable, so stopping here leaves the original untouched.
    if (originalName && handle.name.toLowerCase() === originalName.toLowerCase()) {
      throw new Error('That would replace the original file. Save the copy under a different name');
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return handle.name;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = suggestedName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  return suggestedName;
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

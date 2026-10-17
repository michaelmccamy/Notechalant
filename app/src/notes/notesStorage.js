// Where each tab's notes are saved, matching where its ink is saved:
//   folder file   .notechalant/notes/<path>.json inside the opened folder
//   single file   this browser (IndexedDB), keyed like its ink
//   whiteboard    this browser (localStorage)
// Notes live in their own files and database, apart from ink, so the two can change separately.

import { inkFileName } from '../files/fileTypes.js';
import { packNotes, unpackNotes } from './noteData.js';

const WHITEBOARD_KEY = 'notechalant.whiteboard.notes';
const DB_NAME = 'notechalant-notes';
const STORE = 'notes';

// Returns the saved notes, or null if this file has none yet.
export async function loadNotes(tab, folder) {
  try {
    if (tab.path) {
      const dir = await notesDir(folder, false);
      const file = await (await dir.getFileHandle(inkFileName(tab.path))).getFile();
      return unpackNotes(JSON.parse(await file.text()));
    }
    if (tab.looseKey) {
      return unpackNotes(await dbRequest('readonly', (store) => store.get(tab.looseKey)));
    }
    return unpackNotes(JSON.parse(localStorage.getItem(WHITEBOARD_KEY)));
  } catch (err) {
    return null;
  }
}

export async function saveNotes(tab, folder, notes) {
  const data = packNotes(tab.path || tab.name, notes);
  if (tab.path) {
    const dir = await notesDir(folder, true);
    const writable = await (await dir.getFileHandle(inkFileName(tab.path), { create: true })).createWritable();
    await writable.write(JSON.stringify(data));
    await writable.close();
  } else if (tab.looseKey) {
    await dbRequest('readwrite', (store) => store.put(data, tab.looseKey));
  } else {
    localStorage.setItem(WHITEBOARD_KEY, JSON.stringify(data));
  }
}

async function notesDir(folder, create) {
  const inkDir = await folder.root.getDirectoryHandle('.notechalant', { create: create });
  return inkDir.getDirectoryHandle('notes', { create: create });
}

function openDb() {
  return new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = function () {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
  });
}

async function dbRequest(mode, makeRequest) {
  const db = await openDb();
  try {
    return await new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE, mode);
      const request = makeRequest(tx.objectStore(STORE));
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

// The left sidebar: a VS Code style tree of the opened folder. Folders load their contents the
// first time they're expanded, so opening a big folder stays fast.

import { extensionOf, kindOf } from './fileTypes.js';

const INDENT_PX = 14;

export function createExplorer({ onOpenFolder, onReopen, onRefresh, onOpenFile }) {
  const titleEl = document.getElementById('explorer-title');
  const treeEl = document.getElementById('explorer-tree');
  const emptyEl = document.getElementById('explorer-empty');
  const emptyText = document.getElementById('explorer-empty-text');
  const openButton = document.getElementById('explorer-open');
  const reopenButton = document.getElementById('explorer-reopen');
  const refreshButton = document.getElementById('explorer-refresh');

  let folder = null;
  let activePath = null;

  document.getElementById('explorer-open-folder').addEventListener('click', onOpenFolder);
  openButton.addEventListener('click', onOpenFolder);
  reopenButton.addEventListener('click', onReopen);
  refreshButton.addEventListener('click', onRefresh);

  // No folder open yet. `remembered` is the last folder ({ name }) or null.
  function showEmpty(remembered, supported) {
    folder = null;
    titleEl.textContent = 'No folder open';
    treeEl.replaceChildren();
    treeEl.hidden = true;
    emptyEl.hidden = false;
    refreshButton.hidden = true;
    if (!supported) {
      emptyText.textContent = 'Opening folders needs Chrome or Edge. The whiteboard still works here.';
      openButton.hidden = true;
      reopenButton.hidden = true;
      return;
    }
    emptyText.textContent = 'Open a folder to write on the files in it. Your files are never changed.';
    openButton.hidden = false;
    reopenButton.hidden = remembered === null;
    if (remembered !== null) {
      reopenButton.textContent = 'Reopen ' + remembered.name;
    }
  }

  async function showFolder(newFolder) {
    folder = newFolder;
    titleEl.textContent = folder.name;
    titleEl.title = folder.name;
    emptyEl.hidden = true;
    treeEl.hidden = false;
    refreshButton.hidden = false;
    treeEl.replaceChildren(await renderChildren(folder.root, '', 0));
  }

  async function renderChildren(dirHandle, parentPath, depth) {
    const list = document.createElement('ul');
    list.className = 'tree';
    list.setAttribute('role', depth === 0 ? 'tree' : 'group');
    const entries = await folder.list(dirHandle);
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'tree-empty';
      empty.style.paddingLeft = 8 + depth * INDENT_PX + 'px';
      empty.textContent = 'Empty folder';
      list.appendChild(empty);
    }
    for (const entry of entries) {
      const path = parentPath === '' ? entry.name : parentPath + '/' + entry.name;
      list.appendChild(entry.kind === 'directory' ? renderDirectory(entry, path, depth) : renderFile(entry, path, depth));
    }
    return list;
  }

  function renderDirectory(entry, path, depth) {
    const item = document.createElement('li');
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-expanded', 'false');
    const row = rowButton(depth, 'dir');
    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.textContent = '›';
    row.append(chevron, label(entry.name));
    item.appendChild(row);

    let children = null;
    row.addEventListener('click', async function () {
      const expanding = item.getAttribute('aria-expanded') === 'false';
      item.setAttribute('aria-expanded', String(expanding));
      if (expanding && children === null) {
        children = await renderChildren(entry, path, depth + 1);
        item.appendChild(children);
        highlight();
      }
      if (children !== null) {
        children.hidden = !expanding;
      }
    });
    return item;
  }

  function renderFile(entry, path, depth) {
    const item = document.createElement('li');
    item.setAttribute('role', 'treeitem');
    const row = rowButton(depth, 'file');
    row.dataset.path = path;
    const badge = document.createElement('span');
    badge.className = 'tree-badge kind-' + kindOf(entry.name);
    badge.textContent = (extensionOf(entry.name) || 'file').slice(0, 4);
    row.append(badge, label(entry.name));
    row.title = path;
    row.addEventListener('click', function () {
      onOpenFile(entry, path);
    });
    item.appendChild(row);
    return item;
  }

  function rowButton(depth, type) {
    const row = document.createElement('button');
    row.className = 'tree-row tree-' + type;
    row.style.paddingLeft = 8 + depth * INDENT_PX + 'px';
    return row;
  }

  function label(text) {
    const span = document.createElement('span');
    span.className = 'tree-label';
    span.textContent = text;
    return span;
  }

  // Marks the open file's row. Called when the active tab changes.
  function setActive(path) {
    activePath = path;
    highlight();
  }

  function highlight() {
    for (const row of treeEl.querySelectorAll('.tree-file')) {
      row.classList.toggle('current', row.dataset.path === activePath);
      if (row.dataset.path === activePath) {
        row.setAttribute('aria-current', 'true');
      } else {
        row.removeAttribute('aria-current');
      }
    }
  }

  return { showEmpty, showFolder, setActive };
}

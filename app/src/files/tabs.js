// The tab strip above the page. main.js owns the list of open tabs; this only draws it.
// Middle click closes a tab, like VS Code.

export function createTabs({ onSelect, onClose }) {
  const strip = document.getElementById('tabs');

  // tabs: [{ id, name, title, closable }]
  function render(tabs, activeId) {
    strip.replaceChildren();
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = 'tab';
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(tab.id === activeId));
      el.title = tab.title;

      const name = document.createElement('button');
      name.className = 'tab-name';
      name.textContent = tab.name;
      name.addEventListener('click', function () {
        onSelect(tab.id);
      });
      el.appendChild(name);

      if (tab.closable) {
        const close = document.createElement('button');
        close.className = 'tab-close';
        close.textContent = '×';
        close.title = 'Close';
        close.setAttribute('aria-label', 'Close ' + tab.name);
        close.addEventListener('click', function () {
          onClose(tab.id);
        });
        el.appendChild(close);
        el.addEventListener('auxclick', function (event) {
          if (event.button === 1) {
            onClose(tab.id);
          }
        });
      }
      strip.appendChild(el);
    }
    const active = strip.querySelector('[aria-selected="true"]');
    if (active) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  return { render };
}

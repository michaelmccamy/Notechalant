// Just enough Markdown for transcribed notes: headings, bullet and numbered lists, paragraphs.
// The recognition prompt asks for nothing fancier. Math stays inside the text as $...$ and
// KaTeX renders it afterwards, so this never needs to understand LaTeX.
//
// parseMarkdown is pure (tested). renderMarkdown builds DOM with textContent only,
// so nothing the model returns is ever treated as HTML.

export function parseMarkdown(text) {
  const nodes = [];
  let paragraph = null;
  let list = null;

  function endParagraph() {
    if (paragraph !== null) {
      nodes.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph = null;
    }
  }

  function endList() {
    if (list !== null) {
      nodes.push(list);
      list = null;
    }
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (line.trim() === '') {
      endParagraph();
      endList();
    } else if (heading) {
      endParagraph();
      endList();
      nodes.push({ type: 'heading', level: heading[1].length, text: heading[2] });
    } else if (bullet || numbered) {
      endParagraph();
      const ordered = Boolean(numbered);
      if (list !== null && list.ordered !== ordered) {
        endList();
      }
      if (list === null) {
        list = { type: 'list', ordered: ordered, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
    } else {
      endList();
      if (paragraph === null) {
        paragraph = [];
      }
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return nodes;
}

export function renderMarkdown(text, container) {
  for (const node of parseMarkdown(text)) {
    if (node.type === 'heading') {
      container.appendChild(element('h' + (node.level + 2), node.text));
    } else if (node.type === 'list') {
      const listEl = document.createElement(node.ordered ? 'ol' : 'ul');
      for (const item of node.items) {
        listEl.appendChild(element('li', item));
      }
      container.appendChild(listEl);
    } else {
      container.appendChild(element('p', node.text));
    }
  }
}

// True if the text has anything KaTeX should render, so KaTeX loads only when needed.
export function hasMath(text) {
  return /\$|\\\(|\\\[/.test(text);
}

function element(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

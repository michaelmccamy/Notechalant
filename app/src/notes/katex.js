// KaTeX (about 300 KB with fonts) loads the first time something on screen has math in it.
// Shared by the notes panel and the cleaned up text on the page.
// Its stylesheet is loaded up front in main.js, not here. Without it, every formula shows twice
// (the hidden MathML copy shows too), and adding it on demand sometimes didn't stick.

export const MATH_OPTIONS = {
  delimiters: [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\(', right: '\\)', display: false },
  ],
  throwOnError: false,
};

let katexPromise = null;

// Resolves to KaTeX's renderMathInElement.
export function loadKatex() {
  if (katexPromise === null) {
    katexPromise = import('katex/contrib/auto-render').then((autoRender) => autoRender.default);
    katexPromise.catch(function () {
      katexPromise = null;
    });
  }
  return katexPromise;
}

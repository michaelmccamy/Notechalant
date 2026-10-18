// KaTeX (about 300 KB with fonts) loads the first time something on screen has math in it.
// Shared by the notes panel and the cleaned up text on the page.

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
    katexPromise = Promise.all([import('katex/contrib/auto-render'), import('katex/dist/katex.min.css')]).then(
      ([autoRender]) => autoRender.default,
    );
    katexPromise.catch(function () {
      katexPromise = null;
    });
  }
  return katexPromise;
}

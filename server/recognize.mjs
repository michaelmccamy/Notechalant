// The recognition logic, shared by the local server (index.mjs) and the Vercel function
// (api/recognize.mjs). Takes the parsed request body, returns { status, body } to send back.

import { generate, hasConfig, MISSING_CONFIG } from './gemini.mjs';

// The app adds whatever comes back to the file's notes, so it has to read as note text.
const PROMPT = [
  'This image is handwriting drawn in the air with a motion-tracking pen, so letters may be shaky or uneven.',
  'Transcribe exactly what is written, as note text.',
  'Write any math as LaTeX inside $...$, or $$...$$ for an equation on its own line. Do not solve or simplify it.',
  'Use Markdown only for headings (#) and lists (- or 1.). No bold, no code fences.',
  'In math, an x-shaped mark is the variable x. Read it as a multiplication sign only when it sits between two numbers or expressions being multiplied, like 3 × 4. Next to an operator or an equals sign (as in 7x + 4) it is always the variable x.',
  'If there is no writing, or only marks such as circles, arrows, underlines, or check marks, return exactly: (nothing recognized)',
  'Return only the transcription, with no commentary.',
].join(' ');

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_CONTEXT_CHARS = 600;

// context: the end of the notes so far, to help with unclear words.
// previous: what part of this same handwriting was read as before, when a line is read again
// because more was written on it. Without it the model sometimes rereads a letter differently
// (the x in "7x + 4" came back as a times sign once the line was sent again with "=").
function buildPrompt(context, previous) {
  let prompt = PROMPT;
  if (previous) {
    prompt +=
      '\n\nPart of this handwriting was read earlier as the text below. More may have been written since. Transcribe everything in the image, and keep the earlier reading for the parts it covers unless the image clearly shows something else.\n"""\n' +
      previous +
      '\n"""';
  }
  if (context) {
    prompt +=
      '\n\nThe notes so far end with the text below. Use it only to resolve unclear words or symbols. Do not repeat it.\n"""\n' +
      context +
      '\n"""';
  }
  return prompt;
}

// index.mjs checks this at startup to warn about a missing key.
export { hasConfig };

export async function recognize(body, env) {
  if (!hasConfig(env)) {
    return { status: 500, body: { error: MISSING_CONFIG } };
  }

  const image = body && body.image;
  if (typeof image !== 'string' || !image.startsWith(PNG_PREFIX)) {
    return { status: 400, body: { error: 'Expected JSON with an image field holding a PNG data URL' } };
  }

  try {
    const context = typeof body.context === 'string' ? body.context.slice(-MAX_CONTEXT_CHARS).trim() : '';
    const previous = typeof body.previous === 'string' ? body.previous.slice(0, MAX_CONTEXT_CHARS).trim() : '';
    const text = await generate(
      [{ text: buildPrompt(context, previous) }, { inline_data: { mime_type: 'image/png', data: image.slice(PNG_PREFIX.length) } }],
      env,
    );
    return { status: 200, body: { text: text || '(nothing recognized)' } };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: err.message } };
  }
}

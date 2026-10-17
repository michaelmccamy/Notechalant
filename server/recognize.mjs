// The recognition logic, shared by the local server (index.mjs) and the Vercel function
// (api/recognize.mjs). Takes the parsed request body, returns { status, body } to send back.

// The app adds whatever comes back to the file's notes, so it has to read as note text.
const PROMPT = [
  'This image is handwriting drawn in the air with a motion-tracking pen, so letters may be shaky or uneven.',
  'Transcribe exactly what is written, as note text.',
  'Write any math as LaTeX inside $...$, or $$...$$ for an equation on its own line. Do not solve or simplify it.',
  'Use Markdown only for headings (#) and lists (- or 1.). No bold, no code fences.',
  'If there is no writing, or only marks such as circles, arrows, underlines, or check marks, return exactly: (nothing recognized)',
  'Return only the transcription, with no commentary.',
].join(' ');

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_CONTEXT_CHARS = 600;

function buildPrompt(context) {
  if (!context) {
    return PROMPT;
  }
  return (
    PROMPT +
    '\n\nThe notes so far end with the text below. Use it only to resolve unclear words or symbols. Do not repeat it.\n"""\n' +
    context +
    '\n"""'
  );
}
// Most answers take about a second, but now and then one stalls for 30s or more.
// Giving up and asking again is much faster than waiting it out.
const TIMEOUT_MS = 8000;
const ATTEMPTS = 2;

export function hasConfig(env) {
  return Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL);
}

export async function recognize(body, env) {
  if (!hasConfig(env)) {
    return {
      status: 500,
      body: { error: 'Missing GEMINI_API_KEY or GEMINI_MODEL. Set them in server/.env, or in Vercel when deployed' },
    };
  }

  const image = body && body.image;
  if (typeof image !== 'string' || !image.startsWith(PNG_PREFIX)) {
    return { status: 400, body: { error: 'Expected JSON with an image field holding a PNG data URL' } };
  }

  try {
    const context = typeof body.context === 'string' ? body.context.slice(-MAX_CONTEXT_CHARS).trim() : '';
    const text = await callGemini(image.slice(PNG_PREFIX.length), context, env);
    return { status: 200, body: { text: text || '(nothing recognized)' } };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: err.message } };
  }
}

async function callGemini(base64Png, context, env) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + env.GEMINI_MODEL + ':generateContent';
  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: buildPrompt(context) }, { inline_data: { mime_type: 'image/png', data: base64Png } }],
        },
      ],
    }),
  };

  let response;
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS) }, request));
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        throw new Error('Could not reach Gemini. Check the internet connection');
      }
      if (attempt === ATTEMPTS) {
        throw new Error('Gemini took too long to answer. Try again');
      }
      console.log('Gemini timed out, retrying');
    }
  }

  const data = await response.json().catch(function () {
    return null;
  });
  if (!response.ok) {
    let detail = 'HTTP ' + response.status;
    if (data !== null && data.error && data.error.message) {
      detail = data.error.message;
    }
    throw new Error('Gemini error, ' + detail);
  }

  // The answer can come back split across several parts. Join them.
  let text = '';
  const candidate = data && data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  for (let i = 0; i < parts.length; i++) {
    if (typeof parts[i].text === 'string') {
      text += parts[i].text;
    }
  }
  return text.trim();
}

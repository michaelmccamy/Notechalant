// The recognition logic, shared by the local server (index.mjs) and the Vercel function
// (api/recognize.mjs). Takes the parsed request body, returns { status, body } to send back.

const PROMPT = [
  'This image is handwriting drawn in the air with a motion-tracking pen, so letters may be shaky or uneven.',
  'Transcribe exactly what is written.',
  'If it is a math expression or equation, give it as LaTeX on the first line, then the solution or simplified result on the next line.',
  'Return only the transcription, with no commentary.',
].join(' ');

const PNG_PREFIX = 'data:image/png;base64,';

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
    const text = await callGemini(image.slice(PNG_PREFIX.length), env);
    return { status: 200, body: { text: text || '(nothing recognized)' } };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: err.message } };
  }
}

async function callGemini(base64Png, env) {
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
          parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/png', data: base64Png } }],
        },
      ],
    }),
  };

  let response;
  try {
    response = await fetch(url, request);
  } catch (err) {
    throw new Error('Could not reach Gemini. Check the internet connection');
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

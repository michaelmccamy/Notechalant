// Recognition server. Owner is CpE 3.
//
// The browser sends the canvas as a PNG data URL to POST /api/recognize.
// This server forwards it to Gemini and returns { text }.
// It exists so the API key stays in server/.env and never ships in frontend code.

import http from 'node:http';

// Load server/.env if it exists (Node 20.12 or newer).
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch (err) {
  // No .env yet. The warning below explains what to set.
}

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const PROMPT = [
  'This image is handwriting drawn in the air with a motion-tracking pen, so letters may be shaky or uneven.',
  'Transcribe exactly what is written.',
  'If it is a math expression or equation, give it as LaTeX on the first line, then the solution or simplified result on the next line.',
  'Return only the transcription, with no commentary.',
].join(' ');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Image too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function callGemini(base64Png) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': API_KEY,
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

async function handleRecognize(req, res) {
  if (!API_KEY || !MODEL) {
    sendJson(res, 500, { error: 'Server is missing GEMINI_API_KEY or GEMINI_MODEL in server/.env' });
    return;
  }

  let image;
  try {
    const body = JSON.parse(await readBody(req));
    image = body.image;
  } catch (err) {
    sendJson(res, 400, { error: 'Expected JSON with an image field' });
    return;
  }

  const prefix = 'data:image/png;base64,';
  if (typeof image !== 'string' || !image.startsWith(prefix)) {
    sendJson(res, 400, { error: 'image must be a PNG data URL' });
    return;
  }

  try {
    const text = await callGemini(image.slice(prefix.length));
    sendJson(res, 200, { text: text || '(nothing recognized)' });
  } catch (err) {
    console.error(err);
    sendJson(res, 502, { error: err.message });
  }
}

const server = http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url === '/api/recognize') {
    handleRecognize(req, res);
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, { ok: true, model: MODEL || null, hasKey: Boolean(API_KEY) });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, function () {
  console.log('Recognition server on http://localhost:' + PORT);
  if (!API_KEY || !MODEL) {
    console.log('Warning: set GEMINI_API_KEY and GEMINI_MODEL in server/.env');
  }
});

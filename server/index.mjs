// Recognition server for local development. Owner is CpE 3.
//
// The browser sends the canvas as a PNG data URL to POST /api/recognize.
// This server forwards it to Gemini and returns { text }.
// It exists so the API key stays in server/.env and never ships in frontend code.
// The Gemini call itself lives in recognize.mjs, shared with the Vercel function in api/.

import http from 'node:http';
import { recognize, hasConfig } from './recognize.mjs';
import { tutor } from './tutor.mjs';

// Load server/.env if it exists (Node 20.12 or newer).
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch (err) {
  // No .env yet. The warning below explains what to set.
}

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

// handler is recognize or tutor. Both answer a missing or unreadable body with a 400.
async function handleJson(req, res, handler) {
  let body = null;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    // Left as null for the handler to reject.
  }
  const result = await handler(body, process.env);
  sendJson(res, result.status, result.body);
}

const server = http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url === '/api/recognize') {
    handleJson(req, res, recognize);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/tutor') {
    handleJson(req, res, tutor);
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, { ok: true, model: process.env.GEMINI_MODEL || null, hasKey: Boolean(process.env.GEMINI_API_KEY) });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, function () {
  console.log('Recognition server on http://localhost:' + PORT);
  if (!hasConfig(process.env)) {
    console.log('Warning: set GEMINI_API_KEY and GEMINI_MODEL in server/.env');
  }
});

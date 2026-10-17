// Vercel function for POST /api/recognize. Same logic as the local server (server/index.mjs).
// Set GEMINI_API_KEY and GEMINI_MODEL in the Vercel project's environment variables.

import { recognize } from '../server/recognize.mjs';

export async function POST(request) {
  const body = await request.json().catch(function () {
    return null;
  });
  const result = await recognize(body, process.env);
  return Response.json(result.body, { status: result.status });
}

// Vercel function for POST /api/explain (Circle to ask). Same logic as the local server
// (server/index.mjs).

import { explain } from '../server/recognize.mjs';

export async function POST(request) {
  const body = await request.json().catch(function () {
    return null;
  });
  const result = await explain(body, process.env);
  return Response.json(result.body, { status: result.status });
}

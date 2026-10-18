// Vercel function for POST /api/tutor. Same logic as the local server (server/index.mjs).

import { tutor } from '../server/tutor.mjs';

export async function POST(request) {
  const body = await request.json().catch(function () {
    return null;
  });
  const result = await tutor(body, process.env);
  return Response.json(result.body, { status: result.status });
}

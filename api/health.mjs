// GET /api/health on Vercel. Open it after deploying to check the environment variables are set.

export function GET() {
  return Response.json({ ok: true, model: process.env.GEMINI_MODEL || null, hasKey: Boolean(process.env.GEMINI_API_KEY) });
}

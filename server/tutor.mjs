// The tutor, shared by the local server (index.mjs) and the Vercel function (api/tutor.mjs).
// Takes the parsed request body, returns { status, body } to send back.
//
// Two kinds of request:
//   review   { text, context }          a new note was just transcribed. Answers { review } with
//                                       corrections, a question about what help is wanted, a
//                                       confirmation, or nothing to say.
//   reply    { text, context, thread }  the student answered or asked something about a note.
//                                       Answers { reply } as note-style Markdown.

import { generate, hasConfig, MISSING_CONFIG } from './gemini.mjs';

const MAX_TEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 1500;
const MAX_THREAD_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2000;
// Checking math step by step takes longer than reading handwriting.
const TIMEOUT_MS = 15000;

const PERSONA = [
  'You are a friendly, encouraging tutor looking over a student\'s shoulder while they take notes.',
  'They write by hand in the air with a motion-tracking pen and the writing is transcribed automatically,',
  'so a single odd letter or a missing space is probably a transcription slip, not their mistake. Ignore those.',
  'Write math as LaTeX inside $...$.',
].join(' ');

const REVIEW_PROMPT = [
  PERSONA,
  'Look at the NEW writing below and decide how to help.',
  'Check grammar and spelling in sentences. Check math work step by step (arithmetic, algebra, calculus, units) and point out the first step that is wrong, with the corrected step. Check facts that are stated as true.',
  'Do not finish problems the student has not finished, and do not rewrite their style.',
  'Pick one verdict:',
  '"issues" if anything is wrong. List each problem in issues, with wrong copied exactly from their text, fix as the corrected text, and why in one short sentence.',
  '"question" if nothing is wrong but the writing is a question, an unsolved problem, or unfinished work where help would be useful. Ask briefly what they want help with, and give two or three short options (under 6 words each), like "Check my steps" or "Give me a hint".',
  '"correct" if it is math work or a factual claim and it is right. Say so in a few words.',
  '"none" for ordinary notes, headings, or lists with nothing worth saying.',
  'message is one or two short sentences, spoken to the student.',
].join(' ');

const REPLY_PROMPT = [
  PERSONA,
  'Answer the student\'s latest message about the note below.',
  'Guide them toward the answer with hints and questions unless they clearly ask for the answer.',
  'Keep it under 120 words. Use Markdown only for lists (- or 1.). No headings, no bold, no code fences.',
].join(' ');

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['issues', 'question', 'correct', 'none'] },
    message: { type: 'STRING' },
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['grammar', 'spelling', 'math', 'fact', 'other'] },
          wrong: { type: 'STRING' },
          fix: { type: 'STRING' },
          why: { type: 'STRING' },
        },
        required: ['kind', 'wrong', 'fix', 'why'],
      },
    },
    options: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['verdict', 'message'],
};

export async function tutor(body, env) {
  if (!hasConfig(env)) {
    return { status: 500, body: { error: MISSING_CONFIG } };
  }
  const text = body && typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_CHARS).trim() : '';
  if (text === '') {
    return { status: 400, body: { error: 'Expected JSON with a text field holding the note' } };
  }
  const context = typeof body.context === 'string' ? body.context.slice(-MAX_CONTEXT_CHARS).trim() : '';
  const thread = cleanThread(body.thread);

  try {
    if (thread.length === 0) {
      return { status: 200, body: { review: await review(text, context, env) } };
    }
    return { status: 200, body: { reply: await reply(text, context, thread, env) } };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: err.message } };
  }
}

async function review(text, context, env) {
  const answer = await generate([{ text: REVIEW_PROMPT + contextSection(context) + '\n\nNEW writing:\n"""\n' + text + '\n"""' }], env, {
    timeoutMs: TIMEOUT_MS,
    generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_SCHEMA },
  });
  try {
    return JSON.parse(answer);
  } catch (err) {
    // The app checks every field anyway, so an unreadable answer just means nothing to show.
    return { verdict: 'none', message: '' };
  }
}

async function reply(text, context, thread, env) {
  const conversation = thread
    .map(function (message) {
      return (message.role === 'tutor' ? 'Tutor: ' : 'Student: ') + message.text;
    })
    .join('\n');
  const prompt = REPLY_PROMPT + contextSection(context) + '\n\nThe note:\n"""\n' + text + '\n"""\n\nConversation so far:\n' + conversation + '\nTutor:';
  return generate([{ text: prompt }], env, { timeoutMs: TIMEOUT_MS });
}

function contextSection(context) {
  if (!context) {
    return '';
  }
  return '\n\nEarlier notes, for context only:\n"""\n' + context + '\n"""';
}

// [{ role: 'student' | 'tutor', text }], newest last, trimmed to a sensible size.
function cleanThread(thread) {
  if (!Array.isArray(thread)) {
    return [];
  }
  return thread
    .filter(function (m) {
      return m && typeof m.text === 'string' && m.text.trim() !== '';
    })
    .slice(-MAX_THREAD_MESSAGES)
    .map(function (m) {
      return { role: m.role === 'tutor' ? 'tutor' : 'student', text: m.text.slice(0, MAX_MESSAGE_CHARS) };
    });
}

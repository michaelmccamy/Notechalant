// Talks to the tutor endpoint on our server (server/tutor.mjs), which calls Gemini.

import { postApi, cleanTranscription } from '../recognize.js';
import { normalizeReview } from './tutorData.js';

// A freshly written note. Returns a checked review, or null when the tutor has nothing to say.
export async function reviewNote(text, context) {
  const body = await postApi('/api/tutor', { text: text, context: context || '' }, 'Tutor');
  return normalizeReview(body.review);
}

// The student's message is the last one in `thread`. Returns the tutor's answer as note text.
export async function askTutor(text, context, thread) {
  const body = await postApi('/api/tutor', { text: text, context: context || '', thread: thread }, 'Tutor');
  const reply = cleanTranscription(body.reply);
  if (reply === '') {
    throw new Error('The tutor had no answer. Try asking another way');
  }
  return reply;
}

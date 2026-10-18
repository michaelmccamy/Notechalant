// Talks to the tutor endpoint on our server (server/tutor.mjs), which calls Gemini.
//
// `seen` is what the tutor can look at besides the text: { sketch, page }, where sketch is a PNG
// of the handwriting or drawing and page is a pageSnapshot (the page being read, with its ink).
// Either can be missing.

import { postApi, cleanTranscription } from '../recognize.js';
import { normalizeReview } from './tutorData.js';

// A freshly written note. Returns a checked review, or null when the tutor has nothing to say.
export async function reviewNote(text, context, seen) {
  const body = await postApi('/api/tutor', request(text, context, seen), 'Tutor');
  return normalizeReview(body.review);
}

// The student's message is the last one in `thread`. Returns the tutor's answer as note text.
export async function askTutor(text, context, thread, seen) {
  const body = await postApi('/api/tutor', Object.assign(request(text, context, seen), { thread: thread }), 'Tutor');
  const reply = cleanTranscription(body.reply);
  if (reply === '') {
    throw new Error('The tutor had no answer. Try asking another way');
  }
  return reply;
}

function request(text, context, seen) {
  const payload = { text: text, context: context || '' };
  if (seen && seen.sketch) {
    payload.sketch = seen.sketch;
  }
  if (seen && seen.page) {
    payload.page = seen.page;
  }
  return payload;
}

// A note's tutor feedback, as plain data. No DOM or network in here, so it all runs under `npm test`.
//
// A note block can carry `tutor`:
//   { review, thread: [{ role: 'student' | 'tutor', text }], pending, error }
//
//   review    what the tutor said when the note was first written, or null:
//             { verdict: 'issues' | 'question' | 'correct', message, issues: [{ kind, wrong, fix, why }], options }
//   thread    the back-and-forth after that, oldest first
//   pending   true while a request is in flight (never saved)
//   error     why the last request failed, or '' (never saved)

const VERDICTS = ['issues', 'question', 'correct'];
const KINDS = ['grammar', 'spelling', 'math', 'fact', 'other'];
const MAX_OPTIONS = 3;
const MAX_ISSUES = 6;
// Shorter than this is a stray mark or a single word, nothing to tutor on.
const MIN_REVIEW_CHARS = 4;

export function emptyTutor() {
  return { review: null, thread: [], pending: false, error: '' };
}

// Whether a fresh transcription is worth sending to the tutor.
export function worthReviewing(text) {
  return typeof text === 'string' && text.trim().length >= MIN_REVIEW_CHARS;
}

// Checks everything the model sent. Returns null when there's nothing to show ("none", empty,
// or unreadable), so a quiet tutor leaves the note alone.
export function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object' || !VERDICTS.includes(raw.verdict)) {
    return null;
  }
  const issues = Array.isArray(raw.issues)
    ? raw.issues
        .filter((i) => i && typeof i.wrong === 'string' && typeof i.fix === 'string' && i.fix.trim() !== '')
        .slice(0, MAX_ISSUES)
        .map((i) => ({
          kind: KINDS.includes(i.kind) ? i.kind : 'other',
          wrong: i.wrong.trim(),
          fix: i.fix.trim(),
          why: typeof i.why === 'string' ? i.why.trim() : '',
        }))
    : [];
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter((o) => typeof o === 'string' && o.trim() !== '')
        .map((o) => o.trim())
        .slice(0, MAX_OPTIONS)
    : [];
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  // "Issues" with none listed that survived checking is really nothing to correct.
  const verdict = raw.verdict === 'issues' && issues.length === 0 ? (message ? 'correct' : null) : raw.verdict;
  if (verdict === null || (message === '' && issues.length === 0)) {
    return null;
  }
  return { verdict: verdict, message: message, issues: verdict === 'issues' ? issues : [], options: options };
}

// The note's text with one issue's fix put in, or null if the wrong text isn't in the note
// any more (the student already edited it).
export function applyFix(text, issue) {
  if (!issue.wrong || !text.includes(issue.wrong)) {
    return null;
  }
  return text.replace(issue.wrong, issue.fix);
}

// Drops an issue once it's fixed. When the last one goes, the card says it's all fixed.
export function resolveIssue(review, index) {
  const issues = review.issues.filter((_, i) => i !== index);
  if (issues.length > 0) {
    return Object.assign({}, review, { issues: issues });
  }
  return Object.assign({}, review, { verdict: 'correct', message: 'All fixed.', issues: [] });
}

export function addMessage(tutor, role, text) {
  tutor.thread.push({ role: role === 'tutor' ? 'tutor' : 'student', text: text });
}

// Saved form: no pending or error, since those only mean something while the app is open.
export function packTutor(tutor) {
  return { review: tutor.review, thread: tutor.thread };
}

// Anything malformed is dropped instead of breaking the notes open.
export function unpackTutor(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const tutor = emptyTutor();
  tutor.review = normalizeReview(data.review);
  if (Array.isArray(data.thread)) {
    for (const m of data.thread) {
      if (m && typeof m.text === 'string' && m.text.trim() !== '') {
        addMessage(tutor, m.role, m.text);
      }
    }
  }
  return tutor.review === null && tutor.thread.length === 0 ? null : tutor;
}

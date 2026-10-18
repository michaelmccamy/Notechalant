// Sends handwriting to our server, which calls the vision model.
// The API key lives only on the server (see server/).
//
// context is the end of the file's notes so far. The model uses it to read messy letters
// (a word that continues a sentence, a variable name used earlier). It's optional.
// previous is how part of this same handwriting was read before, when a line is read again
// because more was written on it, so letters it already got right stay the same. Also optional.

export async function recognizeImage(pngDataUrl, context, previous) {
  const body = await postApi('/api/recognize', { image: pngDataUrl, context: context || '', previous: previous || '' }, 'Recognition');
  return cleanTranscription(body.text);
}

// POSTs JSON to one of our server's endpoints and returns the JSON answer. Errors come back as
// messages a person can act on. `what` names the feature in them ("Recognition", "Tutor").
export async function postApi(path, payload, what) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }

  if (!response.ok) {
    let message = what + ' failed (' + response.status + ')';
    if (body !== null && body.error) {
      message = body.error;
    } else if (response.status === 404 || response.status >= 500) {
      // Vite's proxy answers this way when the server isn't running (or is an old one).
      message = what + ' server not reachable. Run npm start in server/';
    }
    throw new Error(message);
  }
  return body || {};
}

const NOTHING = '(nothing recognized)';

// Models sometimes wrap the answer in a ```markdown fence even when told not to.
// Returns '' when there's nothing worth adding to the notes.
export function cleanTranscription(text) {
  if (typeof text !== 'string') {
    return '';
  }
  let cleaned = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(cleaned);
  if (fenced) {
    cleaned = fenced[1].trim();
  }
  if (cleaned === NOTHING) {
    return '';
  }
  return cleaned;
}

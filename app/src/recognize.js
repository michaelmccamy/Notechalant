// Sends handwriting to our server, which calls the vision model.
// The API key lives only on the server (see server/).
//
// context is the end of the file's notes so far. The model uses it to read messy letters
// (a word that continues a sentence, a variable name used earlier). It's optional.
// previous is how part of this same handwriting was read before, when a line is read again
// because more was written on it, so letters it already got right stay the same. Also optional.

export async function recognizeImage(pngDataUrl, context, previous) {
  const response = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: pngDataUrl, context: context || '', previous: previous || '' }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = null;
  }

  if (!response.ok) {
    let message = 'Recognition failed (' + response.status + ')';
    if (body !== null && body.error) {
      message = body.error;
    } else if (response.status === 404 || response.status >= 500) {
      // Vite's proxy answers this way when the recognition server isn't running.
      message = 'Recognition server not reachable. Run npm start in server/';
    }
    throw new Error(message);
  }
  return cleanTranscription(body.text);
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

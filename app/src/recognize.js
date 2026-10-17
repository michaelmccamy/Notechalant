// Sends the canvas image to our server, which calls the vision model.
// The API key lives only on the server (see server/).

export async function recognizeImage(pngDataUrl) {
  const response = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: pngDataUrl }),
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
    }
    throw new Error(message);
  }
  return body.text;
}

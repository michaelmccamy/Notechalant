// Shared parsing for every input that carries text: serial, WebSocket, and recordings.
// The format is defined in docs/data-format.md.

const NUMBER_FIELDS = ['t', 'gx', 'gy', 'gz', 'ax', 'ay', 'az'];

// Returns a sample object, or null if the line isn't a valid sample.
// Firmware can print boot messages, so bad lines are skipped instead of throwing.
export function parseSample(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') {
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    return null;
  }

  const sample = {};
  for (let i = 0; i < NUMBER_FIELDS.length; i++) {
    const name = NUMBER_FIELDS[i];
    const value = raw[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    sample[name] = value;
  }
  sample.pen = raw.pen === 1 || raw.pen === true ? 1 : 0;
  return sample;
}

// Text arrives in arbitrary chunks, so a line can be split across two reads.
// push() keeps the unfinished tail and calls onSample for each complete line.
export function createLineSplitter(onSample) {
  let buffer = '';

  function push(chunk) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const sample = parseSample(line);
      if (sample !== null) {
        onSample(sample);
      }
      newline = buffer.indexOf('\n');
    }
  }

  function reset() {
    buffer = '';
  }

  return { push, reset };
}

// Parses a whole recording file into a list of samples.
export function parseRecording(text) {
  const lines = text.split('\n');
  const samples = [];
  for (let i = 0; i < lines.length; i++) {
    const sample = parseSample(lines[i]);
    if (sample !== null) {
      samples.push(sample);
    }
  }
  return samples;
}

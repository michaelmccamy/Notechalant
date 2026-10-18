// The IR remote: an Arduino UNO (firmware/remote/) reads the kit's remote and prints one JSON
// line per press over USB, like {"type":"remote","button":"NEXT_PAGE"}. This reads those lines
// through Web Serial. It's separate from the pen, so the pen can stay on Bluetooth or the relay.

const BAUD_RATE = 115200;

export const REMOTE_BUTTONS = [
  'COLOR',
  'SIZE',
  'PREV_PAGE',
  'NEXT_PAGE',
  'PREV_TAB',
  'NEXT_TAB',
  'RECENTER',
  'CLEAR',
  'PRESENT',
  'EXPLORER_UP',
  'EXPLORER_DOWN',
  'CLEANUP',
  'ASK',
  'TUTOR',
  'TUTOR_OPTION_1',
  'TUTOR_OPTION_2',
  'CALIBRATE',
  'AUTO',
];

// Returns the button name, or null for anything else (boot text, unknown buttons, noise).
export function parseRemoteLine(line) {
  const trimmed = line.trim();
  if (trimmed[0] !== '{') {
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    return null;
  }
  if (raw === null || raw.type !== 'remote' || !REMOTE_BUTTONS.includes(raw.button)) {
    return null;
  }
  return raw.button;
}

// Text arrives in arbitrary chunks, so a line can be split across two reads.
// onOther, if given, gets every non-empty line that isn't a known button, for debugging.
export function createRemoteSplitter(onButton, onOther) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        const button = parseRemoteLine(line);
        buffer = buffer.slice(newline + 1);
        if (button !== null) {
          onButton(button);
        } else if (onOther && line !== '') {
          onOther(line);
        }
        newline = buffer.indexOf('\n');
      }
    },
  };
}

// Asks the user to pick the UNO's port, then calls onButton for each press until disconnect()
// is called or the cable is pulled. onClose runs either way. onOther gets lines that aren't presses.
export async function connectRemote(onButton, onClose, onOther) {
  if (!('serial' in navigator)) {
    throw new Error('The remote needs Chrome or Edge');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: BAUD_RATE });

  const decoder = new TextDecoderStream();
  const pipeDone = port.readable.pipeTo(decoder.writable).catch(function () {});
  const reader = decoder.readable.getReader();
  const splitter = createRemoteSplitter(onButton, onOther);
  let closed = false;

  async function readLoop() {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        splitter.push(result.value);
      }
    } catch (err) {
      console.warn('Remote read stopped', err);
    } finally {
      reader.releaseLock();
      await pipeDone;
      await port.close().catch(function () {});
      closed = true;
      onClose();
    }
  }

  readLoop();

  async function disconnect() {
    if (closed) {
      return;
    }
    await reader.cancel().catch(function () {});
  }

  return { disconnect };
}

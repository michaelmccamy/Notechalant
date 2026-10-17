// USB serial input through the Web Serial API. Chrome and Edge only, on localhost or https.

import { createLineSplitter } from './parseSample.js';

const BAUD_RATE = 115200;

export function serialSupported() {
  return 'serial' in navigator;
}

// Asks the user to pick a port, then streams samples to onSample until disconnect() is called
// or the cable is pulled. onClose runs either way.
export async function connectSerial(onSample, onClose) {
  if (!serialSupported()) {
    throw new Error('Web Serial needs Chrome or Edge');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: BAUD_RATE });

  const decoder = new TextDecoderStream();
  const pipeDone = port.readable.pipeTo(decoder.writable).catch(function () {});
  const reader = decoder.readable.getReader();
  const splitter = createLineSplitter(onSample);
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
      console.warn('Serial read stopped', err);
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

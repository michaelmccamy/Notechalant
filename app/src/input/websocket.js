// WiFi input. The ESP32 runs a WebSocket server and the browser connects to it.
// Each message can hold one or more sample lines.

import { createLineSplitter } from './parseSample.js';

export function connectWebSocket(url, onSample, onOpen, onClose) {
  const splitter = createLineSplitter(onSample);
  const socket = new WebSocket(url);

  socket.addEventListener('open', function () {
    onOpen();
  });

  socket.addEventListener('message', function (event) {
    if (typeof event.data !== 'string') {
      return;
    }
    // Firmware may or may not end each message with a newline. Adding one is harmless
    // because empty lines are skipped.
    splitter.push(event.data + '\n');
  });

  socket.addEventListener('close', function () {
    onClose();
  });

  function disconnect() {
    socket.close();
  }

  return { disconnect };
}

// Relay input. The ESP32 connects to relay/relay.js on the laptop, and the browser connects
// here to receive its samples. Unlike the direct WiFi input, this keeps retrying, so restarting
// the relay or power cycling the pen doesn't need a click.
//
// The relay sends one JSON message at a time:
//   {"type":"sample", t, gx, gy, gz, ax, ay, az, pen}
//   {"type":"status", "pens": N}   when a pen connects or disconnects

import { parseSample } from './parseSample.js';

export const RELAY_URL = 'ws://localhost:8080/app';
const RETRY_MS = 1000;

// Streams samples to onSample until disconnect() is called.
// onStatus gets { relay, pens, rate } on every change and once a second, where rate is
// samples received in the last second.
export function connectRelay(url, onSample, onStatus) {
  let socket = null;
  let retryTimer = null;
  let stopped = false;
  let relayUp = false;
  let pens = 0;
  let count = 0;
  let rate = 0;

  function report() {
    onStatus({ relay: relayUp, pens: pens, rate: rate });
  }

  function open() {
    socket = new WebSocket(url);

    socket.addEventListener('open', function () {
      relayUp = true;
      report();
    });

    socket.addEventListener('message', function (event) {
      if (typeof event.data !== 'string') {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (msg.type === 'status') {
        pens = typeof msg.pens === 'number' ? msg.pens : 0;
        report();
      } else if (msg.type === 'sample') {
        // Same validation as USB and WiFi. The extra "type" field is ignored.
        const sample = parseSample(event.data);
        if (sample !== null) {
          count++;
          onSample(sample);
        }
      }
    });

    // A failed connection attempt also lands here, so this is the only retry path.
    socket.addEventListener('close', function () {
      const wasUp = relayUp;
      relayUp = false;
      pens = 0;
      // After disconnect() the caller has moved on, so stay quiet.
      if (stopped) {
        return;
      }
      if (wasUp) {
        report();
      }
      retryTimer = setTimeout(open, RETRY_MS);
    });
  }

  const rateTimer = setInterval(function () {
    rate = count;
    count = 0;
    report();
  }, 1000);

  open();
  report();

  function disconnect() {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(rateTimer);
    socket.close();
  }

  return { disconnect };
}

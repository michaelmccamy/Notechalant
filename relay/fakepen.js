// Fake pen: pretends to be the ESP32 so you can test without hardware.
// Run (with relay.js already running):  node fakepen.js
// It "writes" loops in the air: pen down for 2 seconds, up for 1 second.

const WebSocket = require("ws");
const url = process.argv[2] || "ws://localhost:8080/pen";
const ws = new WebSocket(url);

ws.on("open", () => {
  console.log(`Fake pen connected to ${url}`);
  const start = Date.now();
  setInterval(() => {
    const t = Date.now() - start;
    const s = t / 1000;
    const sample = {
      t,
      gx: +(120 * Math.cos(s * 3)).toFixed(2),
      gy: +(120 * Math.sin(s * 3)).toFixed(2),
      gz: +(30 * Math.sin(s * 1.3)).toFixed(2),
      ax: 0,
      ay: 0,
      az: 1,
      pen: s % 3 < 2 ? 1 : 0,
    };
    ws.send(JSON.stringify(sample));
  }, 10); // 100 samples per second
});

ws.on("error", (e) => console.log("Could not connect:", e.message));
ws.on("close", () => process.exit(0));

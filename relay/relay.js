// Air pen relay: receives samples from the pen and forwards them to the app.
// Run:  node relay.js
// Pen (ESP32) connects to   ws://<laptop ip>:8080/pen
// App (browser) connects to ws://localhost:8080/app

const { WebSocketServer } = require("ws");
const os = require("os");

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

const apps = new Set();
let pens = 0;
let samples = 0;

wss.on("connection", (ws, req) => {
  const path = req.url || "/";

  if (path.startsWith("/app")) {
    apps.add(ws);
    console.log(`App connected (${apps.size} open)`);
    ws.send(JSON.stringify({ type: "status", pens }));
    ws.on("close", () => {
      apps.delete(ws);
      console.log(`App disconnected (${apps.size} open)`);
    });
    return;
  }

  if (path.startsWith("/pen")) {
    pens++;
    console.log(`Pen connected from ${req.socket.remoteAddress}`);
    broadcast(JSON.stringify({ type: "status", pens }));

    ws.on("message", (data) => {
      const text = data.toString();
      // The pen may batch several samples, one JSON object per line.
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line);
          if (typeof s.gx !== "number" || typeof s.pen !== "number") continue;
          samples++;
          broadcast(JSON.stringify({ type: "sample", ...s }));
        } catch {
          // Ignore malformed lines instead of crashing mid demo.
        }
      }
    });

    ws.on("close", () => {
      pens--;
      console.log("Pen disconnected");
      broadcast(JSON.stringify({ type: "status", pens }));
    });
    return;
  }

  ws.close(1008, "Use /pen or /app");
});

function broadcast(msg) {
  for (const app of apps) {
    if (app.readyState === app.OPEN) app.send(msg);
  }
}

// Print a rate every second so you can see data is flowing.
setInterval(() => {
  if (pens > 0) console.log(`${samples} samples/sec`);
  samples = 0;
}, 1000);

// Show every address the ESP32 could use. Interface order isn't reliable and a VPN
// (Tailscale shows up as utun) can come first, so list them all instead of guessing.
const addrs = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
  (list || [])
    .filter((i) => i.family === "IPv4" && !i.internal)
    .map((i) => ({ name, address: i.address }))
);
console.log(`Relay running on port ${PORT}`);
console.log(`App URL:  ws://localhost:${PORT}/app`);
console.log("Pen URL, one per network interface:");
for (const a of addrs) {
  const hint = a.name === "en0" ? "   <- likely your WiFi (en0 on a Mac)" : "";
  console.log(`  ${a.name.padEnd(8)} ws://${a.address}:${PORT}/pen${hint}`);
}
if (addrs.length === 0) console.log("  none found, join a WiFi network first");
console.log("The ESP32 must use the address on the same network it joins.");

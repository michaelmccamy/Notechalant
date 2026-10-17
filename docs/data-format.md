# Pen data format

Every part of the system speaks this format. If you need to change it, tell the whole team first.

## One sample

One JSON object per line, about 100 lines per second, each line ending in `\n`.

```json
{"t":15320,"gx":-1.25,"gy":3.50,"gz":12.75,"ax":0.02,"ay":-0.01,"az":0.98,"pen":0}
```

| Field | Meaning | Type and units |
|---|---|---|
| `t` | Time of the reading | Integer, milliseconds since the board booted (`millis()`) |
| `gx` `gy` `gz` | Gyroscope rotation speed | Float, **degrees per second**, already scaled from raw counts |
| `ax` `ay` `az` | Accelerometer | Float, **g** (1.0 is gravity), already scaled from raw counts |
| `pen` | Button state | `1` while pressed, `0` otherwise |

Scaling for the MPU6050 at its default ranges (±250 °/s, ±2 g)

- gyro degrees per second = raw / 131.0
- accel g = raw / 16384.0

If you change the sensor range in firmware, change the divisor to match.

## Transport

- **WiFi through the relay (primary).** The ESP32 is a WebSocket *client*. It joins the same WiFi network as the laptop and connects to `ws://<laptop ip>:8080/pen`, where `relay/relay.js` is running. Each message holds one or more lines in the same format. The relay checks each line and forwards it to the browser at `ws://localhost:8080/app`, wrapped as `{"type":"sample", ...}`. When a pen connects or disconnects it also sends `{"type":"status","pens":N}`. The relay prints the exact pen URL when it starts.
- **USB serial** at 115200 baud. Firmware may print other text at boot. The app skips any line that isn't valid JSON with all eight fields.
- **WiFi direct (fallback).** The ESP32 hosts its own network and a WebSocket server at `ws://192.168.4.1:81`, and the browser connects straight to it. Each message holds one or more lines in the same format.

Why the relay is primary: with direct WiFi, the laptop has to join the pen's own network, so it loses internet and the recognition server can't reach Gemini. With the relay, the pen and laptop share the venue WiFi (or a phone hotspot) and the laptop stays online. The relay also lets the app reconnect on its own when the pen restarts.

## Recording files

Recordings in `data/recordings/` use the same format, one sample per line, with the extension `.jsonl`. Name them after what was written, like `hello-michael.jsonl` or `circle-slow.jsonl`. Start each recording with about 2 seconds of holding the pen still so calibration has data to work with.

## Confirm tonight

- [ ] Gyro and accel are scaled in firmware, not sent raw
- [ ] Which gyro axis moves the cursor left and right when the pen is held normally (default guess `gz`)
- [ ] Which gyro axis moves it up and down (default guess `gy`)
- [ ] Sign of each axis, so moving right goes right on screen
- [ ] Sample rate holds near 100 Hz on both the STM32 and the ESP32

The axis mapping is a setting in `app/src/motion/index.js`, so getting it wrong tonight costs one line, not a rewrite.

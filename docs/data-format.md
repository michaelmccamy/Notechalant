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

- **Bluetooth Low Energy (primary).** The ESP32 is a BLE peripheral and the browser connects to it with Web Bluetooth. Samples are packed binary, not JSON, to fit 100 a second into small packets. See the next section.
- **WiFi through the relay.** The ESP32 is a WebSocket *client*. It joins the same WiFi network as the laptop and connects to `ws://<laptop ip>:8080/pen`, where `relay/relay.js` is running. Each message holds one or more lines in the same format. The relay checks each line and forwards it to the browser at `ws://localhost:8080/app`, wrapped as `{"type":"sample", ...}`. When a pen connects or disconnects it also sends `{"type":"status","pens":N}`. The relay prints the exact pen URL when it starts.
- **USB serial** at 115200 baud. Firmware may print other text at boot. The app skips any line that isn't valid JSON with all eight fields.
- **WiFi direct (fallback).** The ESP32 hosts its own network and a WebSocket server at `ws://192.168.4.1:81`, and the browser connects straight to it. Each message holds one or more lines in the same format.

Why Bluetooth is primary: it needs no network at all, so venue WiFi, 5 GHz hotspots, and IP addresses don't matter, and the laptop stays on its normal internet for recognition. The relay is the WiFi option when the pen has to be farther away than Bluetooth reaches. Direct WiFi is a last resort: the laptop has to join the pen's own network, so it loses internet and the recognition server can't reach Gemini.

## Bluetooth binary format

| Name | UUID |
|---|---|
| Device name | `Notechalant Pen` |
| Service | `4cc3af8c-894d-445a-bb7f-68e6168c437a` |
| Samples characteristic (notify) | `78580580-0b8c-4764-951e-14f13c488905` |

Each notification holds one or more 17-byte samples back to back, little endian:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `t` | uint32 | Milliseconds since boot, same as JSON |
| 4 | `gx` | int16 | Raw gyro counts. Divide by 131.0 for degrees per second |
| 6 | `gy` | int16 | Same |
| 8 | `gz` | int16 | Same |
| 10 | `ax` | int16 | Raw accel counts. Divide by 16384.0 for g |
| 12 | `ay` | int16 | Same |
| 14 | `az` | int16 | Same |
| 16 | `pen` | uint8 | `1` while pressed, `0` otherwise |

The divisors are the same ones as in the scaling section above, so if the sensor range changes, change them in `app/src/input/bluetooth.js` too. The app decodes each sample into the same object the JSON inputs produce.

The pen asks for a 247-byte MTU, so a notification can carry up to 14 samples. It sends one notification every 20 ms, usually 2 samples. If the connection ends up with a smaller MTU, it sends more notifications with fewer samples each. Bytes at the end that don't make a whole sample are ignored.

## Recording files

Recordings in `data/recordings/` use the same format, one sample per line, with the extension `.jsonl`. Name them after what was written, like `hello-michael.jsonl` or `circle-slow.jsonl`. Start each recording with about 2 seconds of holding the pen still so calibration has data to work with.

### Debug recordings

The app's debug panel (press **D**, then **Record**) saves `debug-<date>T<time>.jsonl` files for `data/recordings/debug/`. Each sample line is a normal sample with three extra fields: `dx` and `dy`, the cursor movement in pixels the motion module produced for it, and `ready`, false while calibrating or running the axis wizard. Settings lines are mixed in:

```json
{"type":"settings","t":15320,"source":"bluetooth","recordedAt":"2026-10-17T21:30:05.000Z","config":{"xVector":[0.47,-0.43,0.77],"yVector":[-0.8,-0.55,0.23],"pixelsPerDegree":12,"smoothing":0,"smoothingBeta":0.02,"deadzone":0,"calibrationMs":2000,"maxGapMs":50},"bias":{"gx":-1.2,"gy":1.29,"gz":0.82}}
{"t":15320,"gx":-1.25,"gy":3.5,"gz":12.75,"ax":0.02,"ay":-0.01,"az":0.98,"pen":0,"dx":1.84,"dy":-0.2,"ready":true}
```

A settings line comes first and again whenever the motion settings or the measured bias change, and applies to the samples after it. `bias` is `null` until calibration finishes. `source` is the input that was running (`bluetooth`, `serial`, `relay`, `wifi`, `recording`), or `null`. Settings lines don't have the sample fields, so **Load recording** skips them and replays the samples as usual.

## Confirm tonight

- [ ] Gyro and accel are scaled in firmware, not sent raw
- [ ] Which gyro axis moves the cursor left and right when the pen is held normally (default guess `gz`)
- [ ] Which gyro axis moves it up and down (default guess `gy`)
- [ ] Sign of each axis, so moving right goes right on screen
- [ ] Sample rate holds near 100 Hz on both the STM32 and the ESP32

The axis mapping is a setting in `app/src/motion/index.js`, so getting it wrong tonight costs one line, not a rewrite.

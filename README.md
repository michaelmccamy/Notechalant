# Notechalant

Write on any screen from across the room. Circle anything to get it explained.

Notechalant is a pen with a motion sensor and a touch pad, plus a browser app. Hold your finger on the pad and write in the air: the ink appears on the page, turns into typed text and math, and goes into your notes. Circle a question on a slide and an answer card pops up next to it, or turn on Tutor and get a hint instead.

```
MPU6050 + touch pad -> XIAO ESP32-S3 -> Bluetooth LE -> browser app -> Gemini -> typed notes, answers, hints
```

Built at SwampHacks XII, for about $25 in parts.

## The demo

1. **Write.** Write `2x + 3 = 7` in the air. A moment after you pause, the handwriting turns into typed math on the page, and the same text appears in the Notes panel.
2. **Circle to ask.** Turn on **Ask**, point at a problem on the slides (`data/samples/demo-slides.pdf`), and circle or underline it. A large card next to it walks through the answer.
3. **Get a hint instead.** Turn on **Tutor** and do the same. The card gives a hint rather than the answer, and a conversation starts in Notes, where you can reply ("is it 2 and 3?") and keep going.
4. **Start fresh.** Triple tap the pad to clear the page. Undo brings it back.

## What it does

**Writing**
- The pen writes like a mouse: the ink moves by how much you turn the pen, so your hand can stay in one comfortable place. Ink is drawn smaller and steadier than your hand moves, and each stroke is smoothed when you lift the pen.
- With **Ask** on, the pen aims like a laser pointer instead, so you can point at something on a slide and circle it.
- **Clean up** (switch): rough lines, circles, and boxes snap to clean ones, and after a pause your handwriting is replaced by typed text, with math typeset. Undo brings back what you drew.
- **Auto** (switch): after each pause, new writing is typed up into the Notes panel. With it off, press **Enter**.
- **Eraser** (button or **E**) removes strokes and typed words it passes over.

**Asking and the tutor**
- **Ask** (switch): circling or underlining something sends a picture of it to Gemini, and the answer shows in a card next to it, big enough to read from across a room. It's also saved in the notes.
- **Tutor** (button): with it on, asking gives hints instead of answers, and the tutor also reads what you write, pointing out grammar, spelling, math, and fact mistakes with one-click fixes. You can ask it about any note, or about the whole page.

**Files and notes**
- Write on the whiteboard, or open a folder or file: PDF, Word, PowerPoint, Excel, text, Markdown, CSV, JSON, and images. Your files are never changed. Ink is saved next to them in a `.notechalant/` folder.
- **Save copy** makes a new file with your ink on it: the PDF with vector ink, an image in the same format, or a PDF of the pages for everything else.
- The **Notes** panel holds the typed-up text for each file, in page order. Click a note to edit it. **Copy**, **Export .md**, and **Clear** are at the top.
- **Present mode** (**P**) hides everything but the page. The IR remote works as a clicker: it changes colors, sizes, pages, and tabs, toggles present mode, and its buttons 1 to 7 switch Clean up, Ask, Tutor, and Auto, answer the tutor's quick questions, and run calibration (see `firmware/remote/README.md`).

## Hardware

| Part | Notes |
|---|---|
| Seeed XIAO ESP32-S3 | Reads the sensor and pad at 100 Hz, sends over Bluetooth LE and USB |
| MPU6050 | Gyro and accelerometer, on I2C (SDA to D4, SCL to D5) |
| Touch pad | Bare metal (a jumper pin or copper tape) wired to D1. The pen is down while a finger touches it |
| Arduino UNO + IR remote (optional) | A clicker for the app |

Wiring, flashing, and touch pad tuning are in `firmware/esp32/README.md`. The remote is in `firmware/remote/README.md`.

## Running it

You need Node 20 or newer, and Chrome or Edge (Web Bluetooth doesn't work in Firefox or Safari).

```bash
# 1. The app
cd app
npm install
npm run dev

# 2. Recognition, in a second terminal
cd server
cp .env.example .env     # then put your Gemini key and model in .env
npm start
```

Open the URL Vite prints. The app forwards `/api` requests to the server on port 8787, which keeps the API key off the page. You can draw with the mouse without the pen.

### Connecting the pen

1. Flash `firmware/esp32` with `WIFI_SSID` set to `""` in `secrets.h`. Power the pen from USB or a battery. Don't touch the pad while it boots: it measures the pad's resting value first. Its LED blinks while it waits for the app.
2. Click **Connect pen** and pick **Notechalant Pen** in the chooser.
3. Hold the pen still for about 2 seconds while the card on the page says to. Moving restarts it.
4. Press **K** (or **Calibrate screen**) and point at the page's four corners, tapping the pad at each one. Keep your hand in one place and tilt the pen to aim. Ask mode uses this to aim, and writing uses it for its scale.

If the pen drops out, the app reconnects on its own. On a Mac, Chrome needs Bluetooth permission: **System Settings > Privacy & Security > Bluetooth**, turn on Chrome, then quit and reopen it.

## Controls

| Pen | Does |
|---|---|
| Finger on the pad | Pen down: draw |
| Double tap | Recenter: the cursor jumps to where the pen points |
| Triple tap | Clear the page (Undo brings it back) |

| Key | Does |
|---|---|
| **Enter** | Type up new writing now |
| **K** | Calibrate the screen corners |
| **R** | Recalibrate the gyro (hold still), if the cursor drifts |
| **C** | Recenter |
| **E** | Eraser on or off |
| **P** | Present mode, **Esc** leaves it |
| **Ctrl/Cmd+Z** | Undo |
| **Ctrl/Cmd+S** | Save a copy with the ink on it |
| **Page Up / Page Down** | Previous or next page |
| **Space** (hold) | Pen down, for testing without the pad |
| **D** | Debug panel: live gyro graphs, recording, and tuning sliders (writing gain, string length, travel speed) |

## How it works

- **Motion** (`app/src/motion/`). The gyro's bias is measured while the pen is still. Gravity from the accelerometer gives up and down, so rolling the pen in your hand doesn't mix up the directions. Corner calibration maps where the pen points onto the page with a homography, so pointing works from any distance or angle. For writing, turns are scaled down and moved like a mouse, with acceleration when the pen is lifted.
- **Ink** (`app/src/ink/`). A lazy brush (the ink trails the cursor on a short string) removes wobble, strokes get a Catmull-Rom curve fit when the pen lifts, and shapes snap to lines, ellipses, and rectangles.
- **Recognition** (`server/`, or `api/` on Vercel). New strokes go to Gemini as a picture and come back as text, with math as LaTeX. Circle to ask and the tutor send a picture of what you marked, plus the page for context.
- **Testing on real data** (`data/recordings/debug/`). The debug panel's **Record** saves raw pen data. `tools/stroke-straightness.mjs` replays recordings through the motion code to compare settings, and `npm test` in `app/` runs the motion, ink, gesture, and notes tests.

## Repo layout

| Path | What's there |
|---|---|
| `app/` | The browser app (Vite) and its tests |
| `server/` | Recognition, explain, and tutor endpoints for local use |
| `api/` | The same endpoints as Vercel functions |
| `firmware/esp32/` | The pen's firmware |
| `firmware/remote/` | The IR remote's Arduino sketch |
| `relay/` | WebSocket relay for the WiFi path, plus a fake pen |
| `data/recordings/` | Recorded pen data for testing without hardware |
| `data/samples/` | `demo-slides.pdf`, the slides for the demo (`tools/make-demo-slides.mjs` builds them) |
| `docs/data-format.md` | The sample format and the Bluetooth protocol |
| `tools/` | Scripts: demo slides, synthetic data, stroke analysis |

## Deploying to Vercel

`vercel.json` builds the app from `app/` and serves `api/` as functions using the same Gemini code as `server/`. In the Vercel project, set `GEMINI_API_KEY` and `GEMINI_MODEL`, then open `/api/health` on the deployed site to check them. Bluetooth works from the deployed page.

## Other inputs, for development

The debug panel (**D**) has buttons for inputs used while building it:

- **Load recording** replays a `.jsonl` file at real speed, to test the whole pipeline with no hardware. Try `data/recordings/synthetic/shapes.jsonl`.
- **USB** reads the pen over Web Serial at 115200 baud.
- **Relay** reads the pen through `relay/` over WiFi (`cd relay && npm run relay`, and `npm run fakepen` for a fake one). The pen needs a WiFi network in `secrets.h`. See `docs/data-format.md`.
- **WiFi** connects straight to a WebSocket server on the pen, as a fallback.

Never commit `.env` or `secrets.h`. Both are in `.gitignore`.

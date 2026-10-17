# Notechalant

Turn any screen into a whiteboard you can write on from anywhere in the room, for about $25 in parts.

A pen with a motion sensor streams its rotation to a laptop app. The app turns small wrist movements into a cursor, draws ink while the button is held, and turns the writing into typed text or math.

```
MPU6050 -> XIAO ESP32-S3 -> WiFi (WebSocket) -> browser app -> recognition -> output
```

Built at SwampHacks XII.

## Repo layout

| Path | What lives there | Owner |
|---|---|---|
| `docs/data-format.md` | The sample format every part of the system agrees on | Everyone |
| `firmware/stm32-test/` | Tonight's USB serial test on the STM32 | CpE 1 |
| `firmware/esp32/` | WiFi and WebSocket firmware for the real pen | CpE 1 |
| `data/recordings/` | Recorded pen data (`.jsonl`) for testing without hardware | CpE 1 |
| `app/src/motion/` | Gyro to cursor movement, calibration, smoothing | CpE 2 |
| `app/src/` (everything else) | Canvas, inputs, slides, toolbar | CS |
| `server/` | Recognition endpoint that keeps the API key off the frontend | CpE 3 |
| `tools/` | Small scripts, like the synthetic data generator | Anyone |

Stay inside your own folder when you can. It keeps merge conflicts close to zero.

## Running it

You need Node 20 or newer and Chrome or Edge (Web Serial does not work in Firefox or Safari).

```bash
cd app
npm install
npm run dev
```

Open the URL Vite prints. Draw with the mouse to check the canvas, then click **Load recording** and pick `data/recordings/synthetic/shapes.jsonl` to watch the full pen pipeline run with no hardware.

`npm test` checks the sample parser and the motion math.

For recognition, run the server in a second terminal.

```bash
cd server
cp .env.example .env     # then put your Gemini key and model in .env
npm start
```

The app's dev server forwards `/api` requests to it on port 8787.

## Inputs

All hardware inputs end up calling the same function, `onPenData(sample)`, in `app/src/input/hub.js`.

- **Mouse** draws directly on the canvas. Use it to test anything ink related.
- **Load recording** replays a `.jsonl` file at real speed. This tests the full pipeline with no hardware.
- **USB** connects to the STM32 or ESP32 over Web Serial at 115200 baud.
- **WiFi** connects to the ESP32's WebSocket server.

Hold **Space** to force pen down. This stands in for the button until it's wired.

Press **C** to recenter the cursor and **R** to recalibrate the motion module.

## Workflow

- Branch per person (`firmware`, `motion`, `app`, `recognition`), merge to `main` often.
- Commit with real messages. Judges read the history.
- Never commit `.env` or API keys. It's already in `.gitignore`.

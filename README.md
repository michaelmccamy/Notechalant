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
| `relay/` | WebSocket relay from the pen to the app, plus a fake pen for testing | CpE 1 |
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

### Running with the relay

The pen sends its data over WiFi to a small relay on the laptop, and the app reads from the relay. Use three terminals.

```bash
# 1. Relay. Prints the URL the ESP32 should connect to.
cd relay
npm install
npm run relay

# 2. Fake pen, if the hardware isn't ready. Draws loops, pen down 2s, up 1s.
cd relay
npm run fakepen

# 3. App
cd app
npm run dev
```

Open the app and click **Relay**. The toolbar shows whether the relay and pen are connected, and the pen's sample rate, which should be about 100/s. If the relay or the pen restarts, the app reconnects on its own. Click **Relay** again to turn it off.

For the real pen, skip step 2. The laptop and ESP32 must be on the same WiFi network, and the firmware connects to the pen URL for that network, which the relay prints for each interface. Skip VPN interfaces like `utun` (Tailscale), since the ESP32 can't reach them. On a Mac, run `ipconfig getifaddr en0` to confirm your WiFi address. See `docs/data-format.md` for why this is the main WiFi path.

## Deploying to Vercel

`vercel.json` builds the app from `app/` and serves `api/recognize.mjs` as a function that uses the same Gemini code as `server/`. In the Vercel project, set the environment variables `GEMINI_API_KEY` and `GEMINI_MODEL`, then open `/api/health` on the deployed site to check them.

The relay can't run on Vercel, so keep running `npm run relay` on the laptop. The deployed page still connects to it at `ws://localhost:8080/app`. Chrome may ask once to allow local network access. **USB** works too. **WiFi** direct does not, because browsers block `ws://` to the pen's own network from an `https` page.

## Inputs

All hardware inputs end up calling the same function, `onPenData(sample)`, in `app/src/input/hub.js`.

- **Mouse** draws directly on the canvas. Use it to test anything ink related.
- **Load recording** replays a `.jsonl` file at real speed. This tests the full pipeline with no hardware.
- **Relay** receives the pen through `relay/relay.js` and reconnects on its own. This is the main WiFi path.
- **USB** connects to the STM32 or ESP32 over Web Serial at 115200 baud.
- **WiFi** connects straight to a WebSocket server on the ESP32. This is the fallback, if the pen hosts its own network.

Hold **Space** to force pen down. This stands in for the button until it's wired.

Press **C** to recenter the cursor and **R** to recalibrate the motion module.

## Workflow

- Branch per person (`firmware`, `motion`, `app`, `recognition`), merge to `main` often.
- Commit with real messages. Judges read the history.
- Never commit `.env` or API keys. It's already in `.gitignore`.

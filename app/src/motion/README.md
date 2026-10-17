# Motion

Owner is CpE 2. This folder turns raw gyro samples into cursor movement.

## The contract

`index.js` must export `createMotion(config)`, which returns an object with

- `update(sample)` takes one sample (format in `docs/data-format.md`) and returns `{ dx, dy, ready }`
  - `dx`, `dy` are how far to move the cursor, in screen pixels, for this sample
  - `ready` is `false` while calibrating, and the app ignores movement until it's `true`
- `reset()` starts over, including calibration. The app calls it when the user presses **R**.
- `config` is the live settings object, so a tuning slider can change values on the fly.

Everything else in this folder is yours. Split it into as many files as you want.

## Suggested order

1. **Bias calibration.** Average the gyro for the first 2 seconds while the pen is still, subtract that from every sample after. Return `ready: false` until it's done.
2. **Axis mapping.** Confirm which axis is left and right and which is up and down on the real pen, and the signs. Change `xAxis`, `yAxis`, `invertX`, `invertY`.
3. **One Euro filter** on `dx` and `dy` (or on the gyro rates) so slow movement is smooth and fast movement stays responsive.
4. **Dead zone** so tiny hand tremor while holding still doesn't move the cursor.
5. **Tuning** on the live pen. Sensitivity and filter settings are the knobs.

## Testing without the pen

Load `data/recordings/synthetic/shapes.jsonl` in the app. It traces a circle, a square, and a check mark, with a small gyro bias and noise built in. With the placeholder you'll see the shapes drift and wobble. Once calibration and filtering work, they should come out clean.

The generator in `tools/make-synthetic.mjs` documents the exact bias and noise it adds.

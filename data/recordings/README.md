# Recordings

Pen data captured from real hardware, in the format from `docs/data-format.md`. Load any of these in the app with **Load recording**.

To record from the STM32, log the serial output to a file, for example with the Arduino serial monitor's save option or

```bash
# macOS or Linux, replace the port name
cat /dev/tty.usbmodem1234 > hello.jsonl
```

Delete any boot text at the top of the file before committing.

`synthetic/` holds generated data made by `tools/make-synthetic.mjs`. It traces known shapes with a small built-in gyro bias and noise, so it's useful for testing calibration and smoothing against a known answer. Replace it with real recordings as soon as they exist.

`debug/` holds files saved by the app's debug panel (**D**, then **Record**). They add the motion module's output and settings to each sample, so motion bugs can be fixed from real data.

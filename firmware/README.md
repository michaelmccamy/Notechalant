# Firmware

Owner is CpE 1.

- `stm32-test/` prints samples from the MPU6050 over USB serial tonight, so the app has real data before the ESP32 arrives.
- `esp32/` is the real pen. It reads the MPU6050 and the button, joins WiFi, and sends samples to the relay (`relay/relay.js`) on port 8080. It also prints them over USB. See `esp32/README.md`.

Both must output the format in `docs/data-format.md` exactly. Until the button exists, send `"pen":0` and use the spacebar in the app as pen down.

To check output without the app, open the Arduino serial monitor at 115200 baud. You should see one JSON line per sample and nothing else after boot.

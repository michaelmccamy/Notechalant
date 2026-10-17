# ESP32 pen firmware

Runs on a Seeed XIAO ESP32S3. It reads the MPU6050 and the button at 100 Hz and sends each sample in the format from `docs/data-format.md` two ways at once: over WiFi to the relay (`relay/relay.js`), and over USB serial as a fallback.

## Wiring

| MPU6050 / button | XIAO pin | GPIO |
|---|---|---|
| VCC | 3V3 | |
| GND | GND | |
| SDA | D4 | 5 |
| SCL | D5 | 6 |
| Button, one leg | D1 | 2 |
| Button, other leg | GND | |

The button uses the internal pull-up, so no resistor is needed. Leave the MPU6050's AD0 pin unconnected or tied to GND (address 0x68).

## WiFi settings

```bash
cd firmware/esp32
cp secrets.example.h secrets.h
```

Edit `secrets.h`:

- `WIFI_SSID` and `WIFI_PASSWORD`: the network the laptop is on. Leave the SSID empty (`""`) for USB only.
- `RELAY_HOST`: the laptop's IP. Start the relay (`cd relay && npm run relay`) and use the address on the `en0` line, or run `ipconfig getifaddr en0` on a Mac.

`secrets.h` is gitignored, so each person keeps their own.

**iPhone hotspot:** turn on **Maximize Compatibility** in Settings > Personal Hotspot. The ESP32 only supports 2.4 GHz, and without that setting the hotspot may be 5 GHz only, so the pen never finds it.

## Flashing

One-time setup:

```bash
brew install arduino-cli
arduino-cli config init
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli lib install WebSockets   # links2004/arduinoWebSockets
```

Build and flash, from the repo root:

```bash
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3 firmware/esp32
arduino-cli upload  --fqbn esp32:esp32:XIAO_ESP32S3 -p /dev/cu.usbmodem* firmware/esp32
arduino-cli monitor -p /dev/cu.usbmodem* -c baudrate=115200
```

In the Arduino IDE instead: pick the board **XIAO_ESP32S3**, install **WebSockets by Markus Sattler** from the library manager, then open `esp32.ino`.

If the upload can't find the board, hold **BOOT**, tap **RESET**, release BOOT, and upload again.

## What you should see

The serial monitor shows status lines first, then one JSON line per sample:

```
Notechalant pen starting
MPU6050 found (WHO_AM_I 0x68)
WiFi connecting to "your-network"
WiFi connected. IP 192.168.1.40. Connecting to relay at 192.168.1.23:8080
Relay connected: ws://192.168.1.23:8080/pen
{"t":3021,"gx":-0.31,"gy":0.42,"gz":0.18,"ax":0.01,"ay":-0.02,"az":0.99,"pen":0}
```

Status lines never start with `{`, so the app skips them. The relay prints `Pen connected` and about 100 samples/sec.

| LED | Meaning |
|---|---|
| Blinking | Connecting to WiFi or the relay |
| Solid | Sending to the relay |

USB output keeps working whatever the LED shows, so the app's **USB** button is the fallback if WiFi fails.

# ESP32 pen firmware

Runs on a Seeed XIAO ESP32S3. It reads the MPU6050 and a capacitive touch pad at 100 Hz and sends each sample in the format from `docs/data-format.md` over Bluetooth Low Energy and USB serial at once, and over WiFi to the relay (`relay/relay.js`) if a WiFi network is set.

## Wiring

| MPU6050 / touch pad | XIAO pin | GPIO |
|---|---|---|
| VCC | 3V3 | |
| GND | GND | |
| SDA | D4 | 5 |
| SCL | D5 | 6 |
| Touch pad (bare metal under the finger) | D1 | 2 |

Leave the MPU6050's AD0 pin unconnected or tied to GND (address 0x68).

### Touch pad

The pen is down while a finger touches the pad. D1 is one of the S3's touch pins, and the pad connects to it with a single wire and nothing else, no resistor and no ground. The finger has to touch **bare metal**: a jumper pin, copper tape, or foil. Through plastic or tape the signal is too weak. Keep the wire short, since a long loose wire picks up a hand that's only near it.

At startup the pen averages the untouched reading for 1 second, so **don't touch the pad while it boots**. After that the pen goes down once the reading is 80% above that baseline and back up once it drops below 50%, then a 20 ms debounce. On the test pin a finger added 140 to 380%, while a gripping or hovering hand moved it at most about 35%. If a new pad needs different values, change `TOUCH_DOWN_RATIO` and `TOUCH_UP_RATIO` in `esp32.ino`, using the status line below.

## WiFi settings

```bash
cd firmware/esp32
cp secrets.example.h secrets.h
```

Edit `secrets.h`:

- `WIFI_SSID` and `WIFI_PASSWORD`: the network the laptop is on. Leave the SSID empty (`""`) for Bluetooth and USB only. That's the normal setup now.
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
Measuring touch baseline. Don't touch the pen
Touch baseline 23362. Pen down above 42051, up below 35043
No WiFi in secrets.h. Bluetooth and USB only
Bluetooth advertising as "Notechalant Pen"
Bluetooth connected
{"t":3021,"gx":-0.31,"gy":0.42,"gz":0.18,"ax":0.01,"ay":-0.02,"az":0.99,"pen":0}
Touch 23356, baseline 23362 (-0.0%), pen 0
```

The `Touch` line repeats every second with the live reading and how far it is from the baseline.

With WiFi set, you see this instead of the "No WiFi" line:

```
WiFi connecting to "your-network"
WiFi connected. IP 192.168.1.40. Connecting to relay at 192.168.1.23:8080
Relay connected: ws://192.168.1.23:8080/pen
{"t":3021,"gx":-0.31,"gy":0.42,"gz":0.18,"ax":0.01,"ay":-0.02,"az":0.99,"pen":0}
```

Status lines never start with `{`, so the app skips them. The relay prints `Pen connected` and about 100 samples/sec.

| LED | Meaning |
|---|---|
| Blinking | Advertising over Bluetooth, and not connected to the relay |
| Solid | Connected over Bluetooth or to the relay |

The pen advertises again on its own after the app disconnects. USB output keeps working whatever the LED shows, so the app's **USB** button is the fallback if wireless fails.

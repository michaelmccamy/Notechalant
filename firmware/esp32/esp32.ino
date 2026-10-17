// Notechalant pen firmware for the Seeed XIAO ESP32S3.
//
// Reads the MPU6050 and the touch pad at 100 Hz and sends each sample (docs/data-format.md)
// up to three ways at once:
//   - Bluetooth Low Energy notifications, packed binary, to the app's Bluetooth input
//   - USB serial as JSON lines, so the app's USB input works with no wireless at all
//   - WebSocket client to the relay at ws://RELAY_HOST:8080/pen (relay/relay.js), only if
//     WIFI_SSID in secrets.h is set
//
// Sampling and USB run in loop() on core 1. BLE and WiFi each run in their own task on
// core 0, because the WebSocket library blocks for up to 5 s while connecting to a relay
// that doesn't answer. That way a wrong IP never stalls sampling, USB, or Bluetooth.
//
// Status messages go to serial as whole lines that never start with "{", so the app's
// parser skips them.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <BLEDevice.h>
#include <BLEServer.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy secrets.example.h to secrets.h and fill in your WiFi and relay IP"
#endif

// Pins (XIAO labels in comments)
const int SDA_PIN = 5;     // D4
const int SCL_PIN = 6;     // D5
const int TOUCH_PIN = 2;   // D1, touch channel 2: a wire to a metal pad under the finger
const int LED_PIN = LED_BUILTIN;  // GPIO21, lit when LOW
const int LED_ON = LOW;
const int LED_OFF = HIGH;

// Bluetooth. The UUIDs must match app/src/input/bluetooth.js.
const char *BLE_NAME = "Notechalant Pen";
const char *BLE_SERVICE_UUID = "4cc3af8c-894d-445a-bb7f-68e6168c437a";
const char *BLE_SAMPLES_UUID = "78580580-0b8c-4764-951e-14f13c488905";
const uint16_t BLE_MTU = 247;  // largest notification is MTU - 3 = 244 bytes, 14 samples

// Relay
const uint16_t RELAY_PORT = 8080;
const char *RELAY_PATH = "/pen";

// Timing
const uint32_t SAMPLE_PERIOD_US = 10000;  // 100 Hz
const uint32_t DEBOUNCE_MS = 20;
const uint32_t TOUCH_SETTLE_MS = 100;    // first readings after the touch driver starts are skipped
const uint32_t TOUCH_BASELINE_MS = 1000; // untouched average, measured at startup
const uint32_t TOUCH_REPORT_MS = 1000;   // status line with the live touch value
const uint32_t MPU_RETRY_MS = 2000;
const uint32_t WIFI_RETRY_MS = 15000;
const uint32_t BLINK_MS = 250;
const uint32_t BLE_SEND_MS = 20;  // one notification per 20 ms, about 2 samples each
const uint32_t BLE_READVERTISE_MS = 500;

// Touch thresholds, as a fraction above the untouched baseline. On the S3 touch makes the
// reading go up. The gap between them is the hysteresis, so a reading hovering near one
// threshold can't flicker the pen. Tune them from the status line, which shows the percentage.
// Measured with a bare metal pin: a finger adds 140 to 380%, while the untouched reading drifts
// from -15% to +35% (it stays raised for a while after a touch, and a hovering or gripping hand
// raises it too), so both thresholds sit well clear of that drift.
const float TOUCH_DOWN_RATIO = 0.80;  // pen down once 80% above baseline
const float TOUCH_UP_RATIO = 0.50;    // pen up again once back below 50%

// MPU6050 registers. Ranges must match the divisors in docs/data-format.md.
const uint8_t MPU_ADDR = 0x68;  // AD0 low or unconnected
const uint8_t REG_SMPLRT_DIV = 0x19;
const uint8_t REG_CONFIG = 0x1A;
const uint8_t REG_GYRO_CONFIG = 0x1B;
const uint8_t REG_ACCEL_CONFIG = 0x1C;
const uint8_t REG_ACCEL_XOUT_H = 0x3B;
const uint8_t REG_PWR_MGMT_1 = 0x6B;
const uint8_t REG_WHO_AM_I = 0x75;
const float GYRO_LSB_PER_DPS = 131.0;   // +-250 deg/s
const float ACCEL_LSB_PER_G = 16384.0;  // +-2 g

// One JSON line, longest case is about 100 bytes.
const size_t LINE_BYTES = 128;
// Samples waiting for the WiFi or BLE task. 50 is half a second of samples.
const int QUEUE_LENGTH = 50;

struct Line {
  char text[LINE_BYTES];
  uint16_t length;
};

// One sample in the BLE binary format from docs/data-format.md, little endian:
// t uint32, gx gy gz ax ay az int16 (raw sensor counts), pen uint8.
const size_t PACKED_BYTES = 17;

struct Packed {
  uint8_t bytes[PACKED_BYTES];
};

const bool wifiEnabled = strlen(WIFI_SSID) > 0;

QueueHandle_t wifiQueue;
QueueHandle_t bleQueue;
SemaphoreHandle_t serialLock;

volatile bool relayConnected = false;
volatile bool bleConnected = false;

bool mpuFound = false;
uint32_t lastMpuAttemptMs = 0;
uint32_t nextSampleUs = 0;

int penState = 0;
uint32_t touchBaseline = 0;  // 0 means the touch pad didn't work, so the pen stays up
uint32_t touchDownAt = 0;
uint32_t touchUpAt = 0;
uint32_t touchValue = 0;
bool touchHeld = false;      // after hysteresis, before debounce
bool lastTouchHeld = false;
uint32_t touchChangedMs = 0;
uint32_t lastTouchReportMs = 0;

// ---------- Serial output ----------

// Writes a whole line or nothing. Skipping when the USB buffer is full means a closed
// serial monitor can't block sampling, and a line is never cut in half.
void writeSerialLine(const char *text, size_t length) {
  xSemaphoreTake(serialLock, portMAX_DELAY);
  if (Serial.availableForWrite() >= (int)length) {
    Serial.write((const uint8_t *)text, length);
  }
  xSemaphoreGive(serialLock);
}

void status(const char *format, ...) {
  char text[160];
  va_list args;
  va_start(args, format);
  int n = vsnprintf(text, sizeof(text) - 1, format, args);
  va_end(args);
  if (n < 0) {
    return;
  }
  if (n > (int)sizeof(text) - 2) {
    n = sizeof(text) - 2;
  }
  text[n] = '\n';
  writeSerialLine(text, n + 1);
}

// ---------- MPU6050 ----------

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegisters(uint8_t reg, uint8_t *out, size_t count) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  if (Wire.requestFrom(MPU_ADDR, count) != count) {
    return false;
  }
  for (size_t i = 0; i < count; i++) {
    out[i] = Wire.read();
  }
  return true;
}

bool initMpu() {
  uint8_t who = 0;
  if (!readRegisters(REG_WHO_AM_I, &who, 1)) {
    status("MPU6050 not found at 0x68. Check wiring: SDA D4, SCL D5, VCC 3V3, GND");
    return false;
  }
  bool ok = writeRegister(REG_PWR_MGMT_1, 0x01)       // wake up, clock from gyro X
            && writeRegister(REG_SMPLRT_DIV, 0x00)
            && writeRegister(REG_CONFIG, 0x03)        // 44 Hz low pass, below the 50 Hz Nyquist limit
            && writeRegister(REG_GYRO_CONFIG, 0x00)   // +-250 deg/s
            && writeRegister(REG_ACCEL_CONFIG, 0x00); // +-2 g
  if (!ok) {
    status("MPU6050 answered but setup failed. Retrying");
    return false;
  }
  // Clones report other IDs (0x70, 0x72, 0x98) but use the same registers.
  status("MPU6050 found (WHO_AM_I 0x%02X)", who);
  return true;
}

int16_t be16(const uint8_t *p) {
  return (int16_t)((p[0] << 8) | p[1]);
}

void putLe16(uint8_t *p, int16_t value) {
  p[0] = (uint16_t)value & 0xFF;
  p[1] = (uint16_t)value >> 8;
}

void putLe32(uint8_t *p, uint32_t value) {
  for (int i = 0; i < 4; i++) {
    p[i] = (value >> (8 * i)) & 0xFF;
  }
}

// ---------- Touch pad ----------

// Averages the untouched reading. Runs once in setup(), so don't touch the pen while it boots.
void measureTouchBaseline() {
  status("Measuring touch baseline. Don't touch the pen");
  uint32_t startMs = millis();
  uint64_t sum = 0;
  uint32_t count = 0;
  while (millis() - startMs < TOUCH_SETTLE_MS + TOUCH_BASELINE_MS) {
    uint32_t value = touchRead(TOUCH_PIN);
    if (millis() - startMs >= TOUCH_SETTLE_MS && value > 0) {
      sum += value;
      count++;
    }
    delay(5);
  }
  if (count == 0) {
    status("Touch pad on D1 reads 0. Pen stays up");
    return;
  }
  touchBaseline = sum / count;
  touchDownAt = touchBaseline * (1.0 + TOUCH_DOWN_RATIO);
  touchUpAt = touchBaseline * (1.0 + TOUCH_UP_RATIO);
  status("Touch baseline %lu. Pen down above %lu, up below %lu",
         (unsigned long)touchBaseline, (unsigned long)touchDownAt, (unsigned long)touchUpAt);
}

// Hysteresis first, then the pen state only changes once that has held for DEBOUNCE_MS,
// so a brief brush or a noisy reading can't split a stroke.
void updatePen(uint32_t nowMs) {
  if (touchBaseline == 0) {
    penState = 0;
    return;
  }
  touchValue = touchRead(TOUCH_PIN);
  if (!touchHeld && touchValue > touchDownAt) {
    touchHeld = true;
  } else if (touchHeld && touchValue < touchUpAt) {
    touchHeld = false;
  }
  if (touchHeld != lastTouchHeld) {
    lastTouchHeld = touchHeld;
    touchChangedMs = nowMs;
  }
  if (nowMs - touchChangedMs >= DEBOUNCE_MS) {
    penState = touchHeld ? 1 : 0;
  }
}

void reportTouch(uint32_t nowMs) {
  if (touchBaseline == 0 || nowMs - lastTouchReportMs < TOUCH_REPORT_MS) {
    return;
  }
  lastTouchReportMs = nowMs;
  float percent = 100.0 * ((float)touchValue - (float)touchBaseline) / touchBaseline;
  status("Touch %lu, baseline %lu (%+.1f%%), pen %d",
         (unsigned long)touchValue, (unsigned long)touchBaseline, percent, penState);
}

// ---------- Sampling ----------

void takeSample() {
  uint32_t nowMs = millis();
  updatePen(nowMs);
  reportTouch(nowMs);

  if (!mpuFound) {
    if (nowMs - lastMpuAttemptMs >= MPU_RETRY_MS) {
      lastMpuAttemptMs = nowMs;
      mpuFound = initMpu();
    }
    return;
  }

  uint8_t raw[14];
  if (!readRegisters(REG_ACCEL_XOUT_H, raw, sizeof(raw))) {
    status("MPU6050 read failed. Reconnecting");
    mpuFound = false;
    lastMpuAttemptMs = nowMs;
    return;
  }

  // Register order: accel X Y Z, temperature, gyro X Y Z, each big endian.
  float ax = be16(raw + 0) / ACCEL_LSB_PER_G;
  float ay = be16(raw + 2) / ACCEL_LSB_PER_G;
  float az = be16(raw + 4) / ACCEL_LSB_PER_G;
  float gx = be16(raw + 8) / GYRO_LSB_PER_DPS;
  float gy = be16(raw + 10) / GYRO_LSB_PER_DPS;
  float gz = be16(raw + 12) / GYRO_LSB_PER_DPS;

  Line line;
  int n = snprintf(line.text, LINE_BYTES,
                   "{\"t\":%lu,\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f,\"pen\":%d}\n",
                   (unsigned long)nowMs, gx, gy, gz, ax, ay, az, penState);
  if (n <= 0 || n >= (int)LINE_BYTES) {
    return;
  }
  line.length = n;

  writeSerialLine(line.text, line.length);
  // If a network task is behind, drop this sample for it rather than wait.
  if (wifiEnabled) {
    xQueueSend(wifiQueue, &line, 0);
  }

  if (bleConnected) {
    // BLE sends the raw counts. The app divides by the same constants as above.
    Packed packed;
    putLe32(packed.bytes + 0, nowMs);
    putLe16(packed.bytes + 4, be16(raw + 8));    // gx
    putLe16(packed.bytes + 6, be16(raw + 10));   // gy
    putLe16(packed.bytes + 8, be16(raw + 12));   // gz
    putLe16(packed.bytes + 10, be16(raw + 0));   // ax
    putLe16(packed.bytes + 12, be16(raw + 2));   // ay
    putLe16(packed.bytes + 14, be16(raw + 4));   // az
    packed.bytes[16] = penState;
    xQueueSend(bleQueue, &packed, 0);
  }
}

// ---------- WiFi task (core 0) ----------

WebSocketsClient webSocket;

void onWebSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_CONNECTED) {
    relayConnected = true;
    status("Relay connected: ws://%s:%u%s", RELAY_HOST, RELAY_PORT, RELAY_PATH);
  } else if (type == WStype_DISCONNECTED) {
    // Fires on every failed attempt too, so only report the change.
    if (relayConnected) {
      status("Relay disconnected. Retrying");
    }
    relayConnected = false;
  }
}

// Sends everything waiting in the queue as one message, so a late pass catches up in one go.
void sendQueuedLines() {
  static char batch[LINE_BYTES * 8];
  size_t used = 0;
  Line line;
  while (used + LINE_BYTES <= sizeof(batch) && xQueueReceive(wifiQueue, &line, 0) == pdTRUE) {
    memcpy(batch + used, line.text, line.length);
    used += line.length;
  }
  if (used > 0 && relayConnected) {
    webSocket.sendTXT(batch, used);
  }
}

// Only started when WIFI_SSID is set.
void wifiTask(void *unused) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // power saving adds tens of ms of latency
  WiFi.setAutoReconnect(true);
  status("WiFi connecting to \"%s\"", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  webSocket.begin(RELAY_HOST, RELAY_PORT, RELAY_PATH);
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(2000);
  // Notices a relay that vanished without closing (laptop asleep, out of range) in about 11 s.
  webSocket.enableHeartbeat(5000, 3000, 2);

  bool wifiUp = false;
  uint32_t wifiAttemptMs = millis();

  for (;;) {
    uint32_t nowMs = millis();

    bool up = WiFi.status() == WL_CONNECTED;
    if (up && !wifiUp) {
      status("WiFi connected. IP %s. Connecting to relay at %s:%u",
             WiFi.localIP().toString().c_str(), RELAY_HOST, RELAY_PORT);
    } else if (!up && wifiUp) {
      status("WiFi lost. Reconnecting");
      relayConnected = false;
      wifiAttemptMs = nowMs;
    }
    wifiUp = up;

    if (wifiUp) {
      webSocket.loop();
    } else if (nowMs - wifiAttemptMs >= WIFI_RETRY_MS) {
      // Auto reconnect usually handles it. This covers the cases it gives up on.
      status("Still no WiFi. Is \"%s\" a 2.4 GHz network? Retrying", WIFI_SSID);
      wifiAttemptMs = nowMs;
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }

    sendQueuedLines();
    vTaskDelay(1);
  }
}

// ---------- Bluetooth task (core 0) ----------

BLEServer *bleServer;
BLECharacteristic *samplesCharacteristic;

class PenServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    xQueueReset(bleQueue);  // don't send samples left over from before the connection
    bleConnected = true;
  }
  void onDisconnect(BLEServer *server) override {
    bleConnected = false;
  }
};

void startBle() {
  BLEDevice::init(BLE_NAME);
  BLEDevice::setMTU(BLE_MTU);  // the app's side picks the final size, usually 185 or more on a Mac

  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new PenServerCallbacks());

  BLEService *service = bleServer->createService(BLE_SERVICE_UUID);
  // NimBLE adds the descriptor the app writes to subscribe, so none is added here.
  samplesCharacteristic = service->createCharacteristic(BLE_SAMPLES_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  service->start();

  // The service UUID goes in the advertisement so the app's chooser can filter on it.
  // The name doesn't fit next to it, so it goes in the scan response.
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  status("Bluetooth advertising as \"%s\"", BLE_NAME);
}

// Sends everything waiting in the queue, as many samples per notification as the MTU allows.
void sendQueuedSamples() {
  static uint8_t batch[BLE_MTU - 3];
  size_t room = bleServer->getPeerMTU(bleServer->getConnId()) - 3;
  if (room > sizeof(batch)) {
    room = sizeof(batch);
  }
  size_t used = 0;
  Packed packed;
  while (xQueueReceive(bleQueue, &packed, 0) == pdTRUE) {
    if (used + PACKED_BYTES > room) {
      samplesCharacteristic->setValue(batch, used);
      samplesCharacteristic->notify();
      used = 0;
    }
    memcpy(batch + used, packed.bytes, PACKED_BYTES);
    used += PACKED_BYTES;
  }
  if (used > 0) {
    samplesCharacteristic->setValue(batch, used);
    samplesCharacteristic->notify();
  }
}

void updateLed(uint32_t nowMs) {
  if (bleConnected || relayConnected) {
    digitalWrite(LED_PIN, LED_ON);
  } else {
    digitalWrite(LED_PIN, (nowMs / BLINK_MS) % 2 == 0 ? LED_ON : LED_OFF);
  }
}

void bleTask(void *unused) {
  startBle();
  bool wasConnected = false;
  uint32_t disconnectedMs = 0;
  bool advertising = true;

  for (;;) {
    uint32_t nowMs = millis();
    bool connected = bleConnected;

    if (connected && !wasConnected) {
      status("Bluetooth connected");
      advertising = false;
    } else if (!connected && wasConnected) {
      status("Bluetooth disconnected. Advertising again");
      disconnectedMs = nowMs;
    }
    wasConnected = connected;

    // A short pause before advertising again gives the stack time to finish the disconnect.
    if (!connected && !advertising && nowMs - disconnectedMs >= BLE_READVERTISE_MS) {
      BLEDevice::startAdvertising();
      advertising = true;
    }

    if (connected) {
      sendQueuedSamples();
    }
    updateLed(nowMs);
    vTaskDelay(pdMS_TO_TICKS(BLE_SEND_MS));
  }
}

// ---------- Setup and loop (core 1) ----------

void setup() {
  Serial.begin(115200);
  // Native USB: give the serial monitor a moment to open so boot messages aren't lost.
  while (!Serial && millis() < 1500) {
  }

  serialLock = xSemaphoreCreateMutex();
  bleQueue = xQueueCreate(QUEUE_LENGTH, sizeof(Packed));
  if (wifiEnabled) {
    wifiQueue = xQueueCreate(QUEUE_LENGTH, sizeof(Line));
  }

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_OFF);

  status("Notechalant pen starting");

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  mpuFound = initMpu();
  lastMpuAttemptMs = millis();

  measureTouchBaseline();

  xTaskCreatePinnedToCore(bleTask, "ble", 8192, NULL, 1, NULL, 0);
  if (wifiEnabled) {
    xTaskCreatePinnedToCore(wifiTask, "wifi", 8192, NULL, 1, NULL, 0);
  } else {
    status("No WiFi in secrets.h. Bluetooth and USB only");
  }

  nextSampleUs = micros();
}

void loop() {
  int32_t untilNext = (int32_t)(nextSampleUs - micros());
  if (untilNext > 0) {
    // Plenty of time left: let other tasks run. Otherwise spin for an exact start.
    if (untilNext > 2000) {
      vTaskDelay(1);
    }
    return;
  }

  takeSample();

  nextSampleUs += SAMPLE_PERIOD_US;
  // If something held us up for several periods, skip ahead instead of bursting to catch up.
  if ((int32_t)(micros() - nextSampleUs) > (int32_t)(SAMPLE_PERIOD_US * 5)) {
    nextSampleUs = micros() + SAMPLE_PERIOD_US;
  }
}

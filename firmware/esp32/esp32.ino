// Notechalant pen firmware for the Seeed XIAO ESP32S3.
//
// Reads the MPU6050 and the button at 100 Hz and sends each sample as one JSON line
// (docs/data-format.md) two ways at once:
//   - WebSocket client to the relay at ws://RELAY_HOST:8080/pen (relay/relay.js)
//   - USB serial, so the app's USB input works with no WiFi
//
// Sampling and USB run in loop() on core 1. WiFi and the WebSocket run in their own task
// on core 0, because the WebSocket library blocks for up to 5 s while connecting to a
// relay that doesn't answer. That way a wrong IP never stalls sampling or USB output.
//
// Status messages go to serial as whole lines that never start with "{", so the app's
// parser skips them.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsClient.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy secrets.example.h to secrets.h and fill in your WiFi and relay IP"
#endif

// Pins (XIAO labels in comments)
const int SDA_PIN = 5;     // D4
const int SCL_PIN = 6;     // D5
const int BUTTON_PIN = 2;  // D1, to GND, pressed reads LOW
const int LED_PIN = LED_BUILTIN;  // GPIO21, lit when LOW
const int LED_ON = LOW;
const int LED_OFF = HIGH;

// Relay
const uint16_t RELAY_PORT = 8080;
const char *RELAY_PATH = "/pen";

// Timing
const uint32_t SAMPLE_PERIOD_US = 10000;  // 100 Hz
const uint32_t DEBOUNCE_MS = 20;
const uint32_t MPU_RETRY_MS = 2000;
const uint32_t WIFI_RETRY_MS = 15000;
const uint32_t BLINK_MS = 250;

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
// Lines waiting for the network task. 50 is half a second of samples.
const int QUEUE_LENGTH = 50;

struct Line {
  char text[LINE_BYTES];
  uint16_t length;
};

QueueHandle_t wifiQueue;
SemaphoreHandle_t serialLock;

bool mpuFound = false;
uint32_t lastMpuAttemptMs = 0;
uint32_t nextSampleUs = 0;

int penState = 0;
int lastButtonRaw = HIGH;
uint32_t buttonChangedMs = 0;

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

// ---------- Button ----------

// The pen state only changes once the raw reading has held for DEBOUNCE_MS,
// so contact bounce can't split a stroke.
void updateButton(uint32_t nowMs) {
  int raw = digitalRead(BUTTON_PIN);
  if (raw != lastButtonRaw) {
    lastButtonRaw = raw;
    buttonChangedMs = nowMs;
  }
  if (nowMs - buttonChangedMs >= DEBOUNCE_MS) {
    penState = raw == LOW ? 1 : 0;
  }
}

// ---------- Sampling ----------

void takeSample() {
  uint32_t nowMs = millis();
  updateButton(nowMs);

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
  // If the network task is behind, drop this sample for WiFi rather than wait.
  xQueueSend(wifiQueue, &line, 0);
}

// ---------- Network task (core 0) ----------

WebSocketsClient webSocket;
volatile bool relayConnected = false;

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

void updateLed(uint32_t nowMs) {
  if (relayConnected) {
    digitalWrite(LED_PIN, LED_ON);
  } else {
    digitalWrite(LED_PIN, (nowMs / BLINK_MS) % 2 == 0 ? LED_ON : LED_OFF);
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

void networkTask(void *unused) {
  bool wifiEnabled = strlen(WIFI_SSID) > 0;
  if (!wifiEnabled) {
    status("No WiFi in secrets.h. USB only");
  } else {
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
  }

  bool wifiUp = false;
  uint32_t wifiAttemptMs = millis();

  for (;;) {
    uint32_t nowMs = millis();

    if (wifiEnabled) {
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
    }

    sendQueuedLines();
    updateLed(nowMs);
    vTaskDelay(1);
  }
}

// ---------- Setup and loop (core 1) ----------

void setup() {
  Serial.begin(115200);
  // Native USB: give the serial monitor a moment to open so boot messages aren't lost.
  while (!Serial && millis() < 1500) {
  }

  serialLock = xSemaphoreCreateMutex();
  wifiQueue = xQueueCreate(QUEUE_LENGTH, sizeof(Line));

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_OFF);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  status("Notechalant pen starting");

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  mpuFound = initMpu();
  lastMpuAttemptMs = millis();

  xTaskCreatePinnedToCore(networkTask, "network", 8192, NULL, 1, NULL, 0);

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

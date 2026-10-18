/*
  Notechalant remote: the Elegoo kit's IR remote as a clicker for the app.

  An Arduino UNO with the kit's IR receiver reads the remote and prints one JSON line per
  button press over USB, like {"type":"remote","button":"NEXT_PAGE"}. In the app, click
  Remote and pick the UNO's port. See firmware/remote/README.md.

  Needs the IRremote library 4.x (Library Manager: "IRremote" by shirriff, z3t0, ArminJo).

  Wiring (IR receiver module):
    G (or -)  -> GND
    R (or +)  -> 5V
    Y (or S)  -> pin 11
*/

#include <IRremote.hpp>

const int IR_PIN = 11;
const int LED_PIN = 13;
const long BAUD_RATE = 115200;

// Remote code -> the name the app understands. Names are listed in app/src/input/remote.js.
// Buttons not listed here are printed as "OTHER" with their code, so new ones are easy to add.
const char* buttonFor(uint8_t code) {
  switch (code) {
    case 0x16: return "COLOR";          // 0
    case 0x44: return "PREV_PAGE";      // |<<
    case 0x43: return "NEXT_PAGE";      // >>|
    case 0x19: return "RECENTER";       // EQ
    case 0x47: return "CLEAR";          // FUNC/STOP
    case 0x40: return "PRESENT";        // >||
    case 0x46: return "EXPLORER_UP";    // VOL+
    case 0x15: return "EXPLORER_DOWN";  // VOL-
    case 0x09: return "PREV_TAB";       // UP arrow
    case 0x07: return "NEXT_TAB";       // DOWN arrow
    case 0x0D: return "SIZE";           // ST/REPT
    default:   return "OTHER";
  }
}

void setup() {
  Serial.begin(BAUD_RATE);
  pinMode(LED_PIN, OUTPUT);
  IrReceiver.begin(IR_PIN, DISABLE_LED_FEEDBACK);
  Serial.println("Notechalant remote ready");
}

void loop() {
  if (!IrReceiver.decode()) {
    return;
  }
  bool isRepeat = IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT;
  uint8_t code = IrReceiver.decodedIRData.command;
  // Holding a button sends repeats. Each press should do one thing, so they're skipped.
  // Code 0 with no protocol is noise, like sunlight on the sensor.
  if (!isRepeat && IrReceiver.decodedIRData.protocol != UNKNOWN) {
    Serial.print("{\"type\":\"remote\",\"button\":\"");
    Serial.print(buttonFor(code));
    Serial.print("\",\"code\":");
    Serial.print(code);
    Serial.println("}");
    // Blink the UNO's L LED so you can see the press landed even without the app.
    digitalWrite(LED_PIN, HIGH);
    delay(40);
    digitalWrite(LED_PIN, LOW);
  }
  IrReceiver.resume();
}

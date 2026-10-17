# Remote

The IR remote from the Elegoo UNO starter kit, used as a wireless clicker for the app. It runs next to the pen: the pen stays on Bluetooth (or the relay), and the remote is its own connection.

## Wiring

| IR receiver pin | UNO pin |
|---|---|
| G (or -) | GND |
| R (or +) | 5V (power side) |
| Y (or S) | 11 (digital side) |

## Flashing

1. In the Arduino IDE, install **IRremote** by shirriff, z3t0, ArminJo (version 4.x) from the Library Manager.
2. Open `remote.ino`, pick **Arduino Uno** and its port, and upload.
3. Open the Serial Monitor at **115200 baud**. Each press prints a line like `{"type":"remote","button":"NEXT_PAGE","code":67}`, and the L LED blinks.
4. Close the Serial Monitor before connecting from the app. Only one program can use the port at a time.

## Using it in the app

Keep the UNO plugged into the laptop. In Chrome or Edge, click **Remote** in the toolbar and pick the UNO's port. Click it again to disconnect.

| Button | What it does |
|---|---|
| 0 | Next pen color |
| ST/REPT | Next pen size |
| \|<< | Previous page |
| >>\| | Next page |
| UP arrow | Previous tab |
| DOWN arrow | Next tab |
| EQ | Recenter the cursor |
| FUNC/STOP | Clear the page |
| >\|\| | Enter or leave present mode |
| VOL+ / VOL- | Out of present mode only: move up or down the file explorer |

Present mode hides everything except the page you're writing on. Press **>||** again, or **P** or **Esc** on the keyboard, to leave it.

In the explorer, VOL+ and VOL- move a highlight. Pressing **>||** with a file highlighted opens it and starts presenting it. With a folder highlighted it opens or closes the folder instead.

## Adding a button

Press it with the Serial Monitor open. It prints as `"OTHER"` with its code. Add a `case` for that code in `buttonFor()`, then handle the new name in `onRemoteButton()` in `app/src/main.js`.

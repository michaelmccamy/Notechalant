// Bluetooth Low Energy input through the Web Bluetooth API. Chrome and Edge only, on localhost
// or https. The pen notifies packed binary samples instead of JSON lines, decoded here into the
// same sample objects the other inputs produce. The format is in docs/data-format.md.
//
// After the first pick from the chooser, a dropped connection is retried with the same device,
// so power cycling the pen or walking out of range doesn't need another click.

// Must match firmware/esp32/esp32.ino.
export const PEN_SERVICE_UUID = '4cc3af8c-894d-445a-bb7f-68e6168c437a';
export const PEN_SAMPLES_UUID = '78580580-0b8c-4764-951e-14f13c488905';

// Each sample, little endian: t uint32, gx gy gz ax ay az int16, pen uint8.
export const SAMPLE_BYTES = 17;
const GYRO_LSB_PER_DPS = 131.0;
const ACCEL_LSB_PER_G = 16384.0;
const RETRY_MS = 1000;

export function bluetoothSupported() {
  return 'bluetooth' in navigator;
}

// Turns one notification (a DataView) into a list of samples. Trailing bytes that don't
// make a whole sample are ignored.
export function decodeSamples(view) {
  const samples = [];
  for (let o = 0; o + SAMPLE_BYTES <= view.byteLength; o += SAMPLE_BYTES) {
    samples.push({
      t: view.getUint32(o, true),
      gx: view.getInt16(o + 4, true) / GYRO_LSB_PER_DPS,
      gy: view.getInt16(o + 6, true) / GYRO_LSB_PER_DPS,
      gz: view.getInt16(o + 8, true) / GYRO_LSB_PER_DPS,
      ax: view.getInt16(o + 10, true) / ACCEL_LSB_PER_G,
      ay: view.getInt16(o + 12, true) / ACCEL_LSB_PER_G,
      az: view.getInt16(o + 14, true) / ACCEL_LSB_PER_G,
      pen: view.getUint8(o + 16) === 1 ? 1 : 0,
    });
  }
  return samples;
}

// Opens the browser's device chooser, showing only pens. Must run from a click.
// Throws if the user closes the chooser without picking.
export async function requestPen() {
  if (!bluetoothSupported()) {
    throw new Error('Bluetooth needs Chrome or Edge');
  }
  return navigator.bluetooth.requestDevice({ filters: [{ services: [PEN_SERVICE_UUID] }] });
}

// Streams samples from a device returned by requestPen() until disconnect() is called.
// onStatus gets { connected, rate } on every change and once a second, where rate is
// samples received in the last second.
export function connectBluetooth(device, onSample, onStatus) {
  let characteristic = null;
  let retryTimer = null;
  let stopped = false;
  let connected = false;
  let count = 0;
  let rate = 0;

  function report() {
    onStatus({ connected: connected, rate: rate });
  }

  function onNotification(event) {
    const samples = decodeSamples(event.target.value);
    for (let i = 0; i < samples.length; i++) {
      count++;
      onSample(samples[i]);
    }
  }

  async function open() {
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(PEN_SERVICE_UUID);
      const next = await service.getCharacteristic(PEN_SAMPLES_UUID);
      // The browser can hand back the same object after a reconnect, so never listen twice.
      if (characteristic !== null) {
        characteristic.removeEventListener('characteristicvaluechanged', onNotification);
      }
      characteristic = next;
      characteristic.addEventListener('characteristicvaluechanged', onNotification);
      await characteristic.startNotifications();
      if (stopped) {
        device.gatt.disconnect();
        return;
      }
      connected = true;
      report();
    } catch (err) {
      // The pen is off, out of range, or dropped mid-setup. Try again shortly.
      if (!stopped) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(open, RETRY_MS);
      }
    }
  }

  // Fires when the pen drops, and also after our own disconnect(), so check stopped first.
  function onDisconnected() {
    const wasUp = connected;
    connected = false;
    if (stopped) {
      return;
    }
    if (wasUp) {
      report();
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, RETRY_MS);
  }

  device.addEventListener('gattserverdisconnected', onDisconnected);

  const rateTimer = setInterval(function () {
    rate = count;
    count = 0;
    report();
  }, 1000);

  open();
  report();

  function disconnect() {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(rateTimer);
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    if (characteristic !== null) {
      characteristic.removeEventListener('characteristicvaluechanged', onNotification);
    }
    if (device.gatt.connected) {
      device.gatt.disconnect();
    }
  }

  return { disconnect };
}

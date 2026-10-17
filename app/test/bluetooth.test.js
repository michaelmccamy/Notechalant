// Tests the Bluetooth input's binary decoder and its reconnect logic with a fake device,
// so it runs under `npm test` without a pen or a browser.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSamples, connectBluetooth, SAMPLE_BYTES } from '../src/input/bluetooth.js';

// Packs one sample the way firmware/esp32/esp32.ino does: raw sensor counts, little endian.
function pack(view, offset, s) {
  view.setUint32(offset, s.t, true);
  view.setInt16(offset + 4, s.gx, true);
  view.setInt16(offset + 6, s.gy, true);
  view.setInt16(offset + 8, s.gz, true);
  view.setInt16(offset + 10, s.ax, true);
  view.setInt16(offset + 12, s.ay, true);
  view.setInt16(offset + 14, s.az, true);
  view.setUint8(offset + 16, s.pen);
}

test('decodeSamples scales raw counts into a normal sample', function () {
  const view = new DataView(new ArrayBuffer(SAMPLE_BYTES));
  // 131 counts is 1 deg/s and 16384 counts is 1 g, from docs/data-format.md.
  pack(view, 0, { t: 4000000000, gx: 131, gy: -262, gz: 0, ax: 0, ay: -8192, az: 16384, pen: 1 });
  assert.deepEqual(decodeSamples(view), [{ t: 4000000000, gx: 1, gy: -2, gz: 0, ax: 0, ay: -0.5, az: 1, pen: 1 }]);
});

test('decodeSamples handles several samples, extremes, and a partial tail', function () {
  const view = new DataView(new ArrayBuffer(SAMPLE_BYTES * 3 + 5));
  pack(view, 0, { t: 10, gx: 32767, gy: -32768, gz: 0, ax: 0, ay: 0, az: 0, pen: 0 });
  pack(view, SAMPLE_BYTES, { t: 20, gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 0, pen: 1 });
  pack(view, SAMPLE_BYTES * 2, { t: 30, gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 0, pen: 7 });

  const samples = decodeSamples(view);
  assert.deepEqual(samples.map(function (s) { return s.t; }), [10, 20, 30]);
  assert.equal(samples[0].gx, 32767 / 131);
  assert.equal(samples[0].gy, -32768 / 131);
  assert.deepEqual(samples.map(function (s) { return s.pen; }), [0, 1, 0]);
});

test('decodeSamples returns nothing for an empty notification', function () {
  assert.deepEqual(decodeSamples(new DataView(new ArrayBuffer(0))), []);
});

// A fake BluetoothDevice whose connections succeed or fail on command.
class FakeTarget {
  constructor() {
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter(function (f) {
      return f !== fn;
    });
  }
  emit(type, event) {
    (this.listeners[type] || []).slice().forEach(function (fn) {
      fn(event || {});
    });
  }
}

function fakeDevice() {
  const device = new FakeTarget();
  // Like Chrome, hand back the same characteristic object on every connection.
  const characteristic = new FakeTarget();
  characteristic.startNotifications = async function () {};
  device.connects = 0;
  device.fail = false;
  device.gatt = {
    connected: false,
    async connect() {
      device.connects++;
      if (device.fail) {
        throw new Error('out of range');
      }
      device.gatt.connected = true;
      return {
        async getPrimaryService() {
          return {
            async getCharacteristic() {
              return characteristic;
            },
          };
        },
      };
    },
    disconnect() {
      device.gatt.connected = false;
      device.emit('gattserverdisconnected');
    },
  };
  device.notify = function (s) {
    const view = new DataView(new ArrayBuffer(SAMPLE_BYTES));
    pack(view, 0, s);
    characteristic.emit('characteristicvaluechanged', { target: { value: view } });
  };
  device.drop = function () {
    device.gatt.connected = false;
    device.emit('gattserverdisconnected');
  };
  return device;
}

// Lets the awaits inside connectBluetooth finish.
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const ZERO = { gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 16384, pen: 0 };

test('bluetooth reconnects to the same device after a drop, and stops after disconnect', async function () {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const device = fakeDevice();
  const received = [];
  const statuses = [];
  const connection = connectBluetooth(device, function (s) {
    received.push(s.t);
  }, function (s) {
    statuses.push(s);
  });

  await settle();
  assert.equal(statuses[statuses.length - 1].connected, true);
  device.notify(Object.assign({ t: 1 }, ZERO));

  mock.timers.tick(1000);
  assert.deepEqual(statuses[statuses.length - 1], { connected: true, rate: 1 });

  // Pen walks out of range: the first retry fails, the next one works.
  device.fail = true;
  device.drop();
  assert.equal(statuses[statuses.length - 1].connected, false);
  mock.timers.tick(1000);
  await settle();
  assert.equal(device.connects, 2);
  device.fail = false;
  mock.timers.tick(1000);
  await settle();
  assert.equal(device.connects, 3);
  assert.equal(statuses[statuses.length - 1].connected, true);

  // One sample after reconnecting arrives once, not once per connection.
  device.notify(Object.assign({ t: 2 }, ZERO));
  assert.deepEqual(received, [1, 2]);

  const reportsBefore = statuses.length;
  connection.disconnect();
  assert.equal(device.gatt.connected, false);
  mock.timers.tick(5000);
  await settle();
  assert.equal(device.connects, 3, 'no retry after disconnect');
  assert.equal(statuses.length, reportsBefore, 'no status after disconnect');
  mock.timers.reset();
});

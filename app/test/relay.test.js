// Tests the relay input's message handling and reconnect logic with a fake WebSocket,
// so it runs under `npm test` without the relay running.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { connectRelay } from '../src/input/relay.js';

const SAMPLE = { t: 10, gx: 1, gy: 2, gz: 3, ax: 0, ay: 0, az: 1, pen: 1 };

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    FakeSocket.all.push(this);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  emit(type, event) {
    this.listeners[type](event || {});
  }
  close() {
    this.emit('close');
  }
}

function setup() {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
}

function teardown() {
  mock.timers.reset();
  delete globalThis.WebSocket;
}

test('relay passes samples on and reports pen status', function () {
  setup();
  const samples = [];
  const statuses = [];
  const connection = connectRelay('ws://relay', function (s) {
    samples.push(s);
  }, function (s) {
    statuses.push(s);
  });
  const socket = FakeSocket.all[0];

  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'status', pens: 1 }) });
  socket.emit('message', { data: JSON.stringify(Object.assign({ type: 'sample' }, SAMPLE)) });
  socket.emit('message', { data: JSON.stringify({ type: 'sample', t: 11 }) }); // missing fields
  socket.emit('message', { data: 'not json' });

  assert.deepEqual(samples, [SAMPLE]);
  assert.deepEqual(statuses[statuses.length - 1], { relay: true, pens: 1, rate: 0 });

  mock.timers.tick(1000);
  assert.deepEqual(statuses[statuses.length - 1], { relay: true, pens: 1, rate: 1 });

  connection.disconnect();
  teardown();
});

test('relay reconnects after the relay drops, and stops after disconnect', function () {
  setup();
  const statuses = [];
  const connection = connectRelay('ws://relay', function () {}, function (s) {
    statuses.push(s);
  });

  FakeSocket.all[0].emit('open');
  FakeSocket.all[0].emit('close');
  assert.equal(statuses[statuses.length - 1].relay, false);
  assert.equal(FakeSocket.all.length, 1);

  mock.timers.tick(1000);
  assert.equal(FakeSocket.all.length, 2, 'retried after a second');

  const reportsBefore = statuses.length;
  connection.disconnect();
  mock.timers.tick(5000);
  assert.equal(FakeSocket.all.length, 2, 'no retry after disconnect');
  assert.equal(statuses.length, reportsBefore, 'no status after disconnect');
  teardown();
});

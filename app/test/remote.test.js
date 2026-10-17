// Tests the IR remote's line parsing, so it runs under `npm test` without the UNO plugged in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteLine, createRemoteSplitter } from '../src/input/remote.js';

test('reads a button press', function () {
  assert.equal(parseRemoteLine('{"type":"remote","button":"NEXT_PAGE","code":67}\r'), 'NEXT_PAGE');
});

test('skips boot text, bad JSON, pen samples and unknown buttons', function () {
  assert.equal(parseRemoteLine('Notechalant remote ready'), null);
  assert.equal(parseRemoteLine('{"type":"remote","button":'), null);
  assert.equal(parseRemoteLine('{"t":1,"gx":0,"gy":0,"gz":0,"ax":0,"ay":0,"az":1,"pen":0}'), null);
  assert.equal(parseRemoteLine('{"type":"remote","button":"OTHER","code":12}'), null);
  assert.equal(parseRemoteLine('null'), null);
  assert.equal(parseRemoteLine(''), null);
});

test('joins lines split across reads', function () {
  const pressed = [];
  const splitter = createRemoteSplitter((button) => pressed.push(button));
  splitter.push('Notechalant remote ready\r\n{"type":"remote","but');
  splitter.push('ton":"COLOR","code":22}\r\n{"type":"remote","button":"SIZE"}');
  assert.deepEqual(pressed, ['COLOR']);
  splitter.push('\n');
  assert.deepEqual(pressed, ['COLOR', 'SIZE']);
});

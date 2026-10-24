import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePort } from '../src/port.js';

test('accepts a number in range', () => {
  assert.equal(parsePort(8080), 8080);
});

test('accepts a decimal string in range', () => {
  assert.equal(parsePort('3000'), 3000);
});

test('rejects a number above the range', () => {
  assert.throws(() => parsePort(70000), RangeError);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRange } from '../src/format.js';
import { clamp, inRange } from '../src/range.js';

test('clamps values into the range', () => {
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(-1, 0, 10), 0);
});

test('treats the lower bound as inside and the upper bound as outside', () => {
  assert.equal(inRange(0, 0, 10), true);
  assert.equal(inRange(10, 0, 10), false);
});

test('describes a value inside the range', () => {
  assert.equal(describeRange(7, 0, 10), '7 inside');
});

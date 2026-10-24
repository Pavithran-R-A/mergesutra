import assert from 'node:assert/strict';
import test from 'node:test';

import { median } from '../src/median.js';

test('returns the middle value of an odd-length array', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('averages the two middle values of an even-length array', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('orders numbers numerically, not lexicographically', () => {
  assert.equal(median([10, 2, 33]), 10);
  assert.equal(median([1, 2, 3, 100]), 2.5);
});

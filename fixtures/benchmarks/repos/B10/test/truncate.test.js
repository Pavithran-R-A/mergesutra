import assert from 'node:assert/strict';
import test from 'node:test';

import { truncate } from '../src/truncate.js';

test('returns short text unchanged', () => {
  assert.equal(truncate('abc', 5), 'abc');
});

test('truncates long text and appends the suffix', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
});

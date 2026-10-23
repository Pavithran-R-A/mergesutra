import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeRecord, encodeRecord } from '../src/record.js';

test('round trips keys and values', () => {
  const text = encodeRecord({ b: 'two', a: 'one' });
  assert.deepEqual(decodeRecord(text), { a: 'one', b: 'two' });
});

test('round trips a value with spaces and a hyphen', () => {
  const text = encodeRecord({ note: 'two words-and-more' });
  assert.deepEqual(decodeRecord(text), { note: 'two words-and-more' });
});

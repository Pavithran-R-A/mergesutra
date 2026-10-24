import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLabel } from '../src/normalize.js';

test('trims and lowercases', () => {
  assert.equal(normalizeLabel('  Hello  '), 'hello');
});

test('keeps one internal space', () => {
  assert.equal(normalizeLabel('Hello World'), 'hello world');
});

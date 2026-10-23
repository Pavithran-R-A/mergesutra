import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../src/settings.js';

test('returns the defaults', () => {
  assert.deepEqual(loadSettings({ env: {}, file: {} }), {
    url: 'https://api.example.com',
    retries: 2,
    token: '',
  });
});

test('a file value overrides a default', () => {
  assert.equal(loadSettings({ env: {}, file: { retries: 4 } }).retries, 4);
});

test('reads a token from the file', () => {
  assert.equal(loadSettings({ env: {}, file: { token: 'file-token' } }).token, 'file-token');
});

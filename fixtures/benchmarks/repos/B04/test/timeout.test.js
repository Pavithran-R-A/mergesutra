import assert from 'node:assert/strict';
import test from 'node:test';

import { runWithTimeout } from '../src/timeout.js';

test('resolves with the value of a fast operation', async () => {
  assert.equal(await runWithTimeout(async () => 42, 1000), 42);
});

test('rejects when the operation is slower than the limit', async () => {
  await assert.rejects(
    runWithTimeout(() => new Promise(() => {}), 50),
    new Error('timed out after 50 ms'),
  );
});

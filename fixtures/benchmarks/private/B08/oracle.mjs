import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { clamp, inRange } = await import(pathToFileURL(path.join(root, 'src', 'range.js')).href);
const { describeRange } = await import(pathToFileURL(path.join(root, 'src', 'format.js')).href);

assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(11, 0, 10), 10);
assert.equal(clamp(3, 3, 3), 3);

assert.equal(inRange(0, 0, 10), true);
assert.equal(inRange(10, 0, 10), false);
assert.equal(inRange(10, 0, 10, { inclusive: true }), true);
assert.equal(inRange(11, 0, 10, { inclusive: true }), false);
assert.equal(inRange(5, 0, 10, {}), true);

assert.equal(describeRange(7, 0, 10), '7 inside');
assert.equal(describeRange(12, 0, 10), '12 outside');
assert.equal(describeRange(-3, 0, 10), '-3 outside');
assert.equal(describeRange(10, 0, 10), '10 outside');
assert.equal(describeRange(10, 0, 10, { inclusive: true }), '10 inside');
assert.equal(describeRange(0, 0, 10), '0 inside');

for (const run of [() => clamp(1, 5, 0), () => inRange(1, 5, 0), () => describeRange(1, 5, 0)]) {
  assert.throws(
    run,
    (error) => error instanceof RangeError && error.message === 'min must not exceed max',
    'inverted bounds are refused',
  );
}

process.stdout.write('PASS B08 range helpers\n');

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const baseRoot = process.argv[3];
if (!root || !baseRoot) throw new Error('oracle needs the candidate and base workspaces');

const { median } = await import(pathToFileURL(path.join(root, 'src', 'median.js')).href);

assert.equal(median([10, 2, 33]), 10, 'multi-digit values sort numerically');
assert.equal(median([1, 2, 3, 100]), 2.5, 'even-length multi-digit values average correctly');
assert.equal(median([0, 100, 5]), 5);
assert.equal(median([5]), 5);

const input = [3, 1, 2];
assert.equal(median(input), 2);
assert.deepEqual(input, [3, 1, 2], 'the input array is not mutated');

assert.throws(
  () => median(null),
  (error) => error instanceof TypeError && error.message === 'values must be an array',
  'a non-array is refused',
);
assert.throws(
  () => median([]),
  (error) => error instanceof RangeError && error.message === 'values must not be empty',
  'an empty array is refused',
);
for (const values of [
  [1, '2', 3],
  [1, Number.NaN],
  [1, Number.POSITIVE_INFINITY],
]) {
  assert.throws(
    () => median(values),
    (error) =>
      error instanceof TypeError && error.message === 'values must contain only finite numbers',
    `non-finite input ${JSON.stringify(values)} is refused`,
  );
}

const baseTestPath = path.join(baseRoot, 'test', 'median.test.js');
const candidateTestPath = path.join(root, 'test', 'median.test.js');
const baseTestText = fs.readFileSync(baseTestPath, 'utf8');
const candidateTestText = fs.readFileSync(candidateTestPath, 'utf8');

assert.ok(
  candidateTestText.includes(baseTestText.trimEnd()),
  'every original test is preserved byte for byte',
);
assert.notEqual(candidateTestText, baseTestText, 'the change adds at least one test');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-b09-'));
try {
  const copy = path.join(scratch, 'candidate');
  fs.cpSync(baseRoot, copy, { recursive: true });
  fs.copyFileSync(candidateTestPath, path.join(copy, 'test', 'median.test.js'));
  const result = spawnSync(process.execPath, ['--test'], {
    cwd: copy,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.notEqual(
    result.status,
    0,
    'the added tests must fail against the original implementation',
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('PASS B09 coverage regression\n');

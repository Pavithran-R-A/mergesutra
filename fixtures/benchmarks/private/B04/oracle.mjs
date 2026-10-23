import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const moduleUrl = pathToFileURL(path.join(root, 'src', 'timeout.js')).href;
const { runWithTimeout } = await import(moduleUrl);

function runInline(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

function timed(script) {
  const started = Date.now();
  const result = runInline(script);
  return { result, elapsed: Date.now() - started };
}

const resolved = timed(`
import { runWithTimeout } from ${JSON.stringify(moduleUrl)};
const value = await runWithTimeout(async () => 42, 1200);
process.stdout.write('value:' + value);
`);
assert.equal(resolved.result.status, 0, 'a fast operation resolves');
assert.equal(resolved.result.stdout, 'value:42');
assert.ok(
  resolved.elapsed < 1000,
  `a fast settlement left the process waiting ${resolved.elapsed} ms for the deadline`,
);

const rejected = timed(`
import { runWithTimeout } from ${JSON.stringify(moduleUrl)};
try {
  await runWithTimeout(async () => { throw new Error('boom'); }, 1200);
  process.stdout.write('resolved');
} catch (error) {
  process.stdout.write('rejected:' + error.message);
}
`);
assert.equal(rejected.result.status, 0);
assert.equal(rejected.result.stdout, 'rejected:boom', 'the operation error is preserved');
assert.ok(
  rejected.elapsed < 1000,
  `a rejected settlement left the process waiting ${rejected.elapsed} ms for the deadline`,
);

const expired = timed(`
import { runWithTimeout } from ${JSON.stringify(moduleUrl)};
try {
  await runWithTimeout(() => new Promise(() => {}), 300);
  process.stdout.write('resolved');
} catch (error) {
  process.stdout.write('rejected:' + error.message);
}
`);
assert.equal(expired.result.status, 0);
assert.equal(expired.result.stdout, 'rejected:timed out after 300 ms');
assert.ok(expired.elapsed >= 250, 'the deadline is actually waited for');

assert.throws(
  () => runWithTimeout(42, 10),
  (error) => error instanceof TypeError && error.message === 'operation must be a function',
  'a non-function operation is refused synchronously',
);

for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
  assert.throws(
    () => runWithTimeout(async () => 1, value),
    (error) => error instanceof RangeError && error.message === 'ms must be a positive number',
    `ms ${String(value)} is refused synchronously`,
  );
}

process.stdout.write('PASS B04 timeout and cancellation\n');

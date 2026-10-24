import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.js');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
}

test('greets the name once by default', () => {
  const result = run('Ada');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Hello, Ada\n');
});

test('repeats the greeting the requested number of times', () => {
  const result = run('--times', '3', 'Ada');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Hello, Ada\nHello, Ada\nHello, Ada\n');
});

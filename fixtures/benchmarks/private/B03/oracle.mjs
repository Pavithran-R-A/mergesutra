import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const cli = path.join(root, 'src', 'cli.js');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

const help = run('--help');
assert.equal(help.status, 0, '--help exits 0');
assert.equal(help.stderr, '', '--help writes nothing to stderr');
assert.equal(help.stdout, 'usage: bench-cli [--help] [--version] [--times N] <name>\n');

const version = run('--version');
assert.equal(version.status, 0, '--version exits 0');
assert.equal(version.stdout, '1.0.0\n');

const unknown = run('--nope');
assert.equal(unknown.status, 2, 'an unknown option exits 2');
assert.equal(unknown.stdout, '', 'an unknown option prints no greeting');
assert.equal(unknown.stderr, 'unknown option: --nope\n');

const missing = run('--times');
assert.equal(missing.status, 2, '--times without a value exits 2');
assert.equal(missing.stderr, '--times requires a value\n');

for (const value of ['0', '-2', '2.5', 'abc']) {
  const invalid = run('--times', value, 'Ada');
  assert.equal(invalid.status, 2, `--times ${value} exits 2`);
  assert.equal(invalid.stderr, '--times must be a positive integer\n');
}

const repeated = run('--times', '2', 'Ada');
assert.equal(repeated.status, 0);
assert.equal(repeated.stdout, 'Hello, Ada\nHello, Ada\n');

const plain = run('Ada');
assert.equal(plain.status, 0);
assert.equal(plain.stdout, 'Hello, Ada\n');

const defaulted = run();
assert.equal(defaulted.status, 0);
assert.equal(defaulted.stdout, 'Hello, world\n');

const helpWins = run('Ada', '--help');
assert.equal(helpWins.status, 0, '--help wins over a name');
assert.equal(helpWins.stdout, 'usage: bench-cli [--help] [--version] [--times N] <name>\n');

process.stdout.write(`PASS B03 cli arguments (node ${process.versions.node.split('.')[0]})\n`);

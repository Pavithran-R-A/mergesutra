import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { normalizeLabel } = await import(pathToFileURL(path.join(root, 'src', 'normalize.js')).href);

assert.equal(normalizeLabel('  Hello  '), 'hello', 'leading and trailing spaces');
assert.equal(normalizeLabel('Hello World'), 'hello world', 'one internal space');
assert.equal(normalizeLabel('Hello\t\tWorld'), 'hello world', 'tab run');
assert.equal(normalizeLabel('a\n b\rc'), 'a b c', 'newline and carriage return');
assert.equal(normalizeLabel('\fA\vB\f'), 'a b', 'form feed and vertical tab');
assert.equal(normalizeLabel('x__y---z'), 'x-y-z', 'hyphen and underscore runs');
assert.equal(normalizeLabel('under_score'), 'under-score', 'single underscore');
assert.equal(normalizeLabel('MiXeD Case'), 'mixed case', 'mixed case');
assert.equal(normalizeLabel('a.b/c@d'), 'a.b/c@d', 'other characters are left alone');

assert.throws(
  () => normalizeLabel(42),
  (error) => error instanceof TypeError && error.message === 'label must be a string',
  'a non-string is a TypeError with the exact message',
);

process.stdout.write('PASS B01 normalization\n');

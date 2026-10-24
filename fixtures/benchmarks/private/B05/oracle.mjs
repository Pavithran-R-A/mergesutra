import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { decodeRecord, encodeRecord } = await import(
  pathToFileURL(path.join(root, 'src', 'record.js')).href
);

assert.equal(encodeRecord({ b: 'two', a: 'one' }), 'a=one;b=two', 'keys are sorted');
assert.equal(encodeRecord({}), '', 'an empty record is the empty string');
assert.deepEqual(decodeRecord(''), {}, 'the empty string is an empty record');

assert.equal(
  encodeRecord({ k: 'a;b=c\\d\ne' }),
  'k=a\\;b\\=c\\\\d\\ne',
  'separators and newline are escaped in values',
);
assert.equal(encodeRecord({ 'a;=': 'v' }), 'a\\;\\==v', 'separators are escaped in keys');

const complex = { 'x;y': '1=2', z: 'line\nbreak', 'back\\slash': 'a\\b' };
assert.deepEqual(decodeRecord(encodeRecord(complex)), complex, 'a complex record round trips');

for (const text of ['a', 'a=1;', '=x', 'a=1;b', 'a=1=2', 'a=\\q', 'a=1\\']) {
  assert.throws(
    () => decodeRecord(text),
    (error) => error instanceof SyntaxError && error.message === 'invalid record',
    `decodeRecord refuses ${JSON.stringify(text)}`,
  );
}

assert.throws(
  () => decodeRecord(42),
  (error) => error instanceof SyntaxError && error.message === 'invalid record',
  'a non-string input is refused',
);

for (const value of [null, [], 'x', 5]) {
  assert.throws(
    () => encodeRecord(value),
    (error) => error instanceof TypeError && error.message === 'record must be a plain object',
    `encodeRecord refuses ${String(value)}`,
  );
}

assert.throws(
  () => encodeRecord({ '': 'x' }),
  (error) => error instanceof TypeError && error.message === 'keys must be non-empty strings',
  'an empty key is refused',
);

assert.throws(
  () => encodeRecord({ a: 1 }),
  (error) => error instanceof TypeError && error.message === 'values must be strings',
  'a non-string value is refused',
);

process.stdout.write('PASS B05 record serialization\n');

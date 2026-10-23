import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { parsePort } = await import(pathToFileURL(path.join(root, 'src', 'port.js')).href);

assert.equal(parsePort(1), 1, 'lowest valid port');
assert.equal(parsePort(65535), 65535, 'highest valid port');
assert.equal(parsePort('65535'), 65535, 'numeric string at the top');

const typeError = (value, label) =>
  assert.throws(
    () => parsePort(value),
    (error) =>
      error instanceof TypeError && error.message === 'port must be a number or a numeric string',
    label,
  );

typeError('', 'empty string');
typeError('0x10', 'hexadecimal string');
typeError('1e3', 'exponent string');
typeError(' 80', 'leading space');
typeError(null, 'null');
typeError(true, 'boolean');
typeError([], 'array');

const rangeError = (value, label) =>
  assert.throws(
    () => parsePort(value),
    (error) =>
      error instanceof RangeError &&
      error.message === 'port must be an integer between 1 and 65535',
    label,
  );

rangeError(0, 'zero');
rangeError(65536, 'above the range');
rangeError(1.5, 'fraction');
rangeError(Number.NaN, 'NaN');

process.stdout.write('PASS B02 validation\n');

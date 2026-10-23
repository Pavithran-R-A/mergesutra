import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { truncate } = await import(pathToFileURL(path.join(root, 'src', 'truncate.js')).href);

assert.equal(truncate('abc', 5), 'abc', 'short text is unchanged');
assert.equal(truncate('abcdef', 6), 'abcdef', 'text at the limit is unchanged');
assert.equal(truncate('abcdef', 4), 'abc…', 'the suffix is counted in the budget');
assert.equal(truncate('abcdef', 4, ''), 'abcd', 'an empty suffix needs no room');
assert.equal(truncate('ab', 2, '...'), 'ab', 'a long suffix is irrelevant when nothing is cut');

const emojiCut = truncate('a😀b', 2, '');
assert.equal(emojiCut, 'a', 'a surrogate pair is never split');
assert.ok(
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiCut),
  'the kept prefix ends on a high surrogate only when a low surrogate follows',
);

assert.equal(truncate('😀😀😀', 4, '..'), '😀..', 'suffix length is subtracted from the budget');
assert.ok(truncate('😀😀😀', 4, '..').length <= 4, 'the result never exceeds max');

assert.throws(
  () => truncate('abcdef', 2, '...'),
  (error) => error instanceof RangeError && error.message === 'max is too small for the suffix',
  'a suffix that fills the budget is refused',
);
assert.throws(
  () => truncate('abcdef', 3, '...'),
  (error) => error instanceof RangeError && error.message === 'max is too small for the suffix',
  'a suffix as long as max is refused when truncation is needed',
);

assert.throws(
  () => truncate(42, 3),
  (error) => error instanceof TypeError && error.message === 'text must be a string',
  'a non-string text is refused',
);
assert.throws(
  () => truncate('abcdef', 4, 5),
  (error) => error instanceof TypeError && error.message === 'suffix must be a string',
  'a non-string suffix is refused',
);
for (const value of [0, -1, 2.5, Number.NaN]) {
  assert.throws(
    () => truncate('abcdef', value),
    (error) => error instanceof RangeError && error.message === 'max must be a positive integer',
    `max ${String(value)} is refused`,
  );
}

process.stdout.write('PASS B10 truncation boundaries\n');

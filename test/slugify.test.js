import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/slugify.js';

test('lowercases the input', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('collapses a run of separators into one hyphen', () => {
  assert.equal(slugify('a--b'), 'a-b');
});

test('replaces punctuation with a hyphen', () => {
  assert.equal(slugify('a.b,c'), 'a-b-c');
});

import assert from 'node:assert/strict';
import { slugify } from './src/slugify.js';

assert.equal(slugify('Hello World'), 'hello-world');
assert.equal(slugify('a--b'), 'a-b');
assert.equal(slugify('a.b,c'), 'a-b-c');

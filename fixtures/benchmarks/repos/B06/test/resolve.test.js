import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveInside } from '../src/resolve.js';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-b06-'));
}

test('returns an absolute path for a nested candidate', () => {
  const root = makeRoot();
  try {
    const resolved = resolveInside(root, path.join('nested', 'file.txt'));
    assert.ok(path.isAbsolute(resolved));
    assert.ok(resolved.endsWith(path.join('nested', 'file.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns an absolute path for a file at the root', () => {
  const root = makeRoot();
  try {
    assert.equal(path.basename(resolveInside(root, 'file.txt')), 'file.txt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

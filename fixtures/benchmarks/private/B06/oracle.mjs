import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('oracle needs the candidate workspace');

const { resolveInside } = await import(pathToFileURL(path.join(root, 'src', 'resolve.js')).href);

function expectEPath(run, label) {
  assert.throws(
    run,
    (error) =>
      error instanceof Error && error.code === 'EPATH' && error.message === 'path escapes the root',
    label,
  );
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-b06-oracle-'));
try {
  const rootDir = path.join(scratch, 'root');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(path.join(rootDir, 'nested'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(rootDir, 'nested', 'file.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(rootDir, 'link'), 'junction');
  fs.symlinkSync(path.join(rootDir, 'nested'), path.join(rootDir, 'nested-link'), 'junction');

  const realRoot = fs.realpathSync(rootDir);

  assert.equal(
    resolveInside(rootDir, path.join('nested', 'file.txt')),
    path.join(realRoot, 'nested', 'file.txt'),
    'a nested candidate stays inside',
  );

  expectEPath(
    () => resolveInside(rootDir, path.join('..', 'outside', 'secret.txt')),
    'climbing out with .. is refused',
  );

  expectEPath(
    () => resolveInside(rootDir, path.join('..', path.basename(outside), 'secret.txt')),
    'a repeated .. climb is refused',
  );

  expectEPath(
    () => resolveInside(rootDir, path.join(scratch, 'outside', 'secret.txt')),
    'an absolute candidate outside the root is refused',
  );

  expectEPath(
    () => resolveInside(rootDir, path.join(rootDir, 'nested', 'file.txt')),
    'an absolute candidate is refused even inside the root',
  );

  expectEPath(
    () => resolveInside(rootDir, path.join('link', 'secret.txt')),
    'a link that leaves the root is refused',
  );

  const throughInsideLink = resolveInside(rootDir, path.join('nested-link', 'file.txt'));
  assert.equal(throughInsideLink, path.join(realRoot, 'nested-link', 'file.txt'));
  const followed = path.relative(realRoot, fs.realpathSync(throughInsideLink));
  assert.ok(
    followed !== '..' && !followed.startsWith(`..${path.sep}`) && !path.isAbsolute(followed),
    'a link that stays inside the root is allowed',
  );

  assert.throws(
    () => resolveInside(42, 'file.txt'),
    (error) => error instanceof TypeError && error.message === 'root and candidate must be strings',
    'a non-string root is refused',
  );
  assert.throws(
    () => resolveInside(rootDir, 42),
    (error) => error instanceof TypeError && error.message === 'root and candidate must be strings',
    'a non-string candidate is refused',
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('PASS B06 path safety\n');

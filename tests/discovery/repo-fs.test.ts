import { realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  MAX_DIR_ENTRIES,
  openRepoReader,
} from '../../src/discovery/repo-fs.js';
import { CAN_SYMLINK, makeFixtureTree, makeLink, snapshotTree } from '../helpers/fixture.js';

/**
 * The confinement layer is the one Stage 2 module that can be attacked through
 * a filename, so these tests aim at it directly: traversal, absolute paths,
 * links that leave the tree, and oversized files.

 * The rule under test is that a repository can never talk its way into a read
 * outside itself.
 */

const created: string[] = [];

async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeFixtureTree(files);
  created.push(root);
  return root;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function kind(error: unknown): string {
  return error instanceof AppError ? `${error.kind}: ${error.message}` : String(error);
}

describe('openRepoReader', () => {
  it('refuses a path that does not exist', async () => {
    const error = await openRepoReader(path.join(tmpdir(), 'mergesutra-no-such-dir-xyz')).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).kind).toBe('validation');
    expect((error as AppError).remediation).toContain('--repo');
  });

  it('refuses a file passed as the repository root', async () => {
    const root = await tree({ 'package.json': '{}' });
    const error = await openRepoReader(path.join(root, 'package.json')).catch((e) => e);
    expect((error as AppError).kind).toBe('validation');
    expect(kind(error)).toContain('not a directory');
  });

  it('refuses a NUL byte before touching the filesystem', async () => {
    const error = await openRepoReader('/repo\0escape').catch((e) => e);
    expect((error as AppError).kind).toBe('validation');
  });

  it('reports the resolved root so later output cannot mislead about location', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reader = await openRepoReader(root);
    expect(reader.root).toBe(await realpath(root));
  });
});

describe('RepoReader.readText', () => {
  it('reads a nested file and names it relative to the root', async () => {
    const root = await tree({ 'src/util/parse.ts': 'export const x = 1;\n' });
    const reader = await openRepoReader(root);
    const file = await reader.readText(path.join('src', 'util', 'parse.ts'));
    expect(file?.text).toBe('export const x = 1;\n');
    expect(file?.relativePath).toBe('src/util/parse.ts');
    expect(file?.truncated).toBe(false);
    expect(file?.bytesOnDisk).toBe(20);
  });

  it('caps a huge file and says it was capped', async () => {
    const root = await tree({ 'big.txt': 'a'.repeat(3000) });
    const reader = await openRepoReader(root);
    const file = await reader.readText('big.txt', 100);
    expect(file?.text).toHaveLength(100);
    expect(file?.bytesOnDisk).toBe(3000);
    expect(file?.truncated).toBe(true);
  });

  it('uses a bounded default rather than reading whatever size arrives', async () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBeLessThanOrEqual(128 * 1024);
    const root = await tree({ 'big.txt': 'b'.repeat(DEFAULT_MAX_FILE_BYTES + 10) });
    const reader = await openRepoReader(root);
    const file = await reader.readText('big.txt');
    expect(file?.text.length).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(file?.truncated).toBe(true);
  });

  it('returns null for a missing file instead of throwing', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reader = await openRepoReader(root);
    expect(await reader.readText('nope.json')).toBeNull();
  });

  it('returns null for a directory', async () => {
    const root = await tree({ 'docs/a.md': 'x' });
    const reader = await openRepoReader(root);
    expect(await reader.readText('docs')).toBeNull();
  });

  it('refuses an absolute path', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reader = await openRepoReader(root);
    const error = await reader.readText(path.join(tmpdir(), 'package.json')).catch((e) => e);
    expect((error as AppError).kind).toBe('validation');
    expect(kind(error)).toMatch(/relative to the authorized root/);
  });

  it('refuses a parent traversal', async () => {
    const root = await tree({ 'package.json': '{}' });
    const reader = await openRepoReader(root);
    const error = await reader.readText('../outside.json').catch((e) => e);
    expect((error as AppError).kind).toBe('validation');
    expect(kind(error)).toMatch(/parent traversal/);
  });

  it('refuses a nested traversal that starts inside the tree', async () => {
    const root = await tree({ 'src/a.ts': 'x' });
    const reader = await openRepoReader(root);
    const error = await reader.readText(path.join('src', '..', '..', 'escape.ts')).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
  });

  it.skipIf(!CAN_SYMLINK)('refuses a link whose target is outside the repository', async () => {
    const root = await tree({ 'package.json': '{}' });
    const outside = await tree({ 'secret.txt': 'topsecret' });
    const made = await makeLink(
      path.join(outside, 'secret.txt'),
      path.join(root, 'linked.txt'),
      'file',
    );
    if (!made) throw new Error('the platform refused to create a link');
    const reader = await openRepoReader(root);
    const error = await reader.readText('linked.txt').catch((e) => e);
    expect(kind(error)).toMatch(/resolves outside the repository/);
  });

  it.skipIf(!CAN_SYMLINK)(
    'never reads through a link, even one that stays inside the repository',
    async () => {
      const root = await tree({ 'real.txt': 'the real file', 'package.json': '{}' });
      const made = await makeLink(
        path.join(root, 'real.txt'),
        path.join(root, 'linked.txt'),
        'file',
      );
      if (!made) throw new Error('the platform refused to create a link');
      const reader = await openRepoReader(root);
      expect(await reader.readText('real.txt')).not.toBeNull();
      expect(await reader.readText('linked.txt')).toBeNull();
    },
  );

  it('leaves the tree exactly as it found it', async () => {
    const root = await tree({ 'a.md': 'x', 'docs/b.md': 'y' });
    const before = await snapshotTree(root);
    const reader = await openRepoReader(root);
    await reader.readText('a.md');
    await reader.readText('docs/b.md');
    await reader.listDirectory('.');
    await reader.walk('docs', 3, 10);
    expect(await snapshotTree(root)).toEqual(before);
  });
});

describe('RepoReader.existsAny', () => {
  it('reports only the files that exist, normalised to forward slashes', async () => {
    const root = await tree({ 'package.json': '{}', 'src/a.ts': 'x' });
    const reader = await openRepoReader(root);
    expect(
      await reader.existsAny(['package.json', 'pyproject.toml', path.join('src', 'a.ts')]),
    ).toEqual(['package.json', 'src/a.ts']);
  });

  it('ignores a directory that shares a candidate name', async () => {
    const root = await tree({ 'package.json/x': 'nested' });
    const reader = await openRepoReader(root);
    expect(await reader.existsAny(['package.json'])).toEqual([]);
  });

  it('treats an escaping candidate as absent rather than throwing', async () => {
    const root = await tree({ 'a.md': 'x' });
    const reader = await openRepoReader(root);
    expect(await reader.existsAny(['../a.md', 'a.md'])).toEqual(['a.md']);
  });
});

describe('RepoReader.listDirectory', () => {
  it('lists entries sorted, without following links', async () => {
    const root = await tree({ 'b.md': 'x', 'a.md': 'y', 'sub/c.md': 'z' });
    const reader = await openRepoReader(root);
    expect(await reader.listDirectory('.')).toEqual([
      { name: 'a.md', kind: 'file' },
      { name: 'b.md', kind: 'file' },
      { name: 'sub', kind: 'directory' },
    ]);
  });

  it('bounds a directory listing', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_DIR_ENTRIES + 40; i += 1) many[`f${String(i)}.txt`] = 'x';
    const root = await tree(many);
    const reader = await openRepoReader(root);
    expect((await reader.listDirectory('.')).length).toBe(MAX_DIR_ENTRIES);
  });

  it('returns empty for a directory that is not there', async () => {
    const root = await tree({ 'a.md': 'x' });
    const reader = await openRepoReader(root);
    expect(await reader.listDirectory('nope')).toEqual([]);
  });
});

describe('RepoReader.walk', () => {
  it('collects files depth-first and never names a directory', async () => {
    const root = await tree({ 'a.md': 'x', 'src/b.ts': 'y', 'src/deep/c.ts': 'z' });
    const reader = await openRepoReader(root);
    expect(await reader.walk('.', 3, 50)).toEqual(['a.md', 'src/b.ts', 'src/deep/c.ts']);
  });

  it('skips dependency, build and Git directories whatever the repository claims', async () => {
    const root = await tree({
      'a.md': 'x',
      'node_modules/left-pad/index.js': 'x',
      '.git/config': 'x',
      'dist/bundle.js': 'x',
      '.mergesutra/runs/run-x.json': 'x',
    });
    const reader = await openRepoReader(root);
    expect(await reader.walk('.', 4, 50)).toEqual(['a.md']);
  });

  it('honours the depth limit and reports paths relative to the root', async () => {
    const root = await tree({ 'src/a/b/c/deep.ts': 'x' });
    const reader = await openRepoReader(root);
    expect(await reader.walk('src', 1, 50)).toEqual([]);
    expect(await reader.walk('src', 4, 50)).toEqual(['src/a/b/c/deep.ts']);
  });

  it('honours the file limit', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) many[`src/f${String(i)}.ts`] = 'x';
    const root = await tree(many);
    const reader = await openRepoReader(root);
    expect((await reader.walk('src', 2, 5)).length).toBe(5);
  });

  it.skipIf(!CAN_SYMLINK)('does not follow a directory link out of the tree', async () => {
    const root = await tree({ 'a.md': 'x' });
    const outside = await tree({ 'secret.env': 'A_SECRET = "b"' });
    const made = await makeLink(outside, path.join(root, 'linked-dir'), 'directory');
    if (!made) throw new Error('the platform refused to create a link');
    const reader = await openRepoReader(root);
    expect(await reader.walk('.', 3, 50)).toEqual(['a.md']);
    const error = await reader.readText(path.join('linked-dir', 'secret.env')).catch((e) => e);
    expect(kind(error)).toMatch(/resolves outside the repository/);
  });
});

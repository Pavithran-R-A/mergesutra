import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { MAX_WRITE_BYTES, openConfinedWriter } from '../../src/security/writer.js';
import { makeFixtureTree, makeLink, snapshotTree } from '../helpers/fixture.js';

/**
 * The write boundary, tested as a boundary.
 *
 * Each test names an attack that has a real name in the security model —
 * traversal, absolute escape, a symlinked ancestor, writing through a link, a
 * path that crosses `.git`, a huge file — and asserts the writer refuses it.
 * The happy path is one test, not the collection.
 */

const SCRATCH = await makeFixtureTree({ 'secret.txt': 'outside the workspace\n' });
const OUTSIDE = path.join(SCRATCH, 'outside');
let workspace: string;

beforeAll(async () => {
  workspace = path.join(SCRATCH, 'workspace');
  await mkdir(path.join(OUTSIDE, 'keep'), { recursive: true });
  await writeFile(path.join(OUTSIDE, 'secret.txt'), 'outside the workspace\n', 'utf8');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'existing.ts'), 'const a = 1;\n', 'utf8');
});

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
});

describe('openConfinedWriter', () => {
  it('keeps the link-resolved root, not the spelling it was handed', async () => {
    const writer = await openConfinedWriter(workspace);
    // On Windows `path.resolve` alone can leave an 8.3 short name for the same
    // directory, which would then compare unequal to the long spelling of a
    // target inside it. The root is realpath'd once, so every check below
    // compares paths in one form.
    expect(writer.root).toBe(await realpath(workspace));
  });

  it('refuses a root that does not exist or is not a directory', async () => {
    await expect(openConfinedWriter(path.join(workspace, 'nope'))).rejects.toThrow(AppError);
    await expect(openConfinedWriter(path.join(workspace, 'existing.ts'))).rejects.toThrow(AppError);
  });

  it('exposes no way to delete, move or change permissions', async () => {
    const writer = await openConfinedWriter(workspace);
    const methods = Object.keys(writer)
      .filter((key) => typeof writer[key as keyof typeof writer] === 'function')
      .sort();
    expect(methods).toEqual(['exists', 'writeText']);
  });
});

describe('writeText', () => {
  it('writes a repository-relative file and reports what it did', async () => {
    const writer = await openConfinedWriter(workspace);
    const text = 'export const day = 1;\n';
    const receipt = await writer.writeText('src/date.ts', text);
    expect(receipt).toEqual({
      relativePath: 'src/date.ts',
      bytes: Buffer.byteLength(text),
      created: true,
    });
    expect(await readFile(path.join(workspace, 'src', 'date.ts'), 'utf8')).toBe(text);
  });

  it('replaces an existing file and says it was not created', async () => {
    const writer = await openConfinedWriter(workspace);
    const receipt = await writer.writeText('existing.ts', 'const a = 2;\n');
    expect(receipt.created).toBe(false);
    expect(await readFile(path.join(workspace, 'existing.ts'), 'utf8')).toBe('const a = 2;\n');
  });

  it('creates the directories it needs and leaves no temporary file behind', async () => {
    const writer = await openConfinedWriter(workspace);
    await writer.writeText('nested/deep/file.md', '# hi\n');
    const tree = await snapshotTree(workspace);
    expect(tree).toContain('nested/deep/file.md');
    expect(tree.filter((name) => name.includes('mergesutra-tmp'))).toEqual([]);
  });

  it('refuses traversal, absolute paths and a NUL byte in the name', async () => {
    const writer = await openConfinedWriter(workspace);
    for (const target of [
      '../escaped.ts',
      'src/../../escaped.ts',
      path.join(workspace, '..', 'escaped.ts'),
      path.join(OUTSIDE, 'absolute.ts'),
      '/etc/absolute-escape.ts',
      'with\0nul.ts',
    ]) {
      await expect(writer.writeText(target, 'x'), target).rejects.toThrow(AppError);
    }
    expect(await readFile(path.join(OUTSIDE, 'secret.txt'), 'utf8')).toContain('outside');
  });

  it('refuses any path that crosses .git, in any spelling', async () => {
    const writer = await openConfinedWriter(workspace);
    for (const target of ['.git/config', 'sub/.GIT/HEAD', '.git/hooks/pre-commit']) {
      await expect(writer.writeText(target, 'x'), target).rejects.toThrow(/\.git/);
    }
  });

  it('refuses a symlinked or junctioned ancestor that points out of the workspace', async () => {
    const writer = await openConfinedWriter(workspace);
    const linked = await makeLink(OUTSIDE, path.join(workspace, 'linkdir'), 'directory');
    if (!linked) return;
    await expect(writer.writeText('linkdir/out.ts', 'x')).rejects.toThrow(AppError);
    // The link itself is untouched: refusing is not the same as repairing.
    expect(await snapshotTree(OUTSIDE)).toContain('secret.txt');
  });

  it('refuses to write through a symlink even when the link target is inside', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = path.join(workspace, 'inside-target.ts');
    await writeFile(target, 'original\n', 'utf8');
    try {
      await symlink(target, path.join(workspace, 'inside-link.ts'), 'file');
    } catch {
      return; // Creating links needs permission this process may not have.
    }
    await expect(writer.writeText('inside-link.ts', 'replaced\n')).rejects.toThrow(/symlink/);
    expect(await readFile(target, 'utf8')).toBe('original\n');
  });

  it('refuses a directory standing where the file should go', async () => {
    const writer = await openConfinedWriter(workspace);
    await mkdir(path.join(workspace, 'as-dir'), { recursive: true });
    await expect(writer.writeText('as-dir', 'x')).rejects.toThrow(AppError);
  });

  it('refuses content over the single-write cap, and a NUL byte in the content', async () => {
    const writer = await openConfinedWriter(workspace);
    await expect(writer.writeText('huge.ts', 'a'.repeat(MAX_WRITE_BYTES + 1))).rejects.toThrow(
      /over the/,
    );
    await expect(writer.writeText('nul-content.ts', 'a\0b')).rejects.toThrow(/NUL/);
    expect(await writer.exists('huge.ts')).toBe(false);
    expect(await writer.exists('nul-content.ts')).toBe(false);
  });

  it('keeps the previous file intact when a later write is refused', async () => {
    const writer = await openConfinedWriter(workspace);
    await writer.writeText('kept.ts', 'one\n');
    await expect(writer.writeText('kept.ts', 'b'.repeat(MAX_WRITE_BYTES + 1))).rejects.toThrow(
      AppError,
    );
    expect(await readFile(path.join(workspace, 'kept.ts'), 'utf8')).toBe('one\n');
  });

  it('reports existence without following links or leaving the root', async () => {
    const writer = await openConfinedWriter(workspace);
    expect(await writer.exists('existing.ts')).toBe(true);
    expect(await writer.exists('missing.ts')).toBe(false);
    expect(await writer.exists('../outside/secret.txt')).toBe(false);
  });
});

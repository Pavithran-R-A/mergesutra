import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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
    const receipt = await writer.writeText('src/date.ts', text, { expectedAbsent: true });
    expect(receipt).toEqual({
      relativePath: 'src/date.ts',
      bytes: Buffer.byteLength(text),
      created: true,
      contentSha256: sha256Hex(text),
    });
    expect(await readFile(path.join(workspace, 'src', 'date.ts'), 'utf8')).toBe(text);
  });

  it('replaces an existing file and says it was not created', async () => {
    const writer = await openConfinedWriter(workspace);
    const receipt = await writer.writeText('existing.ts', 'const a = 2;\n', {
      expectedSha256: sha256Hex('const a = 1;\n'),
    });
    expect(receipt.created).toBe(false);
    expect(await readFile(path.join(workspace, 'existing.ts'), 'utf8')).toBe('const a = 2;\n');
  });

  it('creates the directories it needs and leaves no temporary file behind', async () => {
    const writer = await openConfinedWriter(workspace);
    await writer.writeText('nested/deep/file.md', '# hi\n', { expectedAbsent: true });
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
      await expect(writer.writeText(target, 'x', { expectedAbsent: true }), target).rejects.toThrow(
        AppError,
      );
    }
    expect(await readFile(path.join(OUTSIDE, 'secret.txt'), 'utf8')).toContain('outside');
  });

  it('refuses any path that crosses .git, in any spelling', async () => {
    const writer = await openConfinedWriter(workspace);
    for (const target of ['.git/config', 'sub/.GIT/HEAD', '.git/hooks/pre-commit']) {
      await expect(writer.writeText(target, 'x', { expectedAbsent: true })).rejects.toThrow(
        /\.git/,
      );
    }
  });

  it('refuses a symlinked or junctioned ancestor that points out of the workspace', async () => {
    const writer = await openConfinedWriter(workspace);
    const linked = await makeLink(OUTSIDE, path.join(workspace, 'linkdir'), 'directory');
    if (!linked) return;
    await expect(writer.writeText('linkdir/out.ts', 'x', { expectedAbsent: true })).rejects.toThrow(
      AppError,
    );
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
    await expect(
      writer.writeText('inside-link.ts', 'replaced\n', { expectedAbsent: true }),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(target, 'utf8')).toBe('original\n');
  });

  it('refuses a directory standing where the file should go', async () => {
    const writer = await openConfinedWriter(workspace);
    await mkdir(path.join(workspace, 'as-dir'), { recursive: true });
    await expect(writer.writeText('as-dir', 'x', { expectedAbsent: true })).rejects.toThrow(
      AppError,
    );
  });

  it('refuses content over the single-write cap, and a NUL byte in the content', async () => {
    const writer = await openConfinedWriter(workspace);
    await expect(
      writer.writeText('huge.ts', 'a'.repeat(MAX_WRITE_BYTES + 1), { expectedAbsent: true }),
    ).rejects.toThrow(/over the/);
    await expect(
      writer.writeText('nul-content.ts', 'a\0b', { expectedAbsent: true }),
    ).rejects.toThrow(/NUL/);
    expect(await writer.exists('huge.ts')).toBe(false);
    expect(await writer.exists('nul-content.ts')).toBe(false);
  });

  it('keeps the previous file intact when a later write is refused', async () => {
    const writer = await openConfinedWriter(workspace);
    await writer.writeText('kept.ts', 'one\n', { expectedAbsent: true });
    await expect(
      writer.writeText('kept.ts', 'b'.repeat(MAX_WRITE_BYTES + 1), {
        expectedSha256: sha256Hex('one\n'),
      }),
    ).rejects.toThrow(AppError);
    expect(await readFile(path.join(workspace, 'kept.ts'), 'utf8')).toBe('one\n');
  });

  it('reports existence without following links or leaving the root', async () => {
    const writer = await openConfinedWriter(workspace);
    expect(await writer.exists('existing.ts')).toBe(true);
    expect(await writer.exists('missing.ts')).toBe(false);
    expect(await writer.exists('../outside/secret.txt')).toBe(false);
  });
});

describe('write preconditions (compare-before-write)', () => {
  /**
   * Stage 7's closing of a Stage 6 gap.
   *
   * A whole-file write by a loop that never looked at the file — or looked at a
   * version something else has since changed — silently destroys the difference.
   * The writer now refuses to replace bytes it cannot prove are the bytes the
   * caller was describing, and it proves that by reading the disk itself rather
   * than trusting when the caller last looked.
   *
   * This is optimistic concurrency, not a filesystem transaction: the check runs
   * immediately before the rename, and a change landing inside that window is
   * still a change this process cannot see.
   */
  const ORIGINAL = 'export const value = 1;\n';
  const REPLACEMENT = 'export const value = 2;\n';

  async function seeded(name: string): Promise<string> {
    const text = `precondition/${name}.ts`;
    await mkdir(path.join(workspace, 'precondition'), { recursive: true });
    await writeFile(path.join(workspace, text), ORIGINAL, 'utf8');
    return text;
  }

  it('replaces an existing file when the digest matches the bytes on disk', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = await seeded('matching');
    const receipt = await writer.writeText(target, REPLACEMENT, {
      expectedSha256: sha256Hex(ORIGINAL),
    });

    expect(receipt).toEqual({
      relativePath: target,
      bytes: Buffer.byteLength(REPLACEMENT),
      created: false,
      contentSha256: sha256Hex(REPLACEMENT),
    });
    expect(await readFile(path.join(workspace, target), 'utf8')).toBe(REPLACEMENT);
  });

  it('refuses a digest that does not match the file on disk and changes nothing', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = await seeded('stale');
    const error = await writer
      .writeText(target, REPLACEMENT, { expectedSha256: sha256Hex('something else entirely\n') })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details?.code).toBe('STALE_FILE');
    expect((error as AppError).message).toContain('STALE_FILE');
    expect(await readFile(path.join(workspace, target), 'utf8')).toBe(ORIGINAL);
  });

  it('does not hand the current digest back, which would replace re-reading with guessing', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = await seeded('withheld');
    const error = await writer
      .writeText(target, REPLACEMENT, { expectedSha256: sha256Hex('an obsolete version\n') })
      .catch((thrown: unknown) => thrown);

    const text = `${(error as AppError).message} ${JSON.stringify((error as AppError).details)}`;
    expect(text).not.toContain(sha256Hex(ORIGINAL));
    expect(text).toMatch(/read the file again/i);
  });

  it('leaves no temporary file behind when a precondition fails', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = await seeded('tmp');
    await expect(
      writer.writeText(target, REPLACEMENT, { expectedSha256: sha256Hex('nope\n') }),
    ).rejects.toThrow(AppError);
    const tree = await snapshotTree(path.dirname(path.join(workspace, target)));
    expect(tree.filter((name) => name.includes('mergesutra-tmp'))).toEqual([]);
  });

  it('refuses a matching digest at a path where no file exists', async () => {
    const writer = await openConfinedWriter(workspace);
    const error = await writer
      .writeText('never-existed.ts', REPLACEMENT, { expectedSha256: sha256Hex(ORIGINAL) })
      .catch((thrown: unknown) => thrown);
    expect((error as AppError).details?.code).toBe('STALE_FILE');
    expect(await writer.exists('never-existed.ts')).toBe(false);
  });

  it('creates a new file when it is proved still absent', async () => {
    const writer = await openConfinedWriter(workspace);
    const receipt = await writer.writeText('brand-new/src.ts', REPLACEMENT, {
      expectedAbsent: true,
    });
    expect(receipt.created).toBe(true);
    expect(receipt.contentSha256).toBe(sha256Hex(REPLACEMENT));
    expect(await readFile(path.join(workspace, 'brand-new', 'src.ts'), 'utf8')).toBe(REPLACEMENT);
  });

  it('refuses expectedAbsent when a file appeared at the path in the meantime', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = await seeded('appeared');
    const error = await writer
      .writeText(target, REPLACEMENT, { expectedAbsent: true })
      .catch((thrown: unknown) => thrown);

    expect((error as AppError).details?.code).toBe('STALE_FILE');
    expect(await readFile(path.join(workspace, target), 'utf8')).toBe(ORIGINAL);
  });

  it('confines a preconditioned write exactly as it confines any other', async () => {
    const writer = await openConfinedWriter(workspace);
    // A digest that happens to be correct for a file outside the workspace is not
    // a passport: the path rule is checked first and the write never gets as far
    // as the precondition.
    await expect(
      writer.writeText('../escaped.ts', 'x', {
        expectedSha256: sha256Hex('outside the workspace\n'),
      }),
    ).rejects.toThrow(/traversal/);
    await expect(writer.writeText('.git/config', 'x', { expectedAbsent: true })).rejects.toThrow(
      /\.git/,
    );
    expect(await readFile(path.join(OUTSIDE, 'secret.txt'), 'utf8')).toContain('outside');
  });

  it('refuses to replace a file too large to have been observed whole', async () => {
    const writer = await openConfinedWriter(workspace);
    const target = 'oversized.ts';
    await writeFile(path.join(workspace, target), 'a'.repeat(MAX_WRITE_BYTES + 1), 'utf8');
    const error = await writer
      .writeText(target, REPLACEMENT, {
        expectedSha256: sha256Hex('a'.repeat(MAX_WRITE_BYTES + 1)),
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toMatch(/too large|over the/);
    expect((error as AppError).details?.code).not.toBe('STALE_FILE');
    expect(await readFile(path.join(workspace, target), 'utf8')).toBe(
      'a'.repeat(MAX_WRITE_BYTES + 1),
    );
  });
});

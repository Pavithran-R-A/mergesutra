import { createHash } from 'node:crypto';
import type * as fsPromises from 'node:fs/promises';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { CAN_SYMLINK, makeFixtureTree, makeLink, snapshotTree } from '../helpers/fixture.js';
import { openConfinedWriter, type ConfinedWriter } from '../../src/security/writer.js';

/**
 * The window between the link check and the replacing operation (S12-10).
 *
 * `src/security/writer.ts` proves a path is inside the workspace, then writes a
 * temp file, then proves the caller's account of the bytes, then renames. Each of
 * those steps reads the filesystem again, and the filesystem is allowed to change
 * between them. This file changes it on purpose, at a chosen moment, and records
 * what the writer then does — because the alternative is to leave a claim about
 * links unaimed at the one gap where links can still move.
 *
 * The swap is not a race. It is armed as a callback that fires *after* the link
 * layer's own `realpath` has returned its answer, so the check is proved to have
 * seen the tree as it was and every later operation to see the tree as it is now.
 * Same thread, same call, deterministic on every run.
 *
 * Every case below is a detection, and the order matters. Run against a writer
 * that proved the way only once, the ancestor-swap case was not a detection: the
 * payload landed outside the workspace and the call reported success. The second
 * proof, at the last moment before the rename, is what turns it into the refusal
 * asserted here — and it narrows the window rather than closing one, which is
 * what the final case and SECURITY_MODEL §21 say out loud.
 */

const hook = vi.hoisted(() => ({ swap: null as null | (() => Promise<void>) }));
const linkCheckSaw = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  return {
    ...real,
    async realpath(target: Parameters<typeof real.realpath>[0]) {
      const value = await real.realpath(target);
      linkCheckSaw.push(String(target));
      const swap = hook.swap;
      if (swap !== null) {
        // The link layer has just been answered for `target`. Change the tree now.
        hook.swap = null;
        await swap();
      }
      return value;
    },
  };
});

const SCRATCH = await makeFixtureTree({ placeholder: 'x\n' });
const WORKSPACE = path.join(SCRATCH, 'workspace');
const OUTSIDE = path.join(SCRATCH, 'outside');
const OUTSIDE_SECRET = 'outside the workspace\n';

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function outsideTree(): Promise<string[]> {
  return (await snapshotTree(OUTSIDE)).sort();
}

let writer: ConfinedWriter;

beforeAll(async () => {
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(OUTSIDE, { recursive: true });
  await writeFile(path.join(OUTSIDE, 'secret.txt'), OUTSIDE_SECRET, 'utf8');
  await mkdir(path.join(WORKSPACE, 'sub'), { recursive: true });
  writer = await openConfinedWriter(WORKSPACE);
});

afterAll(async () => {
  hook.swap = null;
  await rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
});

describe('what the byte check at the last moment does catch', () => {
  it('a file changed behind the caller’s back is refused, and the new bytes survive', async () => {
    const shown = 'the version the caller was given\n';
    await writeFile(path.join(WORKSPACE, 'changed.ts'), shown, 'utf8');

    hook.swap = async () => {
      await writeFile(path.join(WORKSPACE, 'changed.ts'), 'someone elses version\n', 'utf8');
    };
    await expect(
      writer.writeText('changed.ts', 'the version proposed\n', { expectedSha256: digestOf(shown) }),
    ).rejects.toThrow(/STALE_FILE/);
    hook.swap = null;

    // Refusing is not repairing: whatever landed in between is what stays.
    expect(await readFile(path.join(WORKSPACE, 'changed.ts'), 'utf8')).toBe(
      'someone elses version\n',
    );
  });

  it('a leaf that becomes a link mid-write is refused, and its target is untouched', async () => {
    const original = 'original\n';
    const leaf = path.join(WORKSPACE, 'lastleaf.ts');
    await writeFile(leaf, original, 'utf8');
    const outsideBefore = await outsideTree();

    hook.swap = async () => {
      await rm(leaf, { force: true });
      const made = await makeLink(path.join(OUTSIDE, 'secret.txt'), leaf, 'file');
      if (!made) throw new Error('this platform would not make the leaf link');
    };
    const failure = await writer
      .writeText('lastleaf.ts', 'proposed\n', { expectedSha256: digestOf(original) })
      .then(
        () => null,
        (error: unknown) => error,
      );
    hook.swap = null;

    expect(failure, 'a link that appeared must not be written through').toBeInstanceOf(AppError);
    expect((failure as Error).message).toMatch(/not a regular file|the target is a symlink/);
    expect(await readFile(path.join(OUTSIDE, 'secret.txt'), 'utf8')).toBe(OUTSIDE_SECRET);
    expect(await outsideTree()).toEqual(outsideBefore);
  });
});

describe('what the last moment re-checks, and what it cannot', () => {
  it('an ordinary link that was already there is refused, with no help from this file', async () => {
    // Included so the difference between "a link that was already there" and "a
    // link that appeared" is visible in one place. Nothing is armed here.
    const made = await makeLink(OUTSIDE, path.join(WORKSPACE, 'already'), 'directory');
    if (!made) return;
    await expect(
      writer.writeText('already/plain.txt', 'x\n', { expectedAbsent: true }),
    ).rejects.toThrow(/a link or directory on the way resolves outside the workspace/);
  });

  it.skipIf(!CAN_SYMLINK)(
    'an ancestor swapped for a link mid-write is caught before the payload is placed',
    async () => {
      const dir = path.join(WORKSPACE, 'midwrite');
      await mkdir(dir, { recursive: true });
      const outsideBefore = await outsideTree();

      hook.swap = async () => {
        // `midwrite` has just been proved to be a real directory inside the root.
        // Move it aside and put a junction to the outside directory in its place,
        // so every later step of this write is pointed at a different tree.
        const stash = path.join(SCRATCH, 'midwrite-stash');
        await rm(stash, { recursive: true, force: true });
        await mkdir(stash, { recursive: true });
        await rename(dir, path.join(stash, 'dir'));
        const made = await makeLink(OUTSIDE, dir, 'directory');
        if (!made) throw new Error('this platform would not make the ancestor link');
      };

      const failure = await writer
        .writeText('midwrite/payload.txt', 'written through the window\n', { expectedAbsent: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      hook.swap = null;

      expect(failure, 'the way must be proved again before it is used').toBeInstanceOf(AppError);
      expect((failure as Error).message).toMatch(
        /a link or directory on the way resolves outside the workspace/,
      );
      // Nothing was left outside — not the payload, and not the scratch file the
      // write staged before it noticed.
      expect(await outsideTree()).toEqual(outsideBefore);
    },
  );

  it('proves the way twice: before the bytes are staged, and before they are placed', async () => {
    // The link layer is consulted for the deepest existing ancestor. Once is not
    // enough, because the operation that follows is long: a temp file is written,
    // synced and read back before the rename that replaces anything. Twice is the
    // most this design can do, and the count is the claim — a window between the
    // second proof and the rename syscall remains, and SECURITY_MODEL says so.
    linkCheckSaw.length = 0;
    await writer.writeText('sub/one.ts', 'one\n', { expectedAbsent: true });
    expect(linkCheckSaw).toEqual([path.join(writer.root, 'sub'), path.join(writer.root, 'sub')]);
  });
});

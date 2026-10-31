import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { resolveConfinedFile } from '../../src/security/realpath.js';
import { makeLink } from '../helpers/fixture.js';

/**
 * A confined read whose leaf may not exist yet.
 *
 * Stage 9 checks a tracked file before Git opens it, and Stage 7 measures files a
 * plan may not have written. Both need "inside the root, or absent" — and absent
 * must not become an unchecked name. A link in a parent directory is still a link
 * when the leaf below it is missing: the missing leaf is what the caller hands to
 * Git next, and Git resolves it through the same link.
 */

const made: string[] = [];

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'mergesutra-confined-'));
  made.push(base);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

describe('a confined file that is allowed to be missing', () => {
  it('refuses a missing leaf reached through a link out of the root', async () => {
    const { root, outside } = await fixture();
    await writeFile(path.join(outside, 'secret.txt'), 'host secret\n', 'utf8');
    const linked = await makeLink(outside, path.join(root, 'config'), 'directory');
    expect(linked, 'this host can create a directory link').toBe(true);

    const failure = await resolveConfinedFile(root, 'config/missing.txt', 'review file', {
      allowMissing: true,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as Error).message).toMatch(/link or junction|outside the workspace/i);
  });

  it('allows a deletion inside the root and a path that does not exist yet', async () => {
    const { root } = await fixture();

    await expect(
      resolveConfinedFile(root, 'gone.txt', 'review file', { allowMissing: true }),
    ).resolves.toBeNull();
    await expect(
      resolveConfinedFile(root, 'src/not-written-yet.ts', 'review file', { allowMissing: true }),
    ).resolves.toBeNull();
  });
});

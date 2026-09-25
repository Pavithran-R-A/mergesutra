import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { sha256Hex } from '../../src/security/digest.js';
import { describePatch, stalenessOf, type PatchDescription } from '../../src/verify/patch.js';
import { hasGit, initRepository } from '../helpers/git.js';

/**
 * Naming a patch, and proving a piece of evidence still describes it.
 *
 * Every test here runs against a real Git repository, because the whole point of
 * a patch identity is that it is what Git says is different — not what a model
 * remembers writing. Repositories are built with no dependencies and no
 * toolchain, so the suite needs nothing but `git`.
 */

const made: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<{ dir: string; base: string }> {
  const repo = await initRepository(files);
  made.push(repo.dir);
  return repo;
}

const AVAILABLE = await hasGit();

async function put(dir: string, relative: string, contents: string): Promise<void> {
  const target = path.join(dir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

function paths(description: PatchDescription): string[] {
  return description.files.map((file) => file.path);
}

describe.skipIf(!AVAILABLE)('what a patch is', () => {
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('says a workspace that matches its base commit changed nothing', async () => {
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    const clean = await describePatch({ workspace: dir, baseSha: base });

    expect(clean.files).toEqual([]);
    expect(clean.baseSha).toBe(base);
    expect(clean.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names the bytes on disk as the proof that a tracked file changed', async () => {
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    await put(dir, 'src/a.ts', 'fixed\n');

    const patch = await describePatch({ workspace: dir, baseSha: base });

    expect(paths(patch)).toEqual(['src/a.ts']);
    expect(patch.files[0]).toEqual({
      path: 'src/a.ts',
      tracked: true,
      change: 'MODIFIED',
      contentSha256: sha256Hex('fixed\n'),
    });

    await put(dir, 'src/a.ts', 'fixed differently\n');
    const rewritten = await describePatch({ workspace: dir, baseSha: base });
    expect(rewritten.identity).not.toBe(patch.identity);
  });

  it('counts a file the run deleted, even though nothing is there to hash', async () => {
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n', 'src/gone.ts': 'x\n' });
    await rm(path.join(dir, 'src/gone.ts'));

    const patch = await describePatch({ workspace: dir, baseSha: base });

    const gone = patch.files.find((file) => file.path === 'src/gone.ts');
    expect(gone).toEqual({
      path: 'src/gone.ts',
      tracked: true,
      change: 'DELETED',
      contentSha256: null,
    });
  });

  it('counts an untracked new file, because that is what the gate will actually read', async () => {
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n' });
    await put(dir, 'tests/a.test.ts', 'test(1, 1)\n');

    const patch = await describePatch({ workspace: dir, baseSha: base });

    expect(patch.files).toEqual([
      {
        path: 'tests/a.test.ts',
        tracked: false,
        change: 'ADDED',
        contentSha256: sha256Hex('test(1, 1)\n'),
      },
    ]);
  });

  it('is not disturbed by a dependency directory Git ignores', async () => {
    const { dir, base } = await makeRepo({
      'src/a.ts': 'a\n',
      '.gitignore': 'node_modules/\n.mergesutra/\n',
    });
    await put(dir, 'src/a.ts', 'fixed\n');
    const before = await describePatch({ workspace: dir, baseSha: base });

    await put(dir, 'node_modules/left-pad/index.js', 'anything at all\n');
    await put(dir, 'node_modules/left-pad/package.json', '{}\n');
    const after = await describePatch({ workspace: dir, baseSha: base });

    expect(after.identity).toBe(before.identity);
    expect(paths(after)).toEqual(['src/a.ts']);
  });

  it('excludes MergeSutra scratch and a nested workspace even when the repository forgot to ignore them', async () => {
    // No .gitignore at all: a repository that never heard of MergeSutra must not
    // be able to make one run's evidence part of another run's patch.
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n' });
    await put(dir, 'src/a.ts', 'fixed\n');
    const before = await describePatch({ workspace: dir, baseSha: base });

    await put(dir, '.mergesutra/worktrees/other-run/src/a.ts', 'a\n');
    await put(dir, '.mergesutra/runs/run-1/record.json', '{}\n');
    const after = await describePatch({ workspace: dir, baseSha: base });

    expect(after.identity).toBe(before.identity);
    expect(paths(after)).toEqual(['src/a.ts']);
  });

  it('reports a rename as one file gone and another arrived, not as a guess', async () => {
    const { dir, base } = await makeRepo({ 'src/name.ts': 'same content\n' });
    await defaultRunner('git', ['-C', dir, 'mv', 'src/name.ts', 'src/renamed.ts']);

    const patch = await describePatch({ workspace: dir, baseSha: base });

    expect(patch.files.map((file) => [file.path, file.change])).toEqual([
      ['src/name.ts', 'DELETED'],
      ['src/renamed.ts', 'ADDED'],
    ]);
  });

  it('gives the same identity to the same content however the files were written', async () => {
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
    await put(dir, 'src/b.ts', 'second\n');
    await put(dir, 'src/a.ts', 'first\n');
    const one = await describePatch({ workspace: dir, baseSha: base });

    await put(dir, 'src/a.ts', 'a\n');
    await put(dir, 'src/b.ts', 'b\n');
    await put(dir, 'src/b.ts', 'second\n');
    await put(dir, 'src/a.ts', 'first\n');
    const two = await describePatch({ workspace: dir, baseSha: base });

    expect(two.identity).toBe(one.identity);
    expect(paths(two)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('refuses to describe a workspace that is sitting on a different commit', async () => {
    const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n' });
    await put(dir, 'src/a.ts', 'fixed\n');
    const committed = await defaultRunner('git', ['-C', dir, 'commit', '-q', '-am', 'second']);
    expect(committed.code).toBe(0);

    await expect(describePatch({ workspace: dir, baseSha: base })).rejects.toThrow(
      /base commit|HEAD/i,
    );
  });

  it('refuses a directory that is not a Git tree rather than inventing an empty patch', async () => {
    const nowhere = await mkdtemp(path.join(tmpdir(), 'mergesutra-nogit-'));
    made.push(nowhere);

    await expect(describePatch({ workspace: nowhere, baseSha: '0'.repeat(40) })).rejects.toThrow(
      /git|workspace/i,
    );
  });
});

describe('staleness of evidence against the patch it describes', () => {
  it('calls evidence current when the patch has not moved', () => {
    const identity = sha256Hex('same');
    expect(stalenessOf(identity, identity).status).toBe('CURRENT');
  });

  it('calls evidence for one patch stale against another, and names both', () => {
    const verdict = stalenessOf(sha256Hex('patch A'), sha256Hex('patch B'));

    expect(verdict.status).toBe('STALE');
    expect(verdict.reason).toMatch(/different patch/i);
    expect(verdict.recordedIdentity).not.toBe(verdict.currentIdentity);
  });

  it('refuses to compare a digest that was never computed by anything', () => {
    expect(() => stalenessOf('uncommitted-changes', sha256Hex('x'))).toThrow(/64|digest|hex/i);
  });
});

import { existsSync } from 'node:fs';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { prepareWorkspace, WORKTREE_BASE_DIR } from '../../src/git/workspace.js';
import { resolveTrustedGitDir } from '../../src/git/workspace-git-dir.js';
import { isInsideRoot, isSamePath } from '../../src/security/path-safety.js';
import { describePatch } from '../../src/verify/patch.js';
import { makeFixtureTree } from '../helpers/fixture.js';
import { hasGit, headOf, initRepository, statusOf } from '../helpers/git.js';

/**
 * The customer topology nobody had driven: a repository that is itself a worktree.
 *
 * MergeSutra's whole workspace story assumes Stage 5 can nest a run's linked worktree
 * inside the operator's checkout. An operator who already works that way — a clone with
 * several `git worktree` checkouts of it, which is how a lot of reviewers keep a branch
 * under review without disturbing the one they are on — puts a second `.git` pointer in
 * the path, so the run's metadata ends up registered in the *parent* clone's `.git`, two
 * directory levels above anything the run can write. Nothing in the committed suite had that
 * shape: every real-Git fixture's repository is a plain `git init` checkout
 * (`tests/helpers/git.ts`), and where those fixtures do create worktrees with real Git, they
 * create a run's own or a sibling's *inside* that checkout — never a checkout that is itself
 * the worktree the run is handed. This file is that customer, built by real Git and measured
 * through production code.
 *
 * What is proven here is Stage 5's creation and reuse decision plus Stage 7's patch
 * identity, because those two are the ones whose *contract with the customer* changes with
 * the topology. Stage 9's per-file diff and Stage 11's observation are not driven separately:
 * they resolve the same `resolveTrustedGitDir` gate (S16-2, S16-6, S16-7, S16-8 all call it),
 * and this file shows that gate returns the parent clone's registration for this layout — the
 * one fact those two other reads depend on.
 */

const RUN_ID = 'run-20260924T202442Z-306f6e';
const gitAvailable = await hasGit();
const created: string[] = [];

afterAll(async () => {
  for (const dir of created.splice(0, created.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * A parent clone plus a sibling checkout of it, both real.
 *
 * The sibling is placed in its own temporary root rather than inside the parent, because
 * that is the shape a person actually chooses (`git worktree add ../review feature`) and
 * putting it inside the parent would make the parent's `git status` report it, which is a
 * fact about the fixture rather than about Stage 5.
 */
async function customerWorktree(): Promise<CustomerTree> {
  const { dir, base } = await initRepository({
    'README.md': '# datekit\n',
    'src/parse.ts':
      'export function parseDate(input: string): Date {\n  return new Date(input);\n}\n',
  });
  created.push(dir);
  const parent = await realpath(dir);

  const root = await makeFixtureTree({});
  created.push(root);
  const sibling = path.join(root, 'review');
  const added = await defaultRunner('git', [
    '-C',
    parent,
    'worktree',
    'add',
    '-q',
    '--detach',
    sibling,
    base,
  ]);
  if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
  return { parent, sibling: await realpath(sibling), baseSha: base };
}

interface CustomerTree {
  readonly parent: string;
  readonly sibling: string;
  readonly baseSha: string;
}

/** The administrative directory real Git gave this checkout — read from Git, not guessed. */
async function adminDirOf(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'rev-parse', '--absolute-git-dir']);
  if (result.code !== 0) throw new Error(`git rev-parse failed: ${result.stderr}`);
  return await realpath(result.stdout.trim());
}

/**
 * A workspace's `.git` pointer rewritten to aim somewhere else.
 *
 * Written as Git writes it — a `gitdir:` line with forward slashes, which is what Git
 * stores on Windows too. Deleted before being created because writing over a Git pointer
 * file in place is `EPERM` on this platform.
 */
async function forgePointer(workspace: string, target: string): Promise<void> {
  const pointer = `gitdir: ${target.replace(/\\/g, '/')}\n`;
  const file = path.join(workspace, '.git');
  await rm(file, { force: true });
  await writeFile(file, pointer, 'utf8');
}

describe('a run workspace inside a customer checkout that is itself a linked worktree', () => {
  it.skipIf(!gitAvailable)(
    'prepares, reuses and measures it through the parent clone metadata',
    async () => {
      const { parent, sibling, baseSha } = await customerWorktree();

      const prepared = await prepareWorkspace({ primaryRoot: sibling, runId: RUN_ID, baseSha });

      expect(prepared.reused).toBe(false);
      expect(isSamePath(prepared.path, path.join(sibling, WORKTREE_BASE_DIR, RUN_ID))).toBe(true);
      expect(prepared.relativePath).toBe(`${WORKTREE_BASE_DIR}/${RUN_ID}`);
      expect(prepared.branch).toBe(`mergesutra/${RUN_ID}`);
      // `local.toplevel` plus `relativePath` is exactly how Stage 11 re-derives this
      // directory (`src/lifecycle/observe.ts`), so the pair has to name the customer's
      // checkout and the path inside it — not the parent clone the metadata lives in.
      expect(isSamePath(prepared.toplevel, sibling)).toBe(true);
      expect(existsSync(path.join(prepared.path, 'src', 'parse.ts'))).toBe(true);
      expect(await headOf(prepared.path)).toBe(baseSha);
      // The customer's own checkout is untouched by creating a workspace inside it.
      expect(await statusOf(sibling)).toBe('');

      // The measurement reads the parent clone — two levels above anything the run owns —
      // and nothing inside the workspace. In a plain clone this registration would sit at
      // `<repo>/.git/worktrees`; here it is the *parent's*, which is why a run that could
      // write anywhere in its own workspace or the customer's checkout cannot reach it.
      const measured = await resolveTrustedGitDir(prepared.path);
      expect(measured).not.toBeNull();
      expect(isSamePath(measured!.workTree, prepared.path)).toBe(true);
      expect(isInsideRoot(prepared.path, measured!.gitDir)).toBe(false);
      expect(
        isSamePath(path.dirname(measured!.gitDir), path.join(parent, '.git', 'worktrees')),
      ).toBe(true);

      const clean = await describePatch({ workspace: prepared.path, baseSha });
      expect(clean.files).toEqual([]);

      await writeFile(
        path.join(prepared.path, 'src', 'parse.ts'),
        'export function parseDate(input: string): Date {\n  return new Date(input + "Z");\n}\n',
        'utf8',
      );
      await writeFile(path.join(prepared.path, 'src', 'extra.ts'), 'export const y = 2;\n', 'utf8');

      const changed = await describePatch({ workspace: prepared.path, baseSha });
      expect(changed.identity).not.toBe(clean.identity);
      expect(changed.files.map((file) => file.path).sort()).toEqual([
        'src/extra.ts',
        'src/parse.ts',
      ]);
      // Writing in the workspace never reaches the customer's checkout or the parent.
      expect(await statusOf(sibling)).toBe('');
      expect(await statusOf(parent)).toBe('');

      const again = await prepareWorkspace({ primaryRoot: sibling, runId: RUN_ID, baseSha });
      expect(again.reused).toBe(true);
      expect(isSamePath(again.path, prepared.path)).toBe(true);
    },
    120_000,
  );

  it.skipIf(!gitAvailable)(
    'refuses a workspace forged onto the customer checkout own registration, which really is at the base',
    async () => {
      const { sibling, baseSha } = await customerWorktree();
      const prepared = await prepareWorkspace({ primaryRoot: sibling, runId: RUN_ID, baseSha });
      const customerAdmin = await adminDirOf(sibling);

      await forgePointer(prepared.path, customerAdmin);

      // The plant is live: a discovering read of the forged workspace answers with the
      // customer checkout's own HEAD, which is the recorded base. That is the answer Stage
      // 5 used to accept as a reuse.
      const discovered = await defaultRunner('git', [
        '-C',
        prepared.path,
        'rev-parse',
        '--verify',
        'HEAD',
      ]);
      expect(discovered.stdout.trim().toLowerCase()).toBe(baseSha);

      // ... and it is still not measurable, because the admin directory's back-pointer
      // names the customer's `.git`, not this workspace's.
      expect(await resolveTrustedGitDir(prepared.path)).toBeNull();
      await expect(
        prepareWorkspace({ primaryRoot: sibling, runId: RUN_ID, baseSha }),
      ).rejects.toThrow(/cannot name Git metadata for it that the run could not have written/);
      await expect(describePatch({ workspace: prepared.path, baseSha })).rejects.toThrow(
        /no Git metadata a run could not have written/,
      );
      expect(await readFile(path.join(prepared.path, '.git'), 'utf8')).toContain(
        customerAdmin.replace(/\\/g, '/'),
      );
      // The customer checkout itself is honest metadata, and stays measurable.
      expect(await resolveTrustedGitDir(sibling)).not.toBeNull();
    },
    120_000,
  );
});

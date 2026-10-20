import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { prepareWorkspace } from '../../src/git/workspace.js';
import { resolveTrustedGitDir } from '../../src/git/workspace-git-dir.js';
import { isInsideRoot } from '../../src/security/path-safety.js';
import { hasGit, initRepository } from '../helpers/git.js';
import { CAN_SYMLINK, makeLink } from '../helpers/fixture.js';

/**
 * Which Git directory a run's workspace may be measured through.
 *
 * Stage 5 hands each run a *linked* worktree, so the workspace's `.git` is a
 * pointer file and its metadata (HEAD, index, config) lives in the primary
 * repository — outside the directory the run is allowed to write in. That
 * arrangement is the only reason MergeSutra's trusted host-side Git read has
 * anything to trust: if the workspace's own `.git` bytes were consulted instead,
 * a run could plant configuration that names programs to execute, because Git
 * configuration does exactly that (`core.fsmonitor`, `core.hooksPath`,
 * `diff.<driver>.textconv`, `ext::` remotes).
 *
 * These tests therefore assert a refusal rule, not a parsing convenience: the Git
 * directory is trusted only when it is a pointer to a directory outside the
 * workspace that independently points back. Every way a workspace can fail that
 * description — a plain checkout, a planted `.git`, a pointer that stays inside,
 * a sibling run's metadata, a symlink — has to come back as `null`, because the
 * caller's only safe reading of `null` is "this workspace cannot be measured".
 */

const gitAvailable = await hasGit();
const created: string[] = [];

afterAll(async () => {
  for (const dir of created.splice(0, created.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** A committed repository plus the workspace Stage 5 actually created in it. */
async function stage5Workspace(
  runId = 'run-trusted-a',
): Promise<{ repo: string; workspace: string }> {
  const { dir } = await initRepository({ 'README.md': '# datekit\n' });
  created.push(dir);
  const workspace = await prepareWorkspace({
    primaryRoot: dir,
    runId,
    baseSha: await headOf(dir),
  });
  return { repo: dir, workspace: workspace.path };
}

async function headOf(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD']);
  return result.stdout.trim().toLowerCase();
}

async function pointerFile(workspace: string): Promise<string> {
  return await readFile(path.join(workspace, '.git'), 'utf8');
}

async function setPointer(workspace: string, target: string): Promise<void> {
  // Remove it first rather than overwriting: this is exactly what a run can do
  // to its own workspace, and the file it writes back has the workspace's
  // ordinary permissions instead of the ones Git gave the original.
  const pointer = path.join(workspace, '.git');
  await rm(pointer, { force: true });
  await writeFile(pointer, `gitdir: ${target}\n`, 'utf8');
}

describe('resolveTrustedGitDir: the arrangement Stage 5 creates', () => {
  it.skipIf(!gitAvailable)(
    'resolves a linked worktree to its own admin directory, outside the workspace',
    async () => {
      const { repo, workspace } = await stage5Workspace();
      const trusted = await resolveTrustedGitDir(workspace);

      expect(trusted).not.toBeNull();
      expect(trusted?.workTree).toBe(await realpath(workspace));
      // The primary repository's own admin directory for this worktree, and
      // outside the directory the run is allowed to write in.
      expect(trusted!.gitDir.replace(/[\\/]+/g, '/')).toMatch(/\/\.git\/worktrees\/[^/]+$/i);
      expect(isInsideRoot(trusted!.workTree, trusted!.gitDir)).toBe(false);

      // The point of returning it is that MergeSutra can read the run through
      // this directory: the base commit is there, and so is the working tree.
      expect((await readFile(path.join(trusted!.gitDir, 'HEAD'), 'utf8')).trim()).not.toBe('');
      expect(await headOf(workspace)).toBe(await headOf(repo));

      await writeFile(path.join(workspace, 'new-file.ts'), 'export const x = 1;\n', 'utf8');
      const viaFlags = await defaultRunner('git', [
        '--git-dir',
        trusted!.gitDir,
        '--work-tree',
        trusted!.workTree,
        'status',
        '--porcelain',
      ]);
      expect(viaFlags.code).toBe(0);
      expect(viaFlags.stdout).toContain('new-file.ts');
    },
    60_000,
  );
});

describe('resolveTrustedGitDir: what it refuses', () => {
  it.skipIf(!gitAvailable)(
    'refuses a plain checkout, whose metadata sits inside the writable area',
    async () => {
      const { dir } = await initRepository({ 'README.md': '# datekit\n' });
      created.push(dir);
      expect(await resolveTrustedGitDir(dir)).toBeNull();
    },
    60_000,
  );

  it.skipIf(!gitAvailable)(
    'refuses a workspace whose pointer file was replaced by a .git directory',
    async () => {
      // The S16-1 attack: a run writes its own repository into the directory it
      // controls, with configuration that names a program. If this resolved, the
      // trusted read would run whatever that directory says.
      const { workspace } = await stage5Workspace();
      const sentinel = path.join(workspace, '..', 'HOST-PWNED');
      await rm(path.join(workspace, '.git'), { force: true });
      await mkdir(path.join(workspace, '.git', 'worktrees', 'x'), { recursive: true });
      await writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(
        path.join(workspace, '.git', 'config'),
        '[core]\n\tfsmonitor = "touch HOST-PWNED"\n',
        'utf8',
      );

      expect(await resolveTrustedGitDir(workspace)).toBeNull();
      expect(existsSync(sentinel)).toBe(false);
    },
    60_000,
  );

  it.skipIf(!gitAvailable)(
    'refuses a pointer that stays inside the workspace',
    async () => {
      // A complete, self-consistent repository assembled inside the directory the
      // run can write: its back-pointer names this workspace's `.git`, and its
      // common dir is the real one, outside the workspace. Every structural test
      // passes except one — the metadata is inside the writable area, which is
      // where the run gets to decide what Git configuration MergeSutra reads.
      const { repo, workspace } = await stage5Workspace();
      const admin = path.join(workspace, 'planted', 'admin');
      await mkdir(admin, { recursive: true });
      await writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(path.join(admin, 'gitdir'), path.join(workspace, '.git') + '\n', 'utf8');
      await writeFile(path.join(admin, 'commondir'), path.join(repo, '.git') + '\n', 'utf8');
      await setPointer(workspace, admin);

      expect(await resolveTrustedGitDir(workspace)).toBeNull();
    },
    60_000,
  );

  it.skipIf(!gitAvailable)(
    "refuses a pointer aimed at another run's metadata",
    async () => {
      // Both worktrees are legitimate; the deception is measuring run b's HEAD
      // and index while claiming the bytes came from run a.
      const { workspace: sibling } = await stage5Workspace('run-trusted-sibling');
      const { workspace } = await stage5Workspace();
      const siblingGitDir = (await pointerFile(sibling)).trim().replace(/^gitdir:\s*/, '');

      await setPointer(workspace, siblingGitDir);
      expect(await resolveTrustedGitDir(workspace)).toBeNull();
    },
    60_000,
  );

  it.skipIf(!gitAvailable)(
    'refuses a pointer whose target has no worktree metadata to measure',
    async () => {
      const { repo } = await stage5Workspace();
      const { workspace } = await stage5Workspace('run-trusted-dangling');
      const rogue = path.join(repo, '.git', 'worktrees', 'not-a-worktree');
      await mkdir(rogue, { recursive: true });
      await setPointer(workspace, rogue);
      expect(await resolveTrustedGitDir(workspace)).toBeNull();
    },
    60_000,
  );

  it.skipIf(!gitAvailable || !CAN_SYMLINK)(
    'refuses a .git that is a symlink, even to a real pointer file',
    async () => {
      const { workspace } = await stage5Workspace('run-trusted-symlink');
      const original = path.join(workspace, '.git');
      const moved = path.join(workspace, 'pointer-copy');
      await writeFile(moved, await pointerFile(workspace), 'utf8');
      await rm(original, { force: true });
      expect(await makeLink(moved, original, 'file')).toBe(true);
      expect(await resolveTrustedGitDir(workspace)).toBeNull();
    },
    60_000,
  );

  it('refuses a workspace that is not there at all', async () => {
    expect(
      await resolveTrustedGitDir(path.join(tmpdir(), 'mergesutra-no-such-workspace')),
    ).toBeNull();
  });
});

describe('resolveTrustedGitDir: the pointer forms Git itself writes', () => {
  it.skipIf(!gitAvailable)(
    'resolves a relative gitdir pointer against the workspace',
    async () => {
      const { workspace } = await stage5Workspace('run-trusted-relative');
      const admin = (await pointerFile(workspace)).trim().replace(/^gitdir:\s*/, '');
      await setPointer(workspace, path.relative(workspace, admin));

      const trusted = await resolveTrustedGitDir(workspace);
      expect(trusted?.gitDir).toBe(await realpath(admin));
    },
    60_000,
  );
});

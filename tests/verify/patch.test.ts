import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { defaultRunner, type Runner } from '../../src/core/runner.js';
import { prepareWorkspace } from '../../src/git/workspace.js';
import { resolveTrustedGitDir } from '../../src/git/workspace-git-dir.js';
import { sha256Hex } from '../../src/security/digest.js';
import { describePatch, stalenessOf, type PatchDescription } from '../../src/verify/patch.js';
import { makeLink } from '../helpers/fixture.js';
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
let worktreeCount = 0;

/**
 * The workspace a run really has: Stage 5's linked worktree, inside a repository
 * of these files.
 *
 * `dir` is that workspace and `repo` is the human's checkout standing next to it.
 * Measuring anything else would be measuring a shape production never measures —
 * a plain checkout has no Git metadata outside itself, which is exactly the fact
 * the tests below are about.
 */
async function makeRepo(
  files: Record<string, string>,
): Promise<{ dir: string; repo: string; base: string }> {
  const repo = await initRepository(files);
  made.push(repo.dir);
  worktreeCount += 1;
  const prepared = await prepareWorkspace({
    primaryRoot: repo.dir,
    runId: `run-patch-${worktreeCount}`,
    baseSha: repo.base,
  });
  return { dir: prepared.path, repo: repo.dir, base: prepared.baseSha };
}

/** A plain checkout: a directory whose own bytes are its repository. */
async function makeCheckout(files: Record<string, string>): Promise<{ dir: string; base: string }> {
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
      executable: false,
    });

    await put(dir, 'src/a.ts', 'fixed differently\n');
    const rewritten = await describePatch({ workspace: dir, baseSha: base });
    expect(rewritten.identity).not.toBe(patch.identity);
  });

  it('binds the executable bit into the identity, because a commit carries it', async () => {
    const { dir, base } = await makeRepo({ 'scripts/run.sh': 'echo one\n' });
    await put(dir, 'scripts/run.sh', 'echo two\n');
    const plain = await describePatch({ workspace: dir, baseSha: base });
    expect(plain.files[0]?.executable).toBe(false);

    // The index is where Git keeps the mode the next commit would carry, and it
    // is the only place that mode can be written on a checkout whose filesystem
    // has no executable bit (Windows). So this witness is not a POSIX story: it
    // measures the same fact a POSIX `chmod` would change.
    const marked = await defaultRunner('git', [
      '-C',
      dir,
      'update-index',
      '--chmod=+x',
      'scripts/run.sh',
    ]);
    expect(marked.code).toBe(0);

    const executable = await describePatch({ workspace: dir, baseSha: base });

    expect(executable.files[0]?.executable).toBe(true);
    expect(executable.files[0]?.contentSha256).toBe(plain.files[0]?.contentSha256);
    expect(executable.identity).not.toBe(plain.identity);
  });

  it.skipIf(process.platform === 'win32')(
    'counts an untracked script’s executable bit, which Git would add as 100755',
    async () => {
      const { dir, base } = await makeRepo({ 'src/a.ts': 'a\n' });
      await put(dir, 'bin/tool.sh', '#!/bin/sh\necho hi\n');
      const plain = await describePatch({ workspace: dir, baseSha: base });
      expect(plain.files[0]?.executable).toBe(false);

      await chmod(path.join(dir, 'bin/tool.sh'), 0o755);
      const executable = await describePatch({ workspace: dir, baseSha: base });

      expect(executable.files[0]?.executable).toBe(true);
      expect(executable.identity).not.toBe(plain.identity);
    },
  );

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
      executable: false,
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
        executable: false,
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
    // The ignore rule reaches only the primary's own root, so a `.mergesutra/`
    // directory inside this workspace is un-ignored and would be listed by
    // `git ls-files --others`: one run's evidence must not become another run's
    // patch, whatever the repository's rules happen to be.
    const { dir, base } = await makeRepo({
      'src/a.ts': 'a\n',
      '.gitignore': 'node_modules/\n/.mergesutra/\n',
    });
    await put(dir, 'src/a.ts', 'fixed\n');
    const before = await describePatch({ workspace: dir, baseSha: base });

    await put(dir, '.mergesutra/worktrees/other-run/src/a.ts', 'a\n');
    await put(dir, '.mergesutra/runs/run-1/record.json', '{}\n');
    const after = await describePatch({ workspace: dir, baseSha: base });

    expect(paths(after)).toEqual(['src/a.ts']);
    expect(after.identity).toBe(before.identity);
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

/**
 * Measuring only through Git metadata a run could not have written.
 *
 * Stage 5 hands a run a worktree whose `.git` entry is a pointer into the primary
 * repository, and every byte of that directory — the pointer included — is
 * something the run may rewrite, since a gate is repository code running there.
 * Git's own discovery starts from that entry and then reads whatever configuration
 * it leads to, and configuration names programs. So the trusted host-side read of
 * the patch may not ask Git to discover the repository from the directory under
 * review: it has to be given the one metadata directory the run cannot author.
 */
describe.skipIf(!AVAILABLE)(
  'measuring a worktree only through metadata the run could not write',
  () => {
    /** The workspace Stage 5 made, plus the metadata directory it points at. */
    async function makeWorktree(files: Record<string, string>) {
      const { dir: workspace, repo, base } = await makeRepo(files);
      const trusted = await resolveTrustedGitDir(workspace);
      if (trusted === null) throw new Error('the fixture must create a measurable worktree');
      return { workspace, repo, base, gitDir: trusted.gitDir, workTree: trusted.workTree };
    }

    /**
     * A complete second repository, standing inside the workspace.
     *
     * `.git` stays a pointer file — the shape a check for "is it a file" would wave
     * through — but it leads to a gitdir the run wrote, with a HEAD of its own and a
     * `core.fsmonitor` naming a script. That key is not a flourish: it is one of the
     * documented ways Git configuration names a program to run, and it is consulted
     * during repository setup, before any listing command. Whether that program is
     * *reached* depends on how this host quotes the path — measured on Windows, the
     * hook spawns when the fixture's path contains no space and does not when it
     * does, which is why a hosted runner's checkout behaves differently from a temp
     * directory under a profile name with one. The plant's own setup call is
     * therefore capable of creating the sentinel before MergeSutra is asked anything,
     * so the test below clears it after planting and asserts on what the refusal does
     * from that point. What is always true, and what the refusal is for, is that a
     * read which discovers the repository obeys the repository the run chose.
     */
    async function plantRepositoryInside(workspace: string, sentinel: string): Promise<string> {
      const crafted = path.join(workspace, 'planted-gitdir');
      await mkdir(path.join(crafted, 'objects'), { recursive: true });
      await mkdir(path.join(crafted, 'refs'), { recursive: true });
      await writeFile(path.join(crafted, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      const hook = path.join(crafted, 'hook.sh').replace(/\\/g, '/');
      await writeFile(
        path.join(crafted, 'config'),
        `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${hook}\n`,
        'utf8',
      );
      await writeFile(
        path.join(crafted, 'hook.sh'),
        `#!/bin/sh\ntouch "${sentinel.replace(/\\/g, '/')}"\necho unsupported-v2\n`,
        'utf8',
      );
      const commit = await defaultRunner('git', [
        '--git-dir',
        crafted,
        '--work-tree',
        workspace,
        '-c',
        'user.name=planted',
        '-c',
        'user.email=planted@invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'planted',
      ]);
      if (commit.code !== 0) throw new Error(`planting failed: ${commit.stderr}`);
      // Delete-then-create, because that is what a run can do: the file it writes
      // back carries the workspace's ordinary permissions.
      await rm(path.join(workspace, '.git'), { force: true });
      await writeFile(
        path.join(workspace, '.git'),
        `gitdir: ${crafted.replace(/\\/g, '/')}\n`,
        'utf8',
      );
      const head = await defaultRunner('git', ['--git-dir', crafted, 'rev-parse', 'HEAD']);
      if (head.code !== 0) throw new Error(`planted HEAD is unreadable: ${head.stderr}`);
      return head.stdout.trim();
    }

    it('asks Git through the metadata directory instead of the workspace it is measuring', async () => {
      const { workspace, base, gitDir, workTree } = await makeWorktree({ 'src/a.ts': 'a\n' });
      await put(workspace, 'src/a.ts', 'fixed\n');
      const argv: string[][] = [];
      const record: Runner = async (file, args) => {
        const result = await defaultRunner(file, args);
        argv.push([file, ...args]);
        return result;
      };

      const patch = await describePatch({ workspace, baseSha: base }, { run: record });

      expect(paths(patch)).toEqual(['src/a.ts']);
      expect(argv.length).toBeGreaterThan(0);
      for (const call of argv) {
        expect(call.slice(0, 6)).toEqual([
          'git',
          '--git-dir',
          gitDir,
          '--work-tree',
          workTree,
          '--no-optional-locks',
        ]);
        expect(call).not.toContain('-C');
      }
    });

    it('refuses a tracked file whose directory a gate replaced with a link out of the workspace', async () => {
      // A gate runs with the workspace mounted writable, so it can leave a junction
      // where a tracked directory used to be. Git follows it, which makes the host
      // read a file the run never owned — and the digest of it would be recorded as
      // that file's content in the patch a reviewer and a publisher both trust.
      const { workspace, base, gitDir, workTree } = await makeWorktree({
        'config/credentials': 'placeholder\n',
      });
      const outside = await mkdtemp(path.join(tmpdir(), 'mergesutra-patch-outside-'));
      made.push(outside);
      const hostSecret = 'HOST-SECRET-DO-NOT-HASH\n';
      await writeFile(path.join(outside, 'credentials'), hostSecret, 'utf8');
      await rm(path.join(workspace, 'config'), { recursive: true, force: true });
      const linked = await makeLink(outside, path.join(workspace, 'config'), 'directory');
      expect(linked, 'this host can create a directory link or junction').toBe(true);

      // The control: Git itself follows the link, so the refusal below is about
      // where the bytes came from and not about Git failing to see the change.
      const followed = await defaultRunner('git', [
        '--git-dir',
        gitDir,
        '--work-tree',
        workTree,
        '--no-optional-locks',
        'diff',
        '--no-ext-diff',
        '--no-renames',
        base,
        '--',
        'config/credentials',
      ]);
      expect(followed.stdout).toContain('HOST-SECRET-DO-NOT-HASH');

      const failure = await describePatch({ workspace, baseSha: base }).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(AppError);
      expect((failure as Error).message).toMatch(/link or junction|outside the workspace/i);
      expect((failure as Error).message).not.toContain('HOST-SECRET-DO-NOT-HASH');
      expect(JSON.stringify(failure)).not.toContain(sha256Hex(hostSecret));
      expect(JSON.stringify(failure)).not.toContain(hostSecret.trim());
    });

    it('refuses a plain checkout rather than discovering the repository from its own bytes', async () => {
      const { dir, base } = await makeCheckout({ 'src/a.ts': 'a\n' });
      await put(dir, 'src/a.ts', 'fixed\n');

      await expect(describePatch({ workspace: dir, baseSha: base })).rejects.toThrow(
        /metadata|trust|measure/i,
      );
    });

    it('refuses a workspace that points at Git metadata inside itself', async () => {
      const { workspace, repo, base } = await makeWorktree({ 'src/a.ts': 'a\n' });
      await put(workspace, 'src/a.ts', 'fixed\n');
      const sentinel = path.join(repo, 'HOST-PWNED');
      await plantRepositoryInside(workspace, sentinel);
      // The plant read the planted config to build itself, and on a host whose path
      // quoting lets the hook spawn that is enough to leave the sentinel behind.
      // Nothing may be concluded from that; what has to hold is that the refused
      // measurement adds no execution of its own.
      await rm(sentinel, { force: true });
      const asked: string[][] = [];
      const record: Runner = async (file, args) => {
        asked.push([file, ...args]);
        return defaultRunner(file, args);
      };

      await expect(describePatch({ workspace, baseSha: base }, { run: record })).rejects.toThrow(
        /metadata|trust|measure/i,
      );

      expect(asked).toEqual([]);
      expect(existsSync(sentinel)).toBe(false);
    });

    it('shows what that refusal is for: discovery from the same workspace obeys the planted repository', async () => {
      // The control. Same workspace, same workspace-authored metadata, and the argv
      // MergeSutra used until this was fixed — `git -C <workspace>` with Git left to
      // find the repository for itself. It finds, and reports, the repository the
      // run wrote, which is the fact the refusal above exists to prevent.
      const { workspace, repo, base } = await makeWorktree({ 'src/a.ts': 'a\n' });
      const planted = await plantRepositoryInside(workspace, path.join(repo, 'HOST-PWNED'));

      const discovered = await defaultRunner('git', ['-C', workspace, 'rev-parse', 'HEAD']);

      expect(discovered.code).toBe(0);
      expect(discovered.stdout.trim()).toBe(planted);
      expect(discovered.stdout.trim()).not.toBe(base);
    });
  },
);

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

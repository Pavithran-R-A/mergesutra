import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { defaultRunner, type Runner } from '../../src/core/runner.js';
import { prepareWorkspace, WORKTREE_BASE_DIR } from '../../src/git/workspace.js';
import { resolveTrustedGitDir } from '../../src/git/workspace-git-dir.js';
import { decideTool, risksOfGitArgv } from '../../src/process/tool-policy.js';
import { isInsideRoot, isSamePath } from '../../src/security/path-safety.js';
import { makeFixtureTree } from '../helpers/fixture.js';

/**
 * The workspace manager, tested against a scripted Git.
 *
 * What is worth asserting here is not that `git worktree add` was called with
 * plausible arguments, but the refusals: a run that could dirty the human's
 * checkout, reuse a stale workspace, or delete something it did not create is
 * the failure this stage exists to prevent. One test at the bottom runs real Git
 * so the script cannot be fiction.
 */

const REPO = await realpath(await makeFixtureTree({ 'README.md': '# datekit\n' }));
const BASE_SHA = '3f5a9c1d2b6e4a8f0c7d9e1a3b5c7d9e1a3b5c7d';
const OTHER_SHA = '1111111111222222222333333333444444444555';
const RUN_ID = 'run-20260924T202442Z-306f6e';
/** A second run of the same repository, so a plant can aim one workspace at the other. */
const SIBLING_RUN_ID = 'run-20260924T202443Z-306f6f';
const gitAvailable = await hasGit();
const scratch: string[] = [REPO];

afterAll(async () => {
  for (const dir of scratch.splice(0, scratch.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// The scripted tests now leave a workspace on disk, because Stage 5 reads one through
// its Git metadata. Each starts from the repository alone.
beforeEach(async () => {
  await rm(workspaceOfRun(), { recursive: true, force: true }).catch(() => undefined);
  await rm(path.join(REPO, '.git'), { recursive: true, force: true }).catch(() => undefined);
});

/** The workspace path Stage 5 would use inside this repository. */
const workspaceOfRun = (repo = REPO) => path.join(repo, WORKTREE_BASE_DIR, RUN_ID);

/**
 * The pointer-and-admin-directory pair real Git leaves for a linked worktree.
 *
 * Stage 5 now asks the workspace-commit question through a Git directory it resolved
 * *outside* the workspace (`src/git/workspace-git-dir.ts`, S16-8), so a scripted test
 * that wants that question answered has to write the metadata Git would have written —
 * the shape `tests/git/workspace-git-dir.test.ts` reads off real Git. The paths go in
 * forward-slash form because that is what Git puts in a pointer file, including on
 * Windows.
 */
async function plantLinkedWorktree(
  workspace: string,
  adminName = RUN_ID,
): Promise<{ gitDir: string; workTree: string }> {
  await mkdir(workspace, { recursive: true });
  const workTree = await realpath(workspace);
  // Where Git keeps a linked worktree's metadata: the primary repository, not the
  // workspace. `gitDir` is read back through realpath so it is spelled the way
  // Stage 5 will spell it.
  const admin = path.join(REPO, '.git', 'worktrees', adminName);
  await mkdir(admin, { recursive: true });
  const gitDir = await realpath(admin);
  await writeGitFile(path.join(workTree, '.git'), `gitdir: ${asGitPath(gitDir)}`);
  await writeGitFile(path.join(gitDir, 'gitdir'), asGitPath(path.join(workTree, '.git')));
  return { gitDir, workTree };
}

/** Git spells its pointer files with forward slashes, on every platform. */
const asGitPath = (value: string) => value.replace(/\\/g, '/');

/** Write one of Git's one-line metadata files: the value plus its trailing newline. */
async function writeGitFile(target: string, contents: string): Promise<void> {
  await writeFile(target, `${contents}\n`, 'utf8');
}

/**
 * Replace a workspace's `.git` entry with a pointer aimed somewhere else.
 *
 * This is the plant S16-8 is about: the entry lives inside the directory the run may
 * write, so the run can decide which repository Git discovers. It is written as a
 * delete followed by a create because that is the only way it works on this host —
 * an in-place write of a Git-created pointer file is refused with EPERM.
 */
async function forgePointer(workspace: string, aimedAt: string): Promise<void> {
  const pointer = path.join(workspace, '.git');
  await rm(pointer, { recursive: true, force: true });
  await writeGitFile(pointer, `gitdir: ${asGitPath(aimedAt)}`);
}

/**
 * A workspace whose Git metadata sits *inside* it — a plain checkout, which is what
 * a run that rewrote its own `.git` entry leaves behind.
 *
 * Its `HEAD` names the base on purpose: discovery would answer the reuse question
 * with the polite yes, and the point of S16-8 is that MergeSutra no longer asks.
 */
async function plantPlainCheckout(workspace: string): Promise<void> {
  const dotGit = path.join(workspace, '.git');
  await mkdir(dotGit, { recursive: true });
  await writeFile(path.join(dotGit, 'HEAD'), `${BASE_SHA}\n`, 'utf8');
}

interface Script {
  readonly run: Runner;
  readonly calls: readonly string[][];
}

/**
 * Answer git calls by the first pattern that appears in the argv.
 *
 * Patterns are matched in insertion order, so specific verbs are listed before
 * the generic `rev-parse` ones.
 */
function scriptedGit(responses: Record<string, string | ScriptResponse>): Script {
  const calls: string[][] = [];
  const run: Runner = async (file, args) => {
    const argv = [file, ...args];
    calls.push(argv);
    const joined = argv.join(' ');
    const key = Object.keys(responses).find((pattern) => joined.includes(pattern));
    const response = key === undefined ? undefined : responses[key];
    const result =
      response === undefined ? { code: 0, stdout: '', stderr: '' } : normalize(response, joined);
    // A successful `worktree add` is the one scripted command with a side effect on
    // this disk, because Stage 5 measures what it created. `creates: 'checkout'` says
    // Git produced something that is not a linked worktree.
    if (result.code === 0 && /\bworktree add\b/.test(joined)) {
      const where = workspaceArgument(argv);
      if (response !== undefined && typeof response === 'object' && response.creates === 'checkout')
        await plantPlainCheckout(where);
      else await plantLinkedWorktree(where);
    }
    return result;
  };
  return { run, calls };
}

/** The directory `git worktree add -b <branch> <path> <sha>` was told to create. */
function workspaceArgument(argv: readonly string[]): string {
  const value = argv[argv.indexOf('add') + 3];
  if (!value) throw new Error('the scripted worktree add carried no workspace path');
  return value;
}

interface ScriptResponse {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** What a successful `worktree add` leaves on disk; linked unless said otherwise. */
  readonly creates?: 'linked' | 'checkout';
}

function normalize(response: string | ScriptResponse, argv: string) {
  const value = typeof response === 'string' ? { stdout: response } : response;
  return {
    code: value.code ?? 0,
    stdout: value.stdout ?? '',
    stderr: value.stderr ?? `scripted failure for: ${argv}`,
  };
}

function healthy(
  options: {
    workspaceExists?: boolean;
    headAt?: string;
    status?: string;
    ignored?: boolean;
    branchExists?: boolean;
  } = {},
) {
  const workspace = workspaceOfRun();
  const registered = options.workspaceExists === true ? `worktree ${workspace}\n` : '';
  return {
    'rev-parse --show-toplevel': REPO,
    'cat-file -t': 'commit',
    'check-ignore': { code: options.ignored === false ? 1 : 0, stdout: '' },
    'status --porcelain': options.status ?? '',
    'worktree list': `${registered}`,
    'rev-parse --verify HEAD': options.headAt ?? BASE_SHA,
    'refs/heads/': { code: options.branchExists === true ? 0 : 1, stdout: '' },
    'worktree add': { code: 0, stdout: `Preparing worktree (new branch) on ${workspace}` },
  } satisfies Record<string, string | ScriptResponse>;
}

const workspaceOf = (calls: readonly string[][]) =>
  calls.find((argv) => argv.includes('worktree') && argv.includes('add'));

describe('prepareWorkspace: refusals', () => {
  it('refuses a base SHA that is not a full commit hash, before asking Git anything', async () => {
    const script = scriptedGit({});
    await expect(
      prepareWorkspace({ primaryRoot: REPO, runId: RUN_ID, baseSha: 'main' }, { run: script.run }),
    ).rejects.toThrow(/full commit SHA/);
    expect(script.calls).toEqual([]);
  });

  it('refuses a run id that would escape the worktrees directory', async () => {
    const script = scriptedGit({});
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: '../escape', baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(AppError);
    expect(script.calls).toEqual([]);
  });

  it('refuses a directory that is not a Git working tree', async () => {
    const script = scriptedGit({
      'rev-parse --show-toplevel': { code: 128, stderr: 'not a git repo' },
    });
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/not a Git working tree/);
  });

  it('refuses when the recorded base commit is not in this repository', async () => {
    const script = scriptedGit({
      'rev-parse --show-toplevel': REPO,
      'cat-file -t': { code: 128, stdout: '', stderr: 'fatal: not found' },
    });
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/not in this repository/);
    expect(workspaceOf(script.calls) ?? []).toEqual([]);
  });

  it('refuses to create a workspace that Git does not ignore, and creates nothing', async () => {
    const script = scriptedGit(healthy({ ignored: false }));
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/not git-ignored/);
    expect(workspaceOf(script.calls)).toBeUndefined();
  });

  it('refuses a workspace that exists at a different commit rather than resetting it', async () => {
    await plantLinkedWorktree(workspaceOfRun());
    const script = scriptedGit(healthy({ workspaceExists: true, headAt: OTHER_SHA }));
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/exists but is at/);
    expect(workspaceOf(script.calls)).toBeUndefined();
    expect(script.calls.join(' ')).not.toMatch(/reset|clean|checkout|remove|prune|stash/);
  });

  it('refuses a workspace it cannot measure rather than letting Git discover one', async () => {
    // The S16-8 reading: a workspace a previous run left behind is a directory whose
    // `.git` that run could rewrite, and its `HEAD` here says the base, so a
    // discovering read would answer "reuse it". Stage 5 asks nothing until it has a
    // Git directory from outside the workspace, so the answer cannot be authored.
    await plantPlainCheckout(workspaceOfRun());
    const script = scriptedGit(healthy({ workspaceExists: true }));

    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/cannot name Git metadata for it that the run could not have written/);

    expect(script.calls.join(' ')).not.toContain('rev-parse --verify HEAD');
    expect(workspaceOf(script.calls)).toBeUndefined();
  });

  it('refuses a reuse whose pointer was forged onto a sibling run’s registration at the base', async () => {
    // The shape S16-8 calls dangerous: two honestly registered worktrees of one
    // repository, both standing on the recorded base, and this workspace's `.git`
    // rewritten to name the *other* run's metadata. A discovering read answers the
    // base, so it would license a reuse — and the bytes that decided it are the run's
    // own. Stage 5 has to refuse before it asks anything of that metadata.
    const sibling = await plantLinkedWorktree(
      path.join(REPO, WORKTREE_BASE_DIR, SIBLING_RUN_ID),
      SIBLING_RUN_ID,
    );
    await writeFile(path.join(sibling.gitDir, 'HEAD'), `${BASE_SHA}\n`, 'utf8');
    const workspace = workspaceOfRun();
    await mkdir(workspace, { recursive: true });
    await forgePointer(workspace, sibling.gitDir);
    const script = scriptedGit(healthy({ workspaceExists: true }));

    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/cannot name Git metadata for it that the run could not have written/);

    // Nothing was asked of the forged metadata, and nothing was created.
    expect(script.calls.join(' ')).not.toContain('rev-parse --verify HEAD');
    expect(workspaceOf(script.calls)).toBeUndefined();
    // The sibling keeps the registration it was forged from: this is a refusal, not a
    // repair of the workspace, and the other run is still measurable through it.
    expect(await resolveTrustedGitDir(sibling.workTree)).not.toBeNull();
    expect(await readFile(path.join(sibling.gitDir, 'gitdir'), 'utf8')).toContain(
      asGitPath(sibling.workTree),
    );
  });

  it('refuses a branch that already exists and is not attached to a workspace', async () => {
    const script = scriptedGit(healthy({ branchExists: true }));
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/branch .* already exists/);
    expect(workspaceOf(script.calls)).toBeUndefined();
  });

  it('reports a git failure without inventing a workspace', async () => {
    const script = scriptedGit({
      ...healthy(),
      'worktree add': { code: 128, stdout: '', stderr: 'fatal: already registered' },
    });
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/could not create the workspace/);
  });

  it('refuses a workspace that came up at the wrong commit', async () => {
    const script = scriptedGit({
      ...healthy(),
      // The pre-existing HEAD read is only consulted when a workspace is
      // registered; after `add` the same script answers for the verification.
      'rev-parse --verify HEAD': OTHER_SHA,
    });
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/instead of the base/);
  });

  it('refuses a workspace Git created without metadata outside it', async () => {
    // Defensive half of the same rule, so it is a test and not prose: a `worktree add`
    // that produced a checkout with its own `.git` inside would hand every later read
    // of this workspace to whoever wrote that directory.
    const script = scriptedGit({
      ...healthy(),
      'worktree add': { code: 0, stdout: 'Preparing worktree', creates: 'checkout' },
    });
    await expect(
      prepareWorkspace(
        { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
        { run: script.run },
      ),
    ).rejects.toThrow(/without Git metadata outside the workspace/);
    expect(script.calls.join(' ')).not.toContain('rev-parse --verify HEAD');
  });
});

describe('prepareWorkspace: what it returns', () => {
  it('creates the workspace at the base SHA and reports where it is', async () => {
    const script = scriptedGit(healthy());
    const workspace = await prepareWorkspace(
      { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
      { run: script.run },
    );

    expect(workspace).toMatchObject({
      relativePath: `${WORKTREE_BASE_DIR}/${RUN_ID}`,
      branch: `mergesutra/${RUN_ID}`,
      baseSha: BASE_SHA,
      toplevel: REPO,
      reused: false,
      primaryDirty: false,
      dirtyCount: 0,
    });
    const add = workspaceOf(script.calls);
    expect(add).toBeDefined();
    expect(add?.slice(add.indexOf('worktree'))).toEqual([
      'worktree',
      'add',
      '-b',
      `mergesutra/${RUN_ID}`,
      workspace.path.replace(/\\/g, path.sep),
      BASE_SHA,
    ]);
  });

  it('reuses a workspace that is already at the base SHA instead of recreating it', async () => {
    await plantLinkedWorktree(workspaceOfRun());
    const script = scriptedGit(healthy({ workspaceExists: true }));
    const workspace = await prepareWorkspace(
      { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
      { run: script.run },
    );
    expect(workspace.reused).toBe(true);
    expect(workspace.path).toBe(workspaceOfRun());
    expect(workspaceOf(script.calls)).toBeUndefined();
  });

  it('asks the workspace-commit question through metadata the workspace did not author', async () => {
    const { gitDir } = await plantLinkedWorktree(workspaceOfRun());
    const script = scriptedGit(healthy({ workspaceExists: true }));
    await prepareWorkspace(
      { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
      { run: script.run },
    );

    // Exactly one HEAD read, and it names the pair rather than the directory: `-C
    // <workspace>` would let Git discover the repository from the pointer file the
    // workspace holds, which is the one byte of this layout a run may rewrite.
    const asked = script.calls.filter((argv) => argv.includes('HEAD'));
    expect(asked).toHaveLength(1);
    const [, flag, resolvedDir, pairFlag, workTree, locks, ...verb] = asked[0] ?? [];
    expect(flag).toBe('--git-dir');
    expect(pairFlag).toBe('--work-tree');
    expect(locks).toBe('--no-optional-locks');
    expect(verb).toEqual(['rev-parse', '--verify', 'HEAD']);
    expect(isSamePath(resolvedDir ?? '', gitDir)).toBe(true);
    expect(isSamePath(workTree ?? '', workspaceOfRun())).toBe(true);
    expect(isInsideRoot(workTree ?? '', resolvedDir ?? '')).toBe(false);
  });

  it('reports a dirty primary checkout as a fact and never touches it', async () => {
    const script = scriptedGit(healthy({ status: ' M src/a.ts\n?? notes.md\nD src/gone.ts\n' }));
    const workspace = await prepareWorkspace(
      { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
      { run: script.run },
    );
    expect(workspace).toMatchObject({ primaryDirty: true, dirtyCount: 3 });
    expect(workspace.dirtySample).toHaveLength(3);
    expect(script.calls.join(' ')).not.toMatch(/stash|clean|reset|restore/);
  });

  it('accepts an uppercase SHA and keeps the one it hands to Git lowercase', async () => {
    const script = scriptedGit(healthy());
    const workspace = await prepareWorkspace(
      { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA.toUpperCase() },
      { run: script.run },
    );
    expect(workspace.baseSha).toBe(BASE_SHA);
    expect(workspaceOf(script.calls)?.at(-1)).toBe(BASE_SHA);
  });

  it('agrees with the tool policy about the one command it issues', async () => {
    // If the policy ever says no, prepareWorkspace refuses rather than doing it
    // anyway; this pins both halves of that claim.
    const argv = ['git', '-C', REPO, 'worktree', 'add', '-b', 'b', REPO, BASE_SHA];
    expect(risksOfGitArgv(argv)).toBe('WRITE');
    expect(decideTool({ op: 'execute', argv, cwd: REPO }, { workspace: REPO }).allowed).toBe(true);
  });
});

describe('prepareWorkspace against real Git', () => {
  const created: string[] = [];
  afterAll(async () => {
    // A real repository with a real worktree in it is the heaviest thing this
    // suite creates, so it goes back out again even if a test failed midway.
    for (const repo of created.splice(0, created.length)) {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.skipIf(!gitAvailable)(
    'creates an isolated workspace at the base SHA and leaves the checkout alone',
    async () => {
      const repo = await realRepository(true);
      created.push(repo);
      const baseSha = await head(repo);

      const workspace = await prepareWorkspace({
        primaryRoot: repo,
        runId: RUN_ID,
        baseSha,
      });

      expect(existsSync(path.join(workspace.path, 'README.md'))).toBe(true);
      expect(await head(workspace.path)).toBe(baseSha);
      expect(await branchAt(workspace.path)).toBe(`mergesutra/${RUN_ID}`);
      expect(await porcelain(repo)).toBe('');

      // The run writes in its own directory; the user's checkout cannot see it.
      await writeFile(path.join(workspace.path, 'src-date.ts'), 'export const x = 1;\n', 'utf8');
      expect(await porcelain(repo)).toBe('');

      const again = await prepareWorkspace({ primaryRoot: repo, runId: RUN_ID, baseSha });
      expect(again.reused).toBe(true);
      expect(again.path).toBe(workspace.path);
    },
    60_000,
  );

  it.skipIf(!gitAvailable)(
    'refuses a real workspace forged onto a sibling registration that real Git answers at the base',
    async () => {
      // Everything here is Git's own work: two linked worktrees created by production
      // `prepareWorkspace` over a real repository, a pointer rewritten the way a run
      // could rewrite it, and the questions asked of real Git. The scripted reading
      // above cannot show that the plant is *live* — only real Git can answer what a
      // discovering read would have reported.
      const repo = await realRepository(true);
      created.push(repo);
      const baseSha = await head(repo);
      const first = await prepareWorkspace({ primaryRoot: repo, runId: RUN_ID, baseSha });
      const second = await prepareWorkspace({
        primaryRoot: repo,
        runId: SIBLING_RUN_ID,
        baseSha,
      });
      const siblingAdmin = path.join(await realpath(repo), '.git', 'worktrees', SIBLING_RUN_ID);

      await forgePointer(first.path, siblingAdmin);

      // The plant is live, and the answer it produces is the polite one: discovery from
      // the forged workspace now reads the sibling's metadata, and that metadata is at
      // the recorded base. Pre-S16-8 this was a reuse.
      const whichRepo = await defaultRunner('git', [
        '-C',
        first.path,
        'rev-parse',
        '--absolute-git-dir',
      ]);
      expect(whichRepo.code).toBe(0);
      expect(isSamePath(whichRepo.stdout.trim(), siblingAdmin)).toBe(true);
      const discoveredHead = await defaultRunner('git', [
        '-C',
        first.path,
        'rev-parse',
        '--verify',
        'HEAD',
      ]);
      expect(discoveredHead.stdout.trim().toLowerCase()).toBe(baseSha);

      // Stage 5, with every process it launches recorded.
      const asked: string[][] = [];
      const record: Runner = async (file, args) => {
        asked.push([file, ...args]);
        return defaultRunner(file, args);
      };
      await expect(
        prepareWorkspace({ primaryRoot: repo, runId: RUN_ID, baseSha }, { run: record }),
      ).rejects.toThrow(/cannot name Git metadata for it that the run could not have written/);

      // No Git process was aimed at the forged workspace, and none was given a Git
      // directory at all: whatever configuration the planted metadata names, this stage
      // never consulted it.
      expect(asked.length).toBeGreaterThan(0);
      for (const argv of asked) {
        expect(isSamePath(argv[argv.indexOf('-C') + 1] ?? '', first.path)).toBe(false);
        expect(argv).not.toContain('--git-dir');
      }
      // Nothing was created, and the plant was neither obeyed nor repaired.
      expect(asked.map((argv) => argv.join(' ')).join('\n')).not.toContain('worktree add');
      expect(await readFile(path.join(first.path, '.git'), 'utf8')).toContain(
        asGitPath(siblingAdmin),
      );
      // The sibling still holds its own registration — the refusal is aimed at this run.
      expect(await resolveTrustedGitDir(second.path)).not.toBeNull();
    },
    120_000,
  );

  it.skipIf(!gitAvailable)(
    'creates nothing at all when the directory is not ignored',
    async () => {
      const repo = await realRepository(false);
      created.push(repo);
      await expect(
        prepareWorkspace({ primaryRoot: repo, runId: RUN_ID, baseSha: await head(repo) }),
      ).rejects.toThrow(/not git-ignored/);
      expect(existsSync(path.join(repo, '.mergesutra'))).toBe(false);
      expect(await porcelain(repo)).toBe('');
    },
    60_000,
  );
});

async function hasGit(): Promise<boolean> {
  const result = await defaultRunner('git', ['--version']).catch(() => null);
  return result?.code === 0;
}

/** A throwaway repository with one commit, git-ignored `.mergesutra` or not. */
async function realRepository(ignored: boolean): Promise<string> {
  const repo = await makeFixtureTree({ 'README.md': '# datekit\n' });
  if (ignored) await writeFile(path.join(repo, '.gitignore'), '.mergesutra/\n', 'utf8');
  // Sealed against this machine: a temporary repository otherwise inherits the operator's
  // global `core.hooksPath`, and the `git commit` below would run their tooling inside a
  // test. The value is written into this repository's own config, never into the user's.
  const hooks = path.join(repo, '.no-hooks');
  await mkdir(hooks, { recursive: true });
  const steps: readonly (readonly string[])[] = [
    ['init', '-q'],
    ['config', 'user.name', 'MergeSutra Test'],
    ['config', 'user.email', 'test@mergesutra.invalid'],
    ['config', 'core.hooksPath', hooks],
    ['add', '.'],
    ['commit', '-q', '-m', 'base'],
  ];
  for (const args of steps) {
    const result = await defaultRunner('git', ['-C', repo, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return repo;
}

async function head(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'rev-parse', 'HEAD']);
  return result.stdout.trim().toLowerCase();
}

async function branchAt(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

async function porcelain(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'status', '--porcelain']);
  return result.stdout.trim();
}

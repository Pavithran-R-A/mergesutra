import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { defaultRunner, type Runner } from '../../src/core/runner.js';
import { prepareWorkspace, WORKTREE_BASE_DIR } from '../../src/git/workspace.js';
import { decideTool, risksOfGitArgv } from '../../src/process/tool-policy.js';
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

const REPO = path.resolve('C:/repos/datekit');
const BASE_SHA = '3f5a9c1d2b6e4a8f0c7d9e1a3b5c7d9e1a3b5c7d';
const OTHER_SHA = '1111111111222222222333333333444444444555';
const RUN_ID = 'run-20260924T202442Z-306f6e';
const gitAvailable = await hasGit();

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
    if (response === undefined) return { code: 0, stdout: '', stderr: '' };
    return normalize(response, joined);
  };
  return { run, calls };
}

interface ScriptResponse {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
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
  const workspace = path.join(REPO, '.mergesutra', 'worktrees', RUN_ID);
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
    const script = scriptedGit(healthy({ workspaceExists: true }));
    const workspace = await prepareWorkspace(
      { primaryRoot: REPO, runId: RUN_ID, baseSha: BASE_SHA },
      { run: script.run },
    );
    expect(workspace.reused).toBe(true);
    expect(workspace.path).toBe(path.join(REPO, '.mergesutra', 'worktrees', RUN_ID));
    expect(workspaceOf(script.calls)).toBeUndefined();
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
  const steps: readonly (readonly string[])[] = [
    ['init', '-q'],
    ['config', 'user.name', 'MergeSutra Test'],
    ['config', 'user.email', 'test@mergesutra.invalid'],
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

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  identityFromLocalSnapshot,
  inspectLocalRepository,
  originMatches,
  parseRepositoryUrl,
} from '../../src/intake/local-repo.js';
import { GIT_MAIN_SHA, cleanCloneTable, fail, ok, scriptedRunner } from '../helpers/github.js';

// `inspectLocalRepository` confirms the directory exists before it spawns
// anything, so the tests point it at a directory that is really there and stub
// git's *answers*. The clone path git reports is separate fake output.
const REPO_DIR = process.cwd();
const CLONE_DIR = '/repo/datekit';

/** Subcommands inspectLocalRepository is allowed to run. Anything else is a bug. */
const READ_ONLY_GIT = [
  'rev-parse',
  'status',
  'config',
  'symbolic-ref',
  '--version',
  'log',
  'describe',
  'ls-files',
  'show',
];

async function snapshot(table = cleanCloneTable()) {
  const scripted = scriptedRunner(table);
  const result = await inspectLocalRepository(REPO_DIR, { run: scripted.run });
  return { result, scripted };
}

describe('inspectLocalRepository', () => {
  it('reads identity, base commit and cleanliness from a clean clone', async () => {
    const { result } = await snapshot();
    expect(result).toMatchObject({
      toplevel: CLONE_DIR,
      branch: 'main',
      isDetachedHead: false,
      defaultBranch: 'main',
      isDirty: false,
      dirtyCount: 0,
      isLinkedWorktree: false,
      gitVersion: 'git version 2.55.0.windows.5',
    });
    expect(result.head).toEqual({
      sha: GIT_MAIN_SHA,
      shortSha: GIT_MAIN_SHA.slice(0, 10),
      source: 'local-git',
    });
    expect(result.origin).toEqual({ host: 'github.com', owner: 'projectbharat', repo: 'datekit' });
  });

  it('only ever asks Git read-only questions, always via -C', async () => {
    const { scripted } = await snapshot();
    expect(scripted.calls.length).toBeGreaterThan(5);
    for (const call of scripted.calls) {
      expect(call.file).toBe('git');
      expect(call.args[0]).toBe('-C');
      expect(call.args[1]).toBe(REPO_DIR);
      const sub = call.args[2] ?? '';
      expect(READ_ONLY_GIT, `git ${call.args.slice(2).join(' ')}`).toContain(sub);
      expect(call.args).not.toContain('--global');
      expect(call.args).not.toContain('push');
      expect(call.args).not.toContain('checkout');
    }
  });

  it('reports a dirty tree and bounds the sample', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => ` M src/file-${i}.ts`).join('\n');
    const { result } = await snapshot({
      ...cleanCloneTable(),
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('status') ? ok(lines + '\n') : dispatchBase(args),
    });
    expect(result.isDirty).toBe(true);
    expect(result.dirtyCount).toBe(25);
    expect(result.dirtySample).toHaveLength(10);
  });

  it('marks a detached HEAD instead of inventing a branch name', async () => {
    const { result } = await snapshot({
      ...cleanCloneTable(),
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('rev-parse --abbrev-ref')
          ? ok('HEAD\n')
          : dispatchBase(args),
    });
    expect(result.isDetachedHead).toBe(true);
    expect(result.branch).toBe('(detached)');
  });

  it('keeps going when there is no origin remote', async () => {
    const { result } = await snapshot({
      ...cleanCloneTable(),
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('config --get remote.origin.url')
          ? fail('error: no such remote')
          : dispatchBase(args),
    });
    expect(result.originUrl).toBe('');
    expect(result.origin).toBeNull();
    expect(result.head.sha).toBe(GIT_MAIN_SHA);
  });

  it('detects that the supplied path is itself a linked worktree', async () => {
    const { result } = await snapshot({
      ...cleanCloneTable('/clone/datekit-wt'),
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('rev-parse --path-format')
          ? ok('/clone/datekit/.git\n')
          : dispatchBase(args, '/clone/datekit-wt'),
    });
    expect(result.isLinkedWorktree).toBe(true);
  });

  it('refuses a directory that is not a Git working tree', async () => {
    const scripted = scriptedRunner({
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('rev-parse --is-inside-work-tree')
          ? fail('fatal: not a git repository', 128)
          : fail('fatal: not a git repository', 128),
    });
    const error = await inspectLocalRepository(REPO_DIR, { run: scripted.run }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toMatch(/not a git working tree/i);
  });

  it('refuses a bare repository with a reason a user can act on', async () => {
    const scripted = scriptedRunner({
      'git -C': (args) => {
        const sub = args.slice(2).join(' ');
        if (sub.startsWith('rev-parse --is-inside-work-tree')) return fail('fatal:', 128);
        if (sub.startsWith('rev-parse --is-bare-repository')) return ok('true\n');
        return fail('unexpected', 128);
      },
    });
    const error = await inspectLocalRepository(REPO_DIR, { run: scripted.run }).catch((e) => e);
    expect((error as AppError).message).toMatch(/bare/);
  });

  it('refuses a repository whose HEAD cannot be resolved', async () => {
    const scripted = scriptedRunner({
      ...cleanCloneTable(),
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('rev-parse HEAD')
          ? fail('fatal: ambiguous argument', 128)
          : dispatchBase(args),
    });
    const error = await inspectLocalRepository(REPO_DIR, { run: scripted.run }).catch((e) => e);
    expect((error as AppError).message).toMatch(/no resolvable HEAD commit/);
  });

  it('rejects a path that does not exist before running anything', async () => {
    const scripted = scriptedRunner({});
    const error = await inspectLocalRepository(path.resolve('/definitely/not/here-xyz'), {
      run: scripted.run,
    }).catch((e) => e);
    expect((error as AppError).message).toMatch(/no such directory/);
    expect(scripted.calls).toHaveLength(0);
  });

  it('rejects a NUL-bearing path', async () => {
    const scripted = scriptedRunner({});
    const error = await inspectLocalRepository('/repo\0escape', { run: scripted.run }).catch(
      (e) => e,
    );
    expect((error as AppError).message).toMatch(/NUL/);
    expect(scripted.calls).toHaveLength(0);
  });
});

function dispatchBase(args: readonly string[], toplevel = '/clone/datekit') {
  const table = cleanCloneTable(toplevel);
  const handler = table['git -C'];
  if (typeof handler === 'function') return handler(args);
  return fail('no base handler');
}

describe('parseRepositoryUrl', () => {
  it('reads https remotes with and without .git', () => {
    expect(parseRepositoryUrl('https://github.com/projectbharat/datekit.git')).toEqual({
      host: 'github.com',
      owner: 'projectbharat',
      repo: 'datekit',
    });
    expect(parseRepositoryUrl('https://github.com/a/b')).toEqual({
      host: 'github.com',
      owner: 'a',
      repo: 'b',
    });
  });

  it('reads scp-style ssh remotes', () => {
    expect(parseRepositoryUrl('git@github.com:projectbharat/datekit.git')).toEqual({
      host: 'github.com',
      owner: 'projectbharat',
      repo: 'datekit',
    });
  });

  it('keeps whatever host it is given', () => {
    expect(parseRepositoryUrl('ssh://git@git.corp.example/team/app.git')?.host).toBe(
      'git.corp.example',
    );
  });

  it('returns null instead of guessing', () => {
    for (const value of [
      '',
      '   ',
      'not a url',
      'https://github.com/a',
      'file:///tmp/x',
      'C:\\repos\\datekit',
    ]) {
      expect(parseRepositoryUrl(value), value).toBeNull();
    }
  });
});

describe('originMatches / identityFromLocalSnapshot', () => {
  it('compares case-insensitively the way GitHub does', async () => {
    const { result } = await snapshot();
    expect(
      originMatches(result, { host: 'github.com', owner: 'ProjectBharat', repo: 'DateKit' }),
    ).toBe(true);
    expect(originMatches(result, { host: 'github.com', owner: 'someone', repo: 'else' })).toBe(
      false,
    );
  });

  it('builds an identity that admits what a clone cannot prove', async () => {
    const { result } = await snapshot();
    const identity = identityFromLocalSnapshot(result);
    expect(identity).toMatchObject({
      fullName: 'projectbharat/datekit',
      defaultBranch: 'main',
      source: 'local-git',
      isFork: null,
      isArchived: null,
      isPrivate: null,
    });
  });

  it('refuses to build an identity without an origin or default branch', async () => {
    const { result } = await snapshot({
      ...cleanCloneTable(),
      'git -C': (args) =>
        args.slice(2).join(' ').startsWith('config --get remote.origin.url')
          ? fail('error: no such remote')
          : dispatchBase(args),
    });
    expect(identityFromLocalSnapshot(result)).toBeNull();
  });
});

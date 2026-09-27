import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_BRANCH_LENGTH,
  branchNameProblem,
  sourceBranchOf,
  targetOf,
} from '../../src/pr/branch.js';
import type {
  LocalSnapshotStored,
  RepositoryIdentityStored,
  RunRecord,
} from '../../src/state/run-record.js';
import { defaultRunner } from '../../src/core/runner.js';
import { hasGit } from '../helpers/git.js';

/**
 * Which two branch names a pull request would be about — Stage 10.
 *
 * §8 says a target may only come from Git metadata gathered by an earlier stage,
 * and §7 says a source name must be one Git accepts and a shell does not. Both
 * are worth proving against the real binary rather than against this module's own
 * opinion of what a ref name is, so the last block below asks `git
 * check-ref-format` whether it agrees, and skips itself on a machine with no Git.
 *
 * Nothing here creates, renames or pushes a branch: the names are proposals, and
 * the only thing Stage 10 does with them is hash them into a digest a human approves.
 */

const BASE_SHA = '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182';
const RUN_ID = 'run-20260925T000000Z-pack001';

function repo(defaultBranch: string): RepositoryIdentityStored {
  return {
    host: 'github.com',
    owner: 'projectbharat',
    repo: 'datekit',
    fullName: 'projectbharat/datekit',
    defaultBranch,
    isFork: null,
    isArchived: null,
    isPrivate: null,
    htmlUrl: 'https://github.com/projectbharat/datekit',
    description: '',
    source: 'github-api',
  };
}

function local(defaultBranch: string): LocalSnapshotStored {
  return {
    requestedPath: '/repo',
    toplevel: '/repo',
    branch: defaultBranch,
    isDetachedHead: false,
    head: baseRef(),
    originUrl: 'https://github.com/projectbharat/datekit.git',
    origin: { host: 'github.com', owner: 'projectbharat', repo: 'datekit' },
    defaultBranch,
    isDirty: false,
    dirtyCount: 0,
    dirtySample: [],
    isLinkedWorktree: false,
    gitVersion: 'git version 2.45.0',
  };
}

function baseRef(sha = BASE_SHA): NonNullable<RunRecord['base']> {
  return { sha, shortSha: sha.slice(0, 7), source: 'local-git' };
}

describe('naming the branch a pull request would open against', () => {
  it('takes the target from the repository identity an earlier stage recorded', () => {
    const target = targetOf({ repository: repo('main'), local: local('main'), base: baseRef() });

    expect(target.branch).toBe('main');
    expect(target.baseSha).toBe(BASE_SHA);
  });

  it('carries every field the approval has to be bound to, not just a branch', () => {
    const target = targetOf({ repository: repo('main'), local: local('main'), base: baseRef() });

    expect(target).toEqual({
      host: 'github.com',
      owner: 'projectbharat',
      repo: 'datekit',
      fullName: 'projectbharat/datekit',
      branch: 'main',
      baseSha: BASE_SHA,
    });
  });

  it('falls back to the checkout Git described, when no repository identity was fetched', () => {
    const target = targetOf({ repository: null, local: local('trunk'), base: baseRef() });

    expect(target.branch).toBe('trunk');
    expect(target.fullName).toBe('projectbharat/datekit');
  });

  it('refuses to guess a target when nothing recorded a default branch', () => {
    expect(() => targetOf({ repository: null, local: null, base: baseRef() })).toThrow(
      /default branch/i,
    );
  });

  it('refuses to choose a side when the two records disagree about the default branch', () => {
    expect(() =>
      targetOf({ repository: repo('main'), local: local('legacy'), base: baseRef() }),
    ).toThrow(/two different default branches/i);
  });

  it('refuses to name a target with no base commit to pin it to', () => {
    expect(() => targetOf({ repository: repo('main'), local: local('main'), base: null })).toThrow(
      /base commit/i,
    );
  });
});

describe('naming the branch the work came from', () => {
  it('reuses the workspace branch a run already has, rather than inventing a second name', () => {
    const source = sourceBranchOf({
      runId: RUN_ID,
      workspaceBranch: `mergesutra/${RUN_ID}`,
      targetBranch: 'main',
    });

    expect(source).toEqual({ name: `mergesutra/${RUN_ID}`, reused: true });
  });

  it('derives a name from the run id when no workspace was ever created', () => {
    const source = sourceBranchOf({ runId: RUN_ID, workspaceBranch: null, targetBranch: 'main' });

    expect(source).toEqual({ name: `mergesutra/${RUN_ID}`, reused: false });
  });

  it('derives the same name every time, so the digest a human approved stays comparable', () => {
    const once = sourceBranchOf({ runId: RUN_ID, workspaceBranch: null, targetBranch: 'main' });
    const twice = sourceBranchOf({ runId: RUN_ID, workspaceBranch: null, targetBranch: 'main' });

    expect(twice).toEqual(once);
  });

  it('never proposes the target as its own source', () => {
    expect(() =>
      sourceBranchOf({ runId: RUN_ID, workspaceBranch: 'main', targetBranch: 'main' }),
    ).toThrow(/target/i);
  });

  it('refuses to propose a name Git itself would refuse', () => {
    expect(() =>
      sourceBranchOf({ runId: RUN_ID, workspaceBranch: 'fix..date', targetBranch: 'main' }),
    ).toThrow(/\.\./);
  });

  it('refuses a name carrying shell syntax, even though Git would have accepted it', () => {
    expect(branchNameProblem('fix; rm -rf /')).not.toBeNull();
    expect(() =>
      sourceBranchOf({ runId: RUN_ID, workspaceBranch: 'fix && curl evil', targetBranch: 'main' }),
    ).toThrow(/shell/i);
  });

  it('refuses a name that reads as a full ref path instead of a branch', () => {
    expect(() =>
      sourceBranchOf({ runId: RUN_ID, workspaceBranch: 'refs/heads/main', targetBranch: 'trunk' }),
    ).toThrow(/refs\//i);
  });

  it('refuses an over-long name rather than truncating it into another run', () => {
    const long = `mergesutra/${'x'.repeat(MAX_SOURCE_BRANCH_LENGTH)}`;

    expect(() =>
      sourceBranchOf({ runId: RUN_ID, workspaceBranch: long, targetBranch: 'main' }),
    ).toThrow(/long/i);
  });
});

describe('the ref-safety rules', () => {
  it('names a problem with every shape Git refuses', () => {
    const refused = [
      '',
      'has space',
      'fix..date',
      '/leading',
      'trailing/',
      'a//b',
      'ends.',
      'work.lock',
      'a@{b}',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\\b',
      '-leading-dash',
      'a\tb',
      `a${String.fromCharCode(1)}b`,
      'x'.repeat(MAX_SOURCE_BRANCH_LENGTH + 1),
    ];

    for (const name of refused) {
      expect(branchNameProblem(name), name).toBeTypeOf('string');
    }
  });

  it('accepts the shapes a real branch has', () => {
    for (const name of [
      `mergesutra/${RUN_ID}`,
      'fix/parse-empty-date',
      'a_b-c.1',
      'issue-123/reject-empty',
    ]) {
      expect(branchNameProblem(name), name).toBeNull();
    }
  });
});

const GIT = await hasGit();

describe.skipIf(!GIT)('the ref-safety rules against real Git', () => {
  it('proposes only names Git itself accepts as a branch', async () => {
    const accepted = [
      `mergesutra/${RUN_ID}`,
      'fix/parse-empty-date',
      'a_b-c.1',
      'issue-123/reject-empty',
    ];
    const verdicts: string[] = [];
    for (const name of accepted) {
      expect(branchNameProblem(name), name).toBeNull();
      const result = await defaultRunner('git', ['check-ref-format', '--branch', name]);
      verdicts.push(`${name} -> ${result.code}`);
    }

    expect(verdicts.join('\n')).not.toMatch(/-> [1-9]/);
  });

  it('refuses every name the sample list really is refused by Git', async () => {
    const refused = ['has space', 'fix..date', 'trailing/', 'ends.', 'work.lock', 'a?b', 'a\\b'];
    const disagreements: string[] = [];
    for (const name of refused) {
      const result = await defaultRunner('git', ['check-ref-format', '--branch', name]);
      if (result.code === 0) disagreements.push(`${name} was accepted by Git`);
      expect(branchNameProblem(name), name).toBeTypeOf('string');
    }

    expect(disagreements).toEqual([]);
  });

  it('is stricter than Git where a shell would not be', async () => {
    const withShellSyntax = ['fix;echo', 'a|b', 'a&&b', 'a$b', 'a`b', 'a}b', 'a>b', 'a(b)'];
    const gitAccepts: string[] = [];
    for (const name of withShellSyntax) {
      const result = await defaultRunner('git', ['check-ref-format', '--branch', name]);
      if (result.code === 0) gitAccepts.push(name);
      expect(branchNameProblem(name), name).toBeTypeOf('string');
    }

    expect(gitAccepts).toEqual(withShellSyntax);
  });
});

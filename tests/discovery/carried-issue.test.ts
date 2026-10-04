import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runInspect } from '../../src/discovery/inspect.js';
import { runContractStage } from '../../src/cli/contract.js';
import { runIntake } from '../../src/intake/intake.js';
import { targetOf } from '../../src/pr/branch.js';
import { toIssueDocument } from '../../src/github/schemas.js';
import {
  GIT_MAIN_SHA,
  cleanCloneTable,
  fakeGitHub,
  memoryRunStore,
  scriptedRunner,
} from '../helpers/github.js';
import type { MemoryRunStore } from '../helpers/github.js';
import { makeFixtureTree, NODE_REPO_FILES } from '../helpers/fixture.js';
import { ACCEPTANCE_BODY } from '../helpers/plan.js';
import { issuePayload } from '../fixtures/github-payloads.js';
import type { RunRecord } from '../../src/state/run-record.js';
import type { RunStore } from '../../src/state/run-store.js';

/**
 * Stage 14 found this by doing what the README tells a person to do.
 *
 * `mergesutra issue <url> --repo <clone>` writes an intake run holding the issue and no
 * repository contract. `mergesutra inspect <clone>` then writes a *second* run holding the
 * repository contract and — because this file's subject was `issueRef: null, issue: null` in
 * `src/discovery/inspect.ts` — no issue. `mergesutra contract` reads one source run. Measured
 * against a real issue on a real repository, the documented chain therefore ended either with the
 * issue's five criteria and "Repository contract: this run never compiled one", or with the
 * repository's gates and "Issue text: no issue in this run" — and each screen advises the command
 * that produced the other half. The advice is a cycle: no sequence of the shipped verbs put both
 * facts in one run, which is what Stage 5 onward, and the pull-request page, read.
 *
 * The carry these tests demand is not a guess from a directory listing. It is admitted only when
 * the intake run's own record proves it describes *this* checkout at *this* commit: the GitHub
 * identity the clone's `origin` names, the issue belonging to that same owner/repo, and the pinned
 * base SHA equal to the commit being inspected now. Every case that cannot prove that expects the
 * old behaviour — no issue carried — and a run record that says which proof was missing.
 */

const NOW = () => new Date('2026-09-25T08:00:00.000Z');

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

type WithChecks = { readonly checks: readonly { name: string; status: string; detail: string }[] };

function named(result: WithChecks, name: string) {
  return result.checks.find((entry) => entry.name === name);
}

async function fixtureRoot(): Promise<string> {
  const root = await makeFixtureTree(NODE_REPO_FILES);
  tempDirs.push(root);
  return root;
}

/** A Stage 1 run for this clone, written by the real intake orchestrator. */
async function intakeAt(
  root: string,
  store: MemoryRunStore,
  options: { readonly at?: Date; readonly overrides?: Parameters<typeof cleanCloneTable>[1] } = {},
): Promise<RunRecord> {
  const result = await runIntake(
    { issueUrl: 'https://github.com/projectbharat/datekit/issues/123', repoPath: root },
    {
      // An issue that states its own acceptance list, so a contract built on the
      // carried record has an `issue` criterion to show for it. The shared
      // `issuePayload` body has no such list — see `src/contract/derive.ts`.
      github: fakeGitHub({
        issue: async () => toIssueDocument({ ...issuePayload, body: ACCEPTANCE_BODY }),
      }),
      run: scriptedRunner(cleanCloneTable(root, options.overrides ?? {})).run,
      store,
      now: () => options.at ?? NOW(),
      random: () => 0.4,
    },
  );
  return result.record;
}

/** A Stage 2 run for this clone, likewise produced by the real stage. */
async function inspectAt(
  root: string,
  store: MemoryRunStore,
  overrides: Parameters<typeof cleanCloneTable>[1] = {},
  at: Date = NOW(),
) {
  return runInspect(
    { repoPath: root },
    {
      run: scriptedRunner(cleanCloneTable(root, overrides)).run,
      store,
      now: () => at,
      random: () => 0.5,
    },
  );
}

/** Git answers that report a different commit, so a pinned base cannot be claimed. */
function otherCommit(root: string) {
  return {
    'git -C': (args: readonly string[]) => {
      const sub = args.slice(2).join(' ');
      if (sub.startsWith('rev-parse HEAD')) {
        return { code: 0, stdout: `${'9'.repeat(40)}\n`, stderr: '' };
      }
      const fallback = cleanCloneTable(root)['git -C'];
      if (typeof fallback === 'function') return fallback(args);
      throw new Error('cleanCloneTable no longer scripts `git -C`');
    },
  };
}

function originUrl(root: string, url: string | null) {
  return {
    'git -C': (args: readonly string[]) => {
      const sub = args.slice(2).join(' ');
      if (sub.startsWith('config --get remote.origin.url')) {
        return url === null
          ? { code: 1, stdout: '', stderr: 'error: No such remote ' }
          : { code: 0, stdout: `${url}\n`, stderr: '' };
      }
      const fallback = cleanCloneTable(root)['git -C'];
      if (typeof fallback === 'function') return fallback(args);
      throw new Error('cleanCloneTable no longer scripts `git -C`');
    },
  };
}

/**
 * Git answers for everything but the remote's HEAD symbolic ref.
 *
 * This is the shape a real clone has when it was made with `git init` and a
 * `git remote add` rather than `git clone` — the layout the Stage 14 fixture
 * repository happens to have. `identityFromLocalSnapshot` returns null for it,
 * because a repository identity it cannot complete is one it will not invent, so
 * the record ends up naming no default branch at all and Stage 10 refuses to
 * propose a target.
 */
function noOriginHead(root: string) {
  return {
    'git -C': (args: readonly string[]) => {
      const sub = args.slice(2).join(' ');
      if (sub.startsWith('symbolic-ref')) {
        return {
          code: 1,
          stdout: '',
          stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n',
        };
      }
      const fallback = cleanCloneTable(root)['git -C'];
      if (typeof fallback === 'function') return fallback(args);
      throw new Error('cleanCloneTable no longer scripts `git -C`');
    },
  };
}

/**
 * Both refusals at once: an `origin` naming another repository, and no remote HEAD.
 *
 * This is the combination that would let a wrong default branch slip through a
 * one-clause proof — the gap Git leaves is exactly the gap the carry fills, so the
 * only thing standing between a foreign repository's `main` and this run's pull
 * request is the identity comparison.
 */
function foreignOriginWithoutHead(root: string, url: string) {
  const withoutHead = noOriginHead(root)['git -C'];
  if (typeof withoutHead !== 'function') {
    throw new Error('noOriginHead no longer scripts `git -C`');
  }
  return {
    'git -C': (args: readonly string[]) => {
      const sub = args.slice(2).join(' ');
      if (sub.startsWith('config --get remote.origin.url')) {
        return { code: 0, stdout: `${url}\n`, stderr: '' };
      }
      return withoutHead(args);
    },
  };
}

describe('inspect carries the issue intake already established', () => {
  it('puts the intake run of this checkout into the inspect record', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(root, store);

    expect(inspected.record.issueRef).toEqual(intake.issueRef);
    expect(inspected.record.issue).toEqual(intake.issue);
    expect(named(inspected, 'Issue from intake')?.status).toBe('PASS');
    expect(named(inspected, 'Issue from intake')?.detail).toContain(intake.runId);
  });

  it('lets a contract derived from the carried run cite the issue and the repository alike', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(root, store);

    const result = await runContractStage(
      { runId: inspected.record.runId },
      { store, now: NOW, random: () => 0.6, cwd: root },
    );
    const kinds = (result.acceptanceContract?.criteria ?? []).map(
      (criterion) => criterion.source.kind,
    );

    expect(named(result, 'Issue text')?.status).toBe('PASS');
    expect(named(result, 'Repository contract')?.status).toBe('PASS');
    expect(kinds).toContain('issue');
    expect(kinds).toContain('repository_policy');
    expect(result.record.issueRef?.canonical).toBe(intake.issueRef?.canonical);
  });

  it('names in the record the run a carried issue was read from', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(root, store);

    expect(
      inspected.record.limitations.some((line) => line.includes(intake.runId)),
      'a carried issue has to say which record it came from',
    ).toBe(true);
  });

  it('carries the newest matching intake when one checkout was intaken twice', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store, { at: new Date('2026-09-25T07:00:00.000Z') });
    const newest = await intakeAt(root, store, { at: new Date('2026-09-25T07:59:00.000Z') });

    const inspected = await inspectAt(root, store);
    expect(named(inspected, 'Issue from intake')?.detail).toContain(newest.runId);
    expect(inspected.record.issue?.bodySha256).toBe(newest.issue?.bodySha256);
  });

  it('never lets a carried issue move the pinned base commit', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(root, store);

    expect(inspected.record.base?.sha).toBe(GIT_MAIN_SHA);
    expect(inspected.record.local?.head.sha).toBe(GIT_MAIN_SHA);
  });
});

describe('inspect refuses to carry what it cannot prove', () => {
  it('leaves the issue out when the clone has moved to a different commit', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(root, store, otherCommit(root));

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.issue).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
    expect(named(inspected, 'Issue from intake')?.detail).toMatch(/commit|base/i);
  });

  it('leaves the issue out when this clone points at a different repository', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(
      root,
      store,
      originUrl(root, 'https://github.com/someone/else.git'),
    );

    expect(inspected.record.issueRef).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
  });

  // The identity proof is three fields, and a comparison that silently ignores
  // one of them still prints a confident `SKIP` for the cases it was written to
  // catch. These two isolated-clause cases are what make each field load-bearing
  // in this suite instead of only in `sameClone`'s source.
  it('leaves the issue out when only the repository name differs', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(
      root,
      store,
      originUrl(root, 'https://github.com/projectbharat/a-different-repo.git'),
    );

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.issue).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
  });

  it('leaves the issue out when only the host differs', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(
      root,
      store,
      originUrl(root, 'https://ghe.internal.example/projectbharat/datekit.git'),
    );

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.issue).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
  });

  it('leaves the default branch out too when the identity gap and the identity mismatch come together', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(
      root,
      store,
      foreignOriginWithoutHead(root, 'https://github.com/projectbharat/a-different-repo.git'),
    );

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.repository).toBeNull();
    expect(inspected.record.repository).not.toEqual(intake.repository);
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
  });

  it('leaves the issue out when this clone names no origin at all', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(root, store, originUrl(root, null));

    expect(inspected.record.issueRef).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
    expect(named(inspected, 'Issue from intake')?.detail).toMatch(/origin/i);
  });

  it('says so when the store holds no intake run', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const inspected = await inspectAt(root, store);

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.outcome).toBe('INSPECT_COMPLETE');
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
  });

  it('refuses to carry past a record this build cannot read, and still inspects', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);

    const blocked: RunStore = {
      ...store,
      async list() {
        const listing = await store.list();
        return {
          runs: listing.runs,
          unreadable: [{ file: '/runs/run-29991231T235959Z-deadbe.json', reason: 'unparseable' }],
        };
      },
    };
    const inspected = await runInspect(
      { repoPath: root },
      {
        run: scriptedRunner(cleanCloneTable(root)).run,
        store: blocked,
        now: NOW,
        random: () => 0.5,
      },
    );

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.outcome).toBe('INSPECT_COMPLETE');
    expect(named(inspected, 'Issue from intake')?.status).toBe('NOT_AVAILABLE');
    expect(inspected.saveError).toBeNull();
  });

  it('stops looking instead of walking a whole run directory', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store, { at: new Date('2026-01-01T00:00:00.000Z') });

    // Thirty Stage 2 runs newer than that intake, none of them an intake at all.
    // Each gets its own timestamp: `newRunId` is date-and-random derived, so a
    // fixed clock would make all thirty overwrite one another's record.
    const other = await fixtureRoot();
    for (let index = 0; index < 30; index += 1) {
      await inspectAt(
        other,
        store,
        {},
        new Date(Date.parse('2026-09-25T08:00:00.000Z') + index * 1000),
      );
    }

    const inspected = await inspectAt(root, store);
    expect(inspected.record.issueRef).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
    expect(named(inspected, 'Issue from intake')?.detail).not.toContain(intake.runId);
    expect(named(inspected, 'Issue from intake')?.detail).toMatch(/newest|most recent/i);
  });
});

describe('the same carry gives the record the repository intake read from GitHub', () => {
  // Stage 14 found this one by walking the rest of the documented chain. The
  // fixture clone was made with `git init` plus `git remote add`, so it has no
  // `refs/remotes/origin/HEAD`; `identityFromLocalSnapshot` therefore returns
  // null rather than invent a repository identity, and the inspection record
  // holds no default branch. `mergesutra pr` on the run the chain produced
  // answered `FAIL Publication proposal — Cannot name a branch for a pull
  // request: no earlier stage recorded a default branch for this repository`,
  // while the intake run of the same checkout held `defaultBranch: 'main'` read
  // from the GitHub API. The proof that makes an issue borrowable — same clone
  // origin, same commit — makes that field borrowable on exactly the same terms.
  it('carries the repository identity intake read when this clone cannot name one', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(root, store, noOriginHead(root));

    expect(inspected.record.repository).toEqual(intake.repository);
    expect(inspected.record.repository?.defaultBranch).toBe('main');
  });

  it('lets the pull-request stage name a target branch from the carried record', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    await intakeAt(root, store);
    const inspected = await inspectAt(root, store, noOriginHead(root));

    const target = targetOf({
      repository: inspected.record.repository,
      local: inspected.record.local,
      base: inspected.record.base,
    });
    expect(target.branch).toBe('main');
    expect(target.fullName).toBe('projectbharat/datekit');
  });

  it('names in the record the run a carried repository came from', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(root, store, noOriginHead(root));

    expect(
      inspected.record.limitations.some(
        (line) => line.includes(intake.runId) && /default branch/i.test(line),
      ),
      'a borrowed target branch has to say which run read it and from where',
    ).toBe(true);
  });

  it('keeps the branch Git itself named instead of overwriting it', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    const inspected = await inspectAt(root, store);

    expect(inspected.record.repository?.source).toBe('local-git');
    expect(inspected.record.repository).not.toEqual(intake.repository);
    // Nothing about the repository was borrowed here, so the record must not say
    // it was: a provenance note beside a fact this stage observed is a note that
    // teaches a reader to distrust the one identity that was actually measured.
    expect(inspected.record.limitations.some((line) => /default branch/i.test(line))).toBe(false);
  });

  it('refuses the whole carry when the intake’s repository is not this clone’s', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    if (!intake.repository) throw new Error('fixture intake recorded no repository');
    // An internally inconsistent record: its issue points at this clone, its
    // repository field points somewhere else. Neither half is trustworthy.
    await store.save({
      ...intake,
      repository: {
        ...intake.repository,
        owner: 'someone',
        repo: 'else',
        fullName: 'someone/else',
      },
    });

    const inspected = await inspectAt(root, store, noOriginHead(root));

    expect(inspected.record.issueRef).toBeNull();
    expect(inspected.record.repository).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('SKIP');
    expect(named(inspected, 'Issue from intake')?.detail).toContain('someone/else');
  });

  it('carries the issue alone from an intake that recorded no repository', async () => {
    const store = memoryRunStore();
    const root = await fixtureRoot();
    const intake = await intakeAt(root, store);
    await store.save({ ...intake, repository: null });

    const inspected = await inspectAt(root, store, noOriginHead(root));

    expect(inspected.record.issueRef).toEqual(intake.issueRef);
    expect(inspected.record.repository).toBeNull();
    expect(named(inspected, 'Issue from intake')?.status).toBe('PASS');
  });
});

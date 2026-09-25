import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { defaultRunner } from '../../src/core/runner.js';
import { runContractStage } from '../../src/cli/contract.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runPlanStage } from '../../src/plan/plan.js';
import {
  runImplementStage,
  type ImplementStageInput,
  type ImplementStageResult,
} from '../../src/implement/implement.js';
import { checkAction, finishAction, readAction, writeAction } from '../helpers/implement.js';
import { hasGit, headOf, realRepository } from '../helpers/git.js';
import { memoryRunStore, type MemoryRunStore } from '../helpers/github.js';
import { planBodyFor, scriptedClient, type ScriptedClient } from '../helpers/bharatcode.js';
import { cleanUp, NOW } from '../helpers/plan.js';

/**
 * Two runs of one repository, against real Git — Stage 6's contamination check.
 *
 * Every other Stage 6 test gives a run a workspace of its own and looks at that
 * workspace alone. The claim that matters is bigger than that: a machine can hold
 * many runs of the same repository at once, all of them worktrees of one Git
 * object database, all of them living inside directories of each other
 * (`.mergesutra/worktrees/<run-id>` is inside the primary checkout, and beside
 * every sibling). Isolation has to survive *that*, because the alternative is the
 * failure this product cannot have — one run's edit landing in another run's
 * candidate patch, or in the human's checkout.
 *
 * These tests use the real thing on purpose. A scripted `worktree list` can be
 * made to say anything, so it cannot prove that two worktrees stay apart.
 */

const tempDirs: string[] = [];
const gitAvailable = await hasGit();

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

interface PairFixture {
  readonly repo: string;
  readonly store: MemoryRunStore;
  readonly runA: string;
  readonly runB: string;
  readonly criteria: readonly string[];
}

/** One repository, inspected once, planned twice: two runs that will overlap. */
async function plannedPair(): Promise<PairFixture> {
  const repo = await realRepository();
  tempDirs.push(repo);
  const store = memoryRunStore();

  const inspected = await runInspect({ repoPath: repo }, { run: defaultRunner, store });
  const contracted = await runContractStage(
    { runId: inspected.record.runId },
    { store, now: () => NOW },
  );
  const criteria = contracted.acceptanceContract?.criteria.map((entry) => entry.id) ?? [];
  if (criteria.length === 0) throw new Error('fixture repository declared no gates');

  const a = await runPlanStage(
    { runId: contracted.record.runId },
    { store, now: () => NOW, random: () => 0.1, client: scriptedClient([planBodyFor(criteria)]) },
  );
  const b = await runPlanStage(
    { runId: contracted.record.runId },
    { store, now: () => NOW, random: () => 0.9, client: scriptedClient([planBodyFor(criteria)]) },
  );
  if (!a.record.plan || !b.record.plan) throw new Error('fixture lost a plan');
  return { repo, store, runA: a.record.runId, runB: b.record.runId, criteria };
}

interface Attempt {
  readonly result: ImplementStageResult;
  readonly client: ScriptedClient;
}

/**
 * One run of Stage 6, with no `run` dependency.
 *
 * This is the real process runner in real worktrees, so every git answer below is
 * Git's own. `cwd` is pinned to the repository so a record that somehow lost its
 * recorded toplevel cannot aim a worktree at the MergeSutra checkout instead.
 */
async function implement(
  fixture: PairFixture,
  runId: string,
  answers: readonly (string | unknown)[],
  input: ImplementStageInput = {},
): Promise<Attempt> {
  const client = scriptedClient(answers);
  const result = await runImplementStage(
    { runId, ...input },
    { store: fixture.store, client, now: () => NOW, cwd: fixture.repo },
  );
  return { result, client };
}

async function trackedStatus(repo: string): Promise<string> {
  const result = await defaultRunner('git', [
    '-C',
    repo,
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  return result.stdout;
}

async function branchOf(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return result.stdout.trim();
}

/** The feedback MergeSutra sent back after each rejected turn, newest last. */
function repairFeedback(client: ScriptedClient): string[] {
  return client.calls
    .map((call) => call.messages.at(-1)?.content ?? '')
    .filter((text) => text.includes('REJECTED BEFORE EXECUTION'));
}

describe.skipIf(!gitAvailable)('two runs of one repository, with nothing shared but Git', () => {
  it('gives each run its own workspace, and neither sees the other’s files', async () => {
    const fixture = await plannedPair();
    expect(fixture.runA).not.toBe(fixture.runB);
    const humanBranch = await branchOf(fixture.repo);

    const first = await implement(fixture, fixture.runA, [
      writeAction('src/only-a.ts', 'export const a = 1;\n', [fixture.criteria[0] ?? 'AC-1']),
      finishAction('A done.'),
    ]);
    const second = await implement(fixture, fixture.runB, [
      writeAction('src/only-b.ts', 'export const b = 2;\n', [fixture.criteria[0] ?? 'AC-1']),
      finishAction('B done.'),
    ]);

    expect(first.result.implementation.status).toBe('COMPLETED_BY_MODEL');
    expect(second.result.implementation.status).toBe('COMPLETED_BY_MODEL');

    // Separate directories, separate branches, the same pinned base.
    expect(first.result.workspace.path).not.toBe(second.result.workspace.path);
    expect(first.result.workspace.branch).toBe(`mergesutra/${fixture.runA}`);
    expect(second.result.workspace.branch).toBe(`mergesutra/${fixture.runB}`);
    expect(first.result.workspace.baseSha).toBe(second.result.workspace.baseSha);
    expect(first.result.workspace.relativePath).toBe(`.mergesutra/worktrees/${fixture.runA}`);

    // Each run's edit is in its own workspace and in no other place on disk.
    expect(existsSync(path.join(first.result.workspace.path, 'src', 'only-a.ts'))).toBe(true);
    expect(existsSync(path.join(second.result.workspace.path, 'src', 'only-a.ts'))).toBe(false);
    expect(existsSync(path.join(second.result.workspace.path, 'src', 'only-b.ts'))).toBe(true);
    expect(existsSync(path.join(first.result.workspace.path, 'src', 'only-b.ts'))).toBe(false);
    expect(existsSync(path.join(fixture.repo, 'src', 'only-a.ts'))).toBe(false);
    expect(existsSync(path.join(fixture.repo, 'src', 'only-b.ts'))).toBe(false);

    // A run's own `git status` names only its own work — never a sibling, and
    // never the `.mergesutra` directory the siblings live in.
    const statusA = await defaultRunner('git', [
      '-C',
      first.result.workspace.path,
      'status',
      '--porcelain',
    ]);
    expect(statusA.stdout).toContain('src/only-a.ts');
    expect(statusA.stdout).not.toContain('only-b');
    expect(statusA.stdout).not.toContain('.mergesutra');

    // The human's checkout is untouched, still on its own branch, with both
    // worktrees registered beside it and neither of them published.
    expect(await trackedStatus(fixture.repo)).toBe('');
    expect(await branchOf(fixture.repo)).toBe(humanBranch);
    const listing = await defaultRunner('git', ['-C', fixture.repo, 'worktree', 'list']);
    const worktrees = listing.stdout.trim().split(/\r?\n/);
    expect(worktrees).toHaveLength(3);
    expect(listing.stdout).toContain(fixture.runA);
    expect(listing.stdout).toContain(fixture.runB);
    for (const { result } of [first, second]) {
      expect(JSON.stringify(result.record)).not.toContain('CONTRIBUTION_READY');
      expect(result.checks.find((check) => check.name === 'Remote mutation')?.status).toBe(
        'NOT_AVAILABLE',
      );
    }
  }, 180_000);

  it('refuses a write and a read aimed at a sibling workspace, and leaves that sibling alone', async () => {
    const fixture = await plannedPair();
    const neighbour = await implement(fixture, fixture.runB, [
      writeAction('src/theirs.ts', 'export const theirs = 1;\n'),
      finishAction('B set up.'),
    ]);
    expect(existsSync(path.join(neighbour.result.workspace.path, 'src', 'theirs.ts'))).toBe(true);

    // Two turns, both naming the sibling by relative path. One repair round is
    // the budget, so this run asks for the second one up front — the point is
    // that both paths are refused, not that the loop gave up after the first.
    const attempt = await implement(
      fixture,
      fixture.runA,
      [
        writeAction(`../${fixture.runB}/src/theirs.ts`, 'export const overwritten = 1;\n'),
        readAction(`../${fixture.runB}/package.json`, 'read the other run'),
        finishAction('A could not reach the sibling.'),
      ],
      { limits: { maxSchemaRepairs: 2 } },
    );

    // Nothing ran: the path rule is the boundary, and it holds before execution.
    expect(attempt.result.implementation.summary.writes).toBe(0);
    expect(attempt.result.implementation.changes).toEqual([]);
    expect(attempt.result.implementation.actions.map((entry) => entry.action)).toEqual(['FINISH']);

    // The model was told why, twice, in words that name the rule and not its own
    // rejected text — and never told the sibling's contents.
    const feedback = repairFeedback(attempt.client);
    expect(feedback).toHaveLength(2);
    for (const text of feedback) {
      expect(text).toContain('repository-relative');
      expect(text).not.toContain('overwritten');
      expect(text).not.toContain('theirs');
    }

    // The sibling's file is exactly what its own run wrote, and its directory
    // gained nothing from the attempt.
    expect(
      await readFile(path.join(neighbour.result.workspace.path, 'src', 'theirs.ts'), 'utf8'),
    ).toContain('theirs = 1');
    expect(
      existsSync(
        path.join(fixture.repo, '.mergesutra', 'worktrees', fixture.runB, 'src', 'overwritten.ts'),
      ),
    ).toBe(false);
    expect(await trackedStatus(fixture.repo)).toBe('');
  }, 180_000);

  it('resumes a run into the workspace it already made, with its earlier file still there', async () => {
    const fixture = await plannedPair();
    const first = await implement(fixture, fixture.runA, [
      writeAction('src/step-one.ts', 'export const one = 1;\n'),
      finishAction('First attempt wrote one file.'),
    ]);
    expect(first.result.workspace.reused).toBe(false);

    const second = await implement(fixture, fixture.runA, [finishAction('Nothing more to do.')]);
    expect(second.result.workspace.reused).toBe(true);
    expect(second.result.implementation.workspace.reused).toBe(true);
    expect(second.result.workspace.path).toBe(first.result.workspace.path);
    expect(second.result.workspace.baseSha).toBe(first.result.workspace.baseSha);
    // The earlier edit is still there: resuming is continuing work, not a reset.
    expect(existsSync(path.join(second.result.workspace.path, 'src', 'step-one.ts'))).toBe(true);
    expect(second.result.implementation.summary.writes).toBe(0);
    // Still no commit, so a later stage sees a diff rather than a made decision.
    expect(await headOf(second.result.workspace.path)).toBe(first.result.workspace.baseSha);
    expect(await trackedStatus(fixture.repo)).toBe('');
  }, 180_000);

  it('refuses a workspace left at another commit instead of resetting it', async () => {
    const fixture = await plannedPair();
    const made = await implement(fixture, fixture.runA, [
      writeAction('src/hand-edited.ts', 'export const mine = 1;\n'),
      finishAction('First attempt.'),
    ]);
    const base = made.result.workspace.baseSha;

    // Someone (or some other run) moves that workspace to a different commit.
    const commit = await defaultRunner('git', [
      '-C',
      fixture.repo,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'later',
    ]);
    expect(commit.code).toBe(0);
    const later = await headOf(fixture.repo);
    expect(later).not.toBe(base);
    const detach = await defaultRunner('git', [
      '-C',
      made.result.workspace.path,
      'checkout',
      '--detach',
      later,
    ]);
    expect(detach.code).toBe(0);
    expect(await headOf(made.result.workspace.path)).toBe(later);

    // The refusal happens before the loop opens, so the model is never asked.
    const idleClient = scriptedClient([finishAction('Should not have started.')]);
    const caught = await runImplementStage(
      { runId: fixture.runA },
      { store: fixture.store, client: idleClient, now: () => NOW, cwd: fixture.repo },
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.message).toMatch(/exists but is at/);
    expect(error.remediation).toContain('yourself');
    // The proof that this is a refusal and not a repair: the workspace is exactly
    // where it was left, at the commit it was moved to, with its file still there.
    expect(await headOf(made.result.workspace.path)).toBe(later);
    expect(existsSync(path.join(made.result.workspace.path, 'src', 'hand-edited.ts'))).toBe(true);
    // And the model was never asked anything, because the run stopped at the door.
    expect(idleClient.calls).toEqual([]);
    expect(await trackedStatus(fixture.repo)).toBe('');
  }, 180_000);

  it('bounds a check that never finishes, with the loop’s own runner', async () => {
    const fixture = await plannedPair();
    // A bare `node` reads stdin forever, which is the one hang every platform
    // this product runs on produces on demand. Nothing is injected here: the
    // loop builds its own runner from `commandTimeoutMs`, so this is the
    // measurement the stage actually makes of a command that never returns.
    const attempt = await implement(
      fixture,
      fixture.runA,
      [checkAction(['node'], 'wait for the watcher'), finishAction('The check never reported.')],
      { limits: { commandTimeoutMs: 1_500 } },
    );

    const [check] = attempt.result.implementation.actions;
    expect(check?.action).toBe('RUN_CHECK');
    expect(check?.outcome).toBe('CHECK_FAILED');
    expect(check?.detail).toContain('command timed out after 1500ms');
    // The bound is a fact the loop carries on with, not an ending it invents.
    expect(attempt.result.implementation.summary.commands).toBe(1);
    expect(attempt.result.implementation.status).toBe('COMPLETED_BY_MODEL');
    expect(attempt.result.implementation.termination.kind).toBe('FINISH');
    expect(await trackedStatus(fixture.repo)).toBe('');
  }, 180_000);
});

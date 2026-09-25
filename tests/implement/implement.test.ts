import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import { defaultRunner, type RunResult } from '../../src/core/runner.js';
import { runContractStage } from '../../src/cli/contract.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runPlanStage } from '../../src/plan/plan.js';
import {
  runImplementStage,
  type ImplementStageDeps,
  type ImplementStageInput,
} from '../../src/implement/implement.js';
import { resolveLimits } from '../../src/implement/limits.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { headOf, hasGit, realRepository } from '../helpers/git.js';
import { memoryRunStore, type MemoryRunStore } from '../helpers/github.js';
import {
  checkAction,
  cleanUp,
  finishAction,
  gitCommand,
  implementHarness,
  NOW,
  plantWorkspace,
  readAction,
  writeAction,
  type StageHarness,
  type StageHarnessOptions,
} from '../helpers/implement.js';
import { planBodyFor, scriptedClient, TEST_MODEL } from '../helpers/bharatcode.js';

/**
 * The Stage 6 stage, from a stored plan to files in a workspace.
 *
 * The loop has its own suite; this one is about the sequence around it — the
 * things only this file can get wrong. A run that starts a model before checking
 * it has a contract, a loop pointed at the human's checkout instead of the
 * worktree, a new run id for the same work, or a record that says `PASS` because
 * the model said `FINISH`: each is a bug this stage could ship alone.
 */

const tempDirs: string[] = [];

/** The real-Git test below is the only one that needs Git on this machine. */
const gitAvailable = await hasGit();

afterEach(async () => {
  await cleanUp(tempDirs);
});

/**
 * The same run, over and over: a real Stage 1-4 record, and a git that answers
 * the workspace questions without this machine's git being involved.
 * `implementHarness` holds that fixture so the command suite below the stage one
 * cannot pass by disagreeing about what Git would have said.
 */
const harness = (
  answers: readonly (string | unknown)[],
  options: StageHarnessOptions = {},
): Promise<StageHarness> => implementHarness(tempDirs, answers, options);

/** Make one workspace verb fail, so the stage has a reason to refuse. */
function refuses(argv: readonly string[], verb: string): RunResult | null {
  return argv.slice(2).join(' ').startsWith(verb) ? { code: 1, stdout: '', stderr: '' } : null;
}

/** Replace the stored plan-stage record with a damaged copy of itself. */
async function damage(
  stage: StageHarness,
  changes: Partial<Pick<RunRecord, 'acceptanceContract' | 'plan' | 'base'>>,
): Promise<void> {
  await stage.store.save({ ...stage.record, ...changes });
}

describe('what must already be true before the model is asked anything', () => {
  it('refuses a run with no Acceptance Contract, without touching the network', async () => {
    const stage = await harness([finishAction()]);
    await damage(stage, { acceptanceContract: null });

    const error = await stage.implement().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toMatch(/no Acceptance Contract/);
    expect((error as AppError).remediation).toContain('mergesutra contract');
    expect(stage.client.calls).toEqual([]);
    expect(stage.calls).toEqual([]);
  });

  it('refuses a run with no plan, without touching the network', async () => {
    const stage = await harness([finishAction()]);
    await damage(stage, { plan: null });

    await expect(stage.implement()).rejects.toThrow(/no implementation plan/);
    expect(stage.client.calls).toEqual([]);
    expect(stage.calls).toEqual([]);
  });

  it('refuses a run that never recorded a base commit', async () => {
    const stage = await harness([finishAction()]);
    await damage(stage, { base: null });

    const error = await stage.implement().catch((caught: unknown) => caught);
    expect((error as AppError).message).toMatch(/never recorded a base commit/);
    expect(stage.calls).toEqual([]);
    expect(stage.client.calls).toEqual([]);
  });

  it('will not create a workspace that Git does not ignore', async () => {
    const stage = await harness([finishAction()], {
      refuseGit: (argv) => refuses(argv, 'check-ignore'),
    });

    const error = await stage.implement().catch((caught: unknown) => caught);
    expect((error as AppError).message).toMatch(/not git-ignored/);
    // Refusing to create it is only honest if nothing was created.
    expect(
      stage.calls.filter((argv) => argv[0] === 'git').map((argv) => gitCommand(argv)),
    ).not.toContainEqual(expect.stringMatching(/^worktree/));
    expect(existsSync(stage.workspacePath)).toBe(false);
    expect(stage.client.calls).toEqual([]);
  });

  it('asks for the run id, and takes the newest run that has a plan and a contract', async () => {
    const stage = await harness([finishAction()]);
    const result = await stage.implement({ runId: undefined });
    expect(result.record.runId).toBe(stage.runId);
    expect(result.implementation.runId).toBe(stage.runId);
  });

  it('refuses when no stored run has both a plan and a contract', async () => {
    const stage = await harness([finishAction()]);
    const empty = memoryRunStore();
    await expect(stage.implement({ runId: undefined }, { store: empty })).rejects.toThrow(
      /No run has a plan and a contract yet|could not be trusted/,
    );
    expect(stage.client.calls).toEqual([]);
  });
});

describe('the workspace the loop is rooted in', () => {
  it('prepares the worktree at the recorded base commit, not at a branch name', async () => {
    const stage = await harness([finishAction()]);
    const result = await stage.implement();

    const add = stage.calls.find((argv) => gitCommand(argv).startsWith('worktree add'));
    expect(add).toBeDefined();
    expect(add?.at(-1)).toBe(stage.record.base?.sha);
    expect(result.workspace.baseSha).toBe(stage.record.base?.sha);
    expect(result.workspace.branch).toBe(`mergesutra/${stage.runId}`);
    expect(result.implementation.workspace.baseSha).toBe(result.workspace.baseSha);
    expect(result.implementation.workspace.relativePath).toBe(result.workspace.relativePath);
  });

  it('writes where the run owns and never in the human checkout', async () => {
    const stage = await harness([
      writeAction('src/guard.ts', 'export const guard = 1;\n', []),
      finishAction(),
    ]);
    const result = await stage.implement();

    expect(result.implementation.summary.writes).toBe(1);
    expect(existsSync(path.join(stage.workspacePath, 'src', 'guard.ts'))).toBe(true);
    expect(existsSync(path.join(stage.root, 'src', 'guard.ts'))).toBe(false);
    expect(result.implementation.changes[0]?.relativePath).toBe('src/guard.ts');
    expect(result.implementation.changes[0]?.created).toBe(true);
  });

  it('keeps a refused path out of the filesystem entirely', async () => {
    const stage = await harness([
      {
        action: 'WRITE_FILE',
        path: 'src/../outside.ts',
        content: 'export const leak = 1;\n',
        reason: 'try to leave the workspace',
      },
      finishAction(),
    ]);
    const result = await stage.implement();

    expect(result.implementation.summary.writes).toBe(0);
    expect(result.implementation.changes).toEqual([]);
    expect(existsSync(path.join(stage.root, 'outside.ts'))).toBe(false);
    // The path never became an action at all: the schema is the boundary that
    // stopped it, so there is nothing in the log to soften into a warning later.
    expect(result.implementation.actions.map((entry) => entry.action)).toEqual(['FINISH']);
    // The model was told, in the next request, that its answer was rejected.
    const second = stage.client.calls[1]?.messages.at(-1)?.content ?? '';
    expect(second).toContain('REJECTED BEFORE EXECUTION');
    expect(second).toContain('..');
    expect(second).not.toContain('leak = 1');
  });

  it('never lets the workspace contents reach the record as a secret', async () => {
    const stage = await harness([readAction('.env'), finishAction()], {
      files: { 'src/notes.ts': 'const key = "sk-notevalue-NOT-A-SECRET-99999";\n' },
    });
    const result = await stage.implement();

    const text = JSON.stringify(result.record);
    // `.env` is in the workspace and is never read into anything.
    expect(text).not.toContain('sk-ws-SECRETVALUE');
    expect(result.implementation.actions[0]?.outcome).toBe('REFUSED');
    expect(text).not.toContain('sk-notevalue');
  });

  it('runs a model check as argv inside the workspace and never as a shell string', async () => {
    const stage = await harness([checkAction(['npm', 'test']), finishAction()]);
    await stage.implement();

    const check = stage.calls.find((argv) => argv[0] === 'npm');
    expect(check).toEqual(['npm', 'test']);
    // Nothing that reached the runner was a command string.
    for (const argv of stage.calls) {
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.every((token) => typeof token === 'string')).toBe(true);
      expect(argv.join(' ')).not.toMatch(/[;&|`$]/);
    }
  });

  it('refuses a remote mutation and never starts it', async () => {
    const stage = await harness([checkAction(['git', 'push', 'origin', 'HEAD']), finishAction()]);
    const result = await stage.implement();

    expect(result.implementation.actions[0]?.outcome).toBe('REFUSED');
    expect(result.implementation.summary.commands).toBe(0);
    expect(stage.calls.filter((argv) => argv.join(' ').includes('push'))).toEqual([]);
  });

  it('only ever asks Git for the workspace it owns', async () => {
    const stage = await harness([
      checkAction(['git', 'push', 'origin', 'HEAD']),
      checkAction(['git', 'status']),
      finishAction(),
    ]);
    await stage.implement();

    const verbs = new Set(
      stage.calls.filter((argv) => argv[0] === 'git').map((argv) => gitCommand(argv).split(' ')[0]),
    );
    expect([...verbs].sort()).toEqual(
      ['cat-file', 'check-ignore', 'rev-parse', 'status', 'worktree'].sort(),
    );
    expect(stage.calls.map((argv) => argv[0])).not.toContain('sh');
    expect(stage.calls.map((argv) => argv[0])).not.toContain('cmd');
  });
});

describe('the record this stage writes back', () => {
  it('advances the same run in place instead of forking a new id', async () => {
    const stage = await harness([finishAction()]);
    const result = await stage.implement();

    expect(result.record.runId).toBe(stage.runId);
    expect(result.record.createdAt).toBe(stage.record.createdAt);
    expect(result.record.stage).toBe('implement');
    expect(result.record.issueRef).toEqual(stage.record.issueRef);
    expect(result.record.repository).toEqual(stage.record.repository);
    expect(result.record.plan).toEqual(stage.record.plan);
    expect(result.record.acceptanceContract).toEqual(stage.record.acceptanceContract);
  });

  it('carries the contract forward byte for byte, whatever the model wanted', async () => {
    const stage = await harness([
      {
        action: 'PROPOSE_CONTRACT_REVISION',
        criterionId: 'AC-1',
        previous: 'Empty input is rejected with a TypeError.',
        proposed: 'Empty input is accepted.',
        reason: 'the tests are easier this way',
        sourceEvidence: 'test/parse.test.ts line 3',
      },
      finishAction('Done after loosening the requirement.'),
    ]);
    const result = await stage.implement();

    expect(JSON.stringify(result.record.acceptanceContract)).toBe(
      JSON.stringify(stage.record.acceptanceContract),
    );
    expect(result.implementation.proposedRevisions).toHaveLength(1);
    expect(result.implementation.proposedRevisions[0]).toMatchObject({
      criterionId: 'AC-1',
      proposed: 'Empty input is accepted.',
      applied: false,
    });
    expect(result.implementation.contractUntouched).toBe(true);
    expect(result.checks.find((check) => check.name === 'Proposed revisions')?.status).toBe('WARN');
    expect(result.implementation.limitations.join(' ')).toMatch(/stored unapplied/);
  });

  it('reports the contract it was given as unchanged, with its version', async () => {
    const stage = await harness([finishAction()]);
    const result = await stage.implement();
    const check = result.checks.find((entry) => entry.name === 'Acceptance Contract');
    expect(check?.detail).toContain(
      `${stage.record.acceptanceContract?.criteria.length} criterion(criteria) unchanged (v${stage.record.acceptanceContract?.version})`,
    );
    expect(check?.detail).toContain('no revision was applied');
  });

  it('maps every way the loop can end onto its own truthful run outcome', async () => {
    const controller = new AbortController();
    controller.abort();
    const unavailable: BharatCodeClient = {
      ...scriptedClient([]),
      async complete() {
        throw new AppError({
          kind: 'server',
          status: 503,
          message: 'Model unavailable',
          retryable: true,
        });
      },
    };
    // Every turn reads a real, different file and none of them finishes: the
    // step bound is what stops the loop, not a refusal or a missing answer.
    const probes = Object.fromEntries(
      Array.from({ length: 3 }, (_unused, index) => [
        `src/probe-${index}.ts`,
        `export const probe${index} = ${index};\n`,
      ]),
    );

    const cases: readonly (readonly [
      string,
      readonly (string | unknown)[],
      ImplementStageInput,
      ImplementStageDeps,
      StageHarnessOptions,
    ])[] = [
      ['COMPLETED_BY_MODEL', [finishAction()], {}, {}, {}],
      [
        'BLOCKED',
        [{ action: 'BLOCKED', reason: 'the file the issue names does not exist.' }],
        {},
        {},
        {},
      ],
      [
        'NEEDS_HUMAN_REVIEW',
        [readAction('src/probe-0.ts'), readAction('src/probe-1.ts'), readAction('src/probe-2.ts')],
        { limits: { maxSteps: 3 } },
        {},
        { files: probes },
      ],
      ['INCONCLUSIVE', [], { model: 'deepseek-v4.1-flash' }, { client: unavailable }, {}],
      ['CANCELLED', [finishAction()], { signal: controller.signal }, {}, {}],
    ];

    for (const [status, answers, input, deps, options] of cases) {
      const stage = await harness(answers, options);
      const result = await stage.implement(input, deps);
      expect(result.implementation.status).toBe(status);
      expect(result.record.stage).toBe('implement');
      expect(result.record.outcome).toBe(outcomeExpectedFrom(status));
      expect(result.record.outcome).not.toBe('CONTRIBUTION_READY');
      expect(result.record.nextStage).toContain(
        status === 'COMPLETED_BY_MODEL' ? 'VERIFY' : 'IMPLEMENT',
      );
      // A bound, a block and a cancellation all keep the worktree they wrote.
      expect(result.workspace.path).toContain(path.join('.mergesutra', 'worktrees'));
      expect(existsSync(result.workspace.path)).toBe(true);
    }
  });

  it('never reports a criterion as passing, because nothing verified one', async () => {
    const stage = await harness([
      writeAction('src/guard.ts', 'export const guard = 1;\n', ['AC-1']),
      checkAction(['npm', 'test']),
      finishAction('Guard clause added.', ['AC-1']),
    ]);
    const result = await stage.implement();

    const text = JSON.stringify(result.record);
    expect(text).not.toContain('CONTRIBUTION_READY');
    // No check row may claim a criterion passed, and the two honest absences stay.
    expect(result.checks.find((check) => check.name === 'Verification')).toMatchObject({
      status: 'NOT_AVAILABLE',
      detail: expect.stringContaining('no criterion was verified'),
    });
    expect(result.checks.find((check) => check.name === 'Remote mutation')?.status).toBe(
      'NOT_AVAILABLE',
    );
    expect(result.implementation.verified).toBe(false);
    expect(result.implementation.finishClaim?.criteriaBelievedComplete).toEqual(['AC-1']);
    expect(result.implementation.actions.at(-1)?.outcome).toBe('CLAIMED');
    const claim = result.checks.find((check) => check.name === 'Model claim');
    expect(claim?.status).toBe('WARN');
    expect(claim?.detail).toContain('a claim, not a verdict');
    // A command passing is recorded as a command passing. It never becomes a
    // criterion passing, because the loop has no outcome word for that.
    expect(result.implementation.actions.some((entry) => entry.outcome === 'CHECK_PASSED')).toBe(
      true,
    );
    // No criterion is given a row of its own to acquire a verdict in.
    expect(result.checks.map((check) => check.name)).not.toContain('AC-1');
  });

  it('says which workspace, model and bounds the run used', async () => {
    const stage = await harness([finishAction()], {});
    const result = await stage.implement(
      { limits: { maxSteps: 4, maxWrites: 2 }, model: 'deepseek-v4.1-flash' },
      {},
    );

    expect(result.implementation.limits).toEqual({
      maxSteps: 4,
      maxWrites: 2,
      maxCommands: resolveLimits().maxCommands,
      maxRepeatedFailures: resolveLimits().maxRepeatedFailures,
    });
    // The caller asked for one model; the record keeps the id that actually answered.
    expect(stage.client.calls[0]?.model).toBe('deepseek-v4.1-flash');
    expect(result.implementation.model).toBe(TEST_MODEL);
    const bharatCode = result.checks.find((check) => check.name === 'BharatCode');
    expect(bharatCode?.detail).toContain(`model ${TEST_MODEL}`);
  });

  it('writes a run record file and reports where it went', async () => {
    const stage = await harness([finishAction()]);
    const result = await stage.implement();
    expect(result.recordFile).toBe(`/runs/${stage.runId}.json`);
    expect(result.saveError).toBeNull();
    expect(await stage.store.load(stage.runId)).toMatchObject({ stage: 'implement' });
  });

  it('still returns the run when the record cannot be saved, and says so', async () => {
    const stage = await harness([finishAction()]);
    const broken: MemoryRunStore = {
      ...stage.store,
      async save() {
        throw new Error('disk is full');
      },
    };
    const result = await stage.implement({}, { store: broken });

    expect(result.saveError).toBe('disk is full');
    expect(result.recordFile).toBeNull();
    expect(result.checks.find((check) => check.name === 'Run record')).toMatchObject({
      status: 'WARN',
      detail: expect.stringContaining('not written'),
    });
  });

  it('counts writes and checks separately from refusals', async () => {
    // A loop that stops without writing, checking or finishing: the only way
    // `Writes: SKIP`, `Checks: SKIP` and `never claimed to be finished` can all
    // be true at once.
    const quiet = await harness([
      { action: 'BLOCKED', reason: 'the module the plan changes is not in this repository.' },
    ]);
    const quietRun = await quiet.implement();
    expect(quietRun.implementation.status).toBe('BLOCKED');
    expect(quietRun.checks.find((check) => check.name === 'Writes')?.status).toBe('SKIP');
    expect(quietRun.checks.find((check) => check.name === 'Checks')?.status).toBe('SKIP');
    expect(quietRun.checks.find((check) => check.name === 'Refused actions')?.status).toBe('PASS');
    expect(quietRun.checks.find((check) => check.name === 'Model claim')?.detail).toContain(
      'never claimed to be finished',
    );

    const busy = await harness([
      writeAction('src/guard.ts', 'export const guard = 1;\n'),
      checkAction(['npm', 'test']),
      readAction('.env', 'look for the key'),
    ]);
    const busyRun = await busy.implement();
    expect(busyRun.checks.find((check) => check.name === 'Writes')?.detail).toContain('1 file(s)');
    expect(busyRun.checks.find((check) => check.name === 'Checks')?.detail).toContain(
      '1 developer command(s)',
    );
    // A boundary said no, so the run cannot be described as a clean one.
    expect(busyRun.implementation.summary.refusedActions).toBe(1);
    expect(busyRun.checks.find((check) => check.name === 'Refused actions')?.status).toBe('WARN');
    expect(busyRun.checks.find((check) => check.name === 'Loop end')?.status).toBe('WARN');
  });

  it('reports a reused workspace as reused, and a dirty checkout as dirty', async () => {
    const fresh = await harness([finishAction()]);
    const first = await fresh.implement();
    expect(first.workspace.reused).toBe(false);
    expect(first.checks.find((check) => check.name === 'Workspace')?.detail).not.toContain(
      '(reused)',
    );
    expect(first.checks.find((check) => check.name === 'Primary checkout')).toBeUndefined();

    // A previous attempt already created this workspace, at the base commit.
    const reused = await harness([finishAction()]);
    await plantWorkspace(reused.workspacePath);
    const second = await reused.implement();
    expect(second.workspace.reused).toBe(true);
    expect(second.checks.find((check) => check.name === 'Workspace')?.detail).toContain('(reused)');
    expect(reused.calls.filter((argv) => gitCommand(argv).startsWith('worktree add'))).toEqual([]);

    const dirty = await harness([finishAction()], { dirtyPrimary: true });
    const dirtyRun = await dirty.implement();
    expect(dirtyRun.workspace).toMatchObject({ primaryDirty: true, dirtyCount: 2 });
    expect(dirtyRun.checks.find((check) => check.name === 'Primary checkout')?.detail).toContain(
      'reported, not repaired',
    );
    // Reporting a dirty checkout is not the same as fixing it.
    expect(dirty.calls.map((argv) => gitCommand(argv)).join(' ')).not.toMatch(
      /stash|clean|reset|restore/,
    );
  });
});

describe('the whole stage against real Git', () => {
  it.skipIf(!gitAvailable)(
    'takes a real repository from inspect to files in a real worktree, leaving the checkout clean',
    async () => {
      const repo = await realRepository();
      tempDirs.push(repo);
      const store = memoryRunStore();

      const inspected = await runInspect({ repoPath: repo }, { run: defaultRunner, store });
      const contracted = await runContractStage(
        { runId: inspected.record.runId },
        { store, now: () => NOW },
      );
      const criteria = contracted.acceptanceContract?.criteria.map((entry) => entry.id) ?? [];
      expect(criteria.length).toBeGreaterThan(0);
      const planned = await runPlanStage(
        { runId: contracted.record.runId },
        { store, now: () => NOW, client: scriptedClient([planBodyFor(criteria)]) },
      );
      const source = planned.record;
      if (!source.plan || !source.acceptanceContract) throw new Error('fixture lost its plan');

      const result = await runImplementStage(
        { runId: source.runId, repo },
        {
          store,
          client: scriptedClient([
            writeAction(
              'src/guard.ts',
              'export function guard(input: string): void {\n  if (!input) throw new TypeError("empty");\n}\n',
              [source.acceptanceContract.criteria[0]?.id ?? 'AC-1'],
            ),
            finishAction('Added the guard module the plan describes.', [
              source.acceptanceContract.criteria[0]?.id ?? 'AC-1',
            ]),
          ]),
        },
      );

      expect(result.implementation.status).toBe('COMPLETED_BY_MODEL');
      expect(result.implementation.summary.writes).toBe(1);
      expect(result.record.outcome).toBe('IMPLEMENTED_BY_MODEL');

      // The change exists in the run's worktree and nowhere else.
      const changed = path.join(result.workspace.path, 'src', 'guard.ts');
      expect(existsSync(changed)).toBe(true);
      expect(await readFile(changed, 'utf8')).toContain('TypeError');
      expect(existsSync(path.join(repo, 'src', 'guard.ts'))).toBe(false);

      // The checkout's tracked content is byte-for-byte what Git already had.
      // Untracked noise is excluded because a machine-wide package manager may
      // drop a lockfile into a temp directory mid-test; that is not this stage's
      // write, and the existsSync checks above are what pin the stage's own bytes.
      const tracked = await defaultRunner('git', [
        '-C',
        repo,
        'status',
        '--porcelain',
        '--untracked-files=no',
      ]);
      expect(tracked.stdout).toBe('');
      // Whatever else is untracked, none of it belongs to this run.
      const untracked = await defaultRunner('git', ['-C', repo, 'status', '--porcelain']);
      expect(untracked.stdout).not.toMatch(/guard|\.mergesutra|parse\.ts|worktree/);
      const base = await headOf(repo);
      expect(base).toBe(result.implementation.workspace.baseSha);
      expect(await headOf(result.workspace.path)).toBe(base);
      expect(result.implementation.workspace.branch).toBe(`mergesutra/${source.runId}`);
      expect(
        (
          await defaultRunner('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])
        ).stdout.trim(),
      ).not.toBe(result.implementation.workspace.branch);

      // Nothing was published: real Git, and not one mutating remote command.
      expect(result.checks.find((check) => check.name === 'Remote mutation')?.status).toBe(
        'NOT_AVAILABLE',
      );
      expect(JSON.stringify(result.record)).not.toContain('CONTRIBUTION_READY');
    },
    120_000,
  );
});

function outcomeExpectedFrom(status: string): string {
  return (
    {
      COMPLETED_BY_MODEL: 'IMPLEMENTED_BY_MODEL',
      BLOCKED: 'IMPLEMENTATION_BLOCKED',
      NEEDS_HUMAN_REVIEW: 'IMPLEMENTATION_NEEDS_REVIEW',
      INCONCLUSIVE: 'IMPLEMENTATION_INCONCLUSIVE',
      CANCELLED: 'IMPLEMENTATION_BLOCKED',
    } as Record<string, string>
  )[status]!;
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/implement/limits.js';
import { resumeAction } from '../../src/cli/resume.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { loopBudgetOf } from '../../src/lifecycle/budget.js';
import {
  checkAction,
  finishAction,
  implementHarness,
  readAction,
  writeAction,
} from '../helpers/implement.js';
import { recordWith } from '../helpers/review.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { hasGit } from '../helpers/git.js';
import type { StageHarness } from '../helpers/implement.js';
import type { Runner } from '../../src/core/runner.js';
import type { ImplementationRecord, TerminationKind } from '../../src/implement/state.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * What a resumed loop may still spend, proved at the boundary a person stands at.
 *
 * `tests/lifecycle/budget.test.ts` shows the arithmetic is right and shows one stage
 * entry handing the next one its leftovers. Neither is the claim this file exists to
 * hold. The claim is that the residual survives *the walk*: `resumeAction` →
 * `stageDispatcher` → `runImplementStage` → `runImplementationLoop` → `resolveLimits`.
 * Four hops, and each is a line a future change can rewrite without touching a number
 * — `limits` dropped from a spread, a stage input that stops forwarding it, a
 * dispatcher case that rebuilds the call. The default on the far side of a dropped hop
 * is `DEFAULT_LIMITS`: a fresh twelve turns, six writes and four checks — §19's
 * doubling of autonomy, with every unit test in this build still green because the
 * arithmetic was never asked.
 *
 * So each drive runs the real Stage 6 twice over one workspace through the real CLI
 * entry, with a scripted model and no credential, and asserts on what the loop *did*:
 * the requests the client actually received, the spend the second entry filed, and the
 * bound it stopped on. A dropped hop changes all three. That is why those are the
 * witnesses and not the object the dispatcher was handed.
 *
 * The bound under test is not always steps. Running out of turns, out of writes and
 * out of check runs are the same failure with different counters, and the residual is
 * per-axis — so each drive spends its own axis to one short of the shipped bound and
 * leaves the other two with room, otherwise the steps bound would end the run first
 * and the writes bound would go unwitnessed.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();
const PID = 4242;
const HOST = 'this-host';

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

const READABLE = ['src/parse.ts', 'README.md', 'test/parse.test.ts'] as const;

/** A write to a path the fixture workspace does not have, so no digest is required. */
function newFile(index: number) {
  return writeAction(
    `src/gen-${String(index)}.ts`,
    `export const gen${String(index)} = ${String(index)};\n`,
  );
}

/** Reads that alternate files: three identical consecutive actions end a loop on their own. */
function reads(count: number) {
  return Array.from({ length: count }, (_, index) =>
    readAction(READABLE[index % READABLE.length] as string),
  );
}

type Axis = 'steps' | 'writes' | 'commands';

/**
 * One interrupted entry, then more work than the resumed entry is allowed to do.
 *
 * `first` is the spend the loop actually filed before it was stopped; `second` offers
 * more on its own axis than the residual bound has room for.
 */
const DRIVES: Record<Axis, { first: readonly unknown[]; second: readonly unknown[] }> = {
  // 8 turns: 8 steps, 2 writes, 0 checks — of 12 / 6 / 4.
  steps: {
    first: [...reads(3), newFile(1), newFile(2), ...reads(2), finishAction('One')],
    second: [...reads(5), finishAction('Two')],
  },
  // 9 turns: 5 writes of 6, 9 steps, 0 checks.
  writes: {
    first: [
      newFile(1),
      newFile(2),
      newFile(3),
      newFile(4),
      newFile(5),
      ...reads(3),
      finishAction('One'),
    ],
    second: [newFile(6), newFile(7), newFile(8), finishAction('Two')],
  },
  // 7 turns: 3 checks of 4, 7 steps, 1 write.
  commands: {
    first: [
      checkAction(['npm', 'test']),
      checkAction(['npm', 'run', 'lint']),
      checkAction(['node', '--test']),
      newFile(1),
      ...reads(2),
      finishAction('One'),
    ],
    second: [
      checkAction(['npm', 'test']),
      checkAction(['npm', 'run', 'lint']),
      checkAction(['node', '--test']),
      finishAction('Two'),
    ],
  },
};

/** What each drive leaves, spends and is asked for, on the axis it tests. */
const EXPECT: Record<Axis, { spent: number; left: number; turns: number; bound: number }> = {
  steps: { spent: 8, left: 4, turns: 4, bound: DEFAULT_LIMITS.maxSteps },
  writes: { spent: 5, left: 1, turns: 2, bound: DEFAULT_LIMITS.maxWrites },
  commands: { spent: 3, left: 1, turns: 2, bound: DEFAULT_LIMITS.maxCommands },
};

const ENDED: Record<Axis, TerminationKind> = {
  steps: 'MAX_STEPS',
  writes: 'MAX_WRITES',
  commands: 'MAX_COMMANDS',
};

function loopOf(record: RunRecord): ImplementationRecord {
  const loop = record.implementation;
  if (!loop) throw new Error('the fixture run filed no loop record');
  return loop;
}

/**
 * The loop, interrupted with most of one bound spent.
 *
 * The first entry is real, so the spend is what a loop filed rather than a number this
 * file typed. Only the *ending* is restated: a loop that stopped because the model said
 * `FINISH` is a claim Stage 7 gets to check, and `resume` rightly refuses to continue
 * it — so an interrupted run has to be said to have been interrupted.
 */
async function interruptedLoop(axis: Axis): Promise<StageHarness> {
  const { first, second } = DRIVES[axis];
  const harness = await implementHarness(tempDirs, [...first, ...second]);
  const entry = await harness.implement();
  const loop = loopOf(entry.record);
  expect(loop.summary.steps).toBe(first.length);
  expect(loop.summary[axis]).toBe(EXPECT[axis].spent);

  await harness.store.save(
    recordWith(entry.record, {
      implementation: {
        ...loop,
        status: 'CANCELLED',
        termination: { kind: 'DEADLINE', detail: 'the human stopped the loop mid-work' },
      },
    }),
  );
  return harness;
}

/**
 * The fixture's scripted Git, plus the one question Stage 11 asks it.
 *
 * `answerWorkspaceGit` scripts the commands Stage 5-7 make a workspace with and fails
 * anything else, which is deliberate: a run whose base Git will not vouch for has to be
 * reported as blocked (see `tests/lifecycle/interruption.test.ts`). That is right for a
 * screen and fatal for this file, because a blocked run never reaches the walk whose
 * bounds are under test — the plan comes back `RECOVERY_BLOCKED` and every assertion
 * below then measures a run that did not happen. So *this* file answers the one extra
 * question, for the one drive that needs to get past the observation, and leaves the
 * shared fixture — and the blocker test that depends on it — exactly as it found it.
 */
function gitThatVouchesForTheBase(git: Runner): Runner {
  return async (program, args) => {
    if (program === 'git' && args.slice(2).join(' ').startsWith('cat-file -e')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    return git(program, args);
  };
}

/** `mergesutra resume <run-id> --execute`, with the real Stage 6 behind the dispatcher. */
async function resumeExecute(harness: StageHarness, screen: string[]): Promise<number> {
  const git = harness.deps.run;
  if (!git) throw new Error('the fixture stage has no process runner to share');
  return resumeAction(
    harness.runId,
    { execute: true, env: { NO_COLOR: '1' } },
    {
      // The same Git that built this run's workspace answers the questions `resume`
      // asks on the way in, so the observation describes a workspace rather than
      // refusing one.
      resume: {
        store: harness.store,
        runsRoot: harness.root,
        cwd: harness.root,
        now: () => NOW,
        pid: PID,
        host: HOST,
        run: gitThatVouchesForTheBase(git),
      },
      implement: harness.deps,
    },
    (line) => screen.push(line),
  );
}

describe.skipIf(!AVAILABLE)('what a resumed loop may spend, at the command boundary', () => {
  it.each(['steps', 'writes', 'commands'] as const)(
    'carries the %s residual all the way into the loop the dispatcher runs',
    async (axis) => {
      const harness = await interruptedLoop(axis);
      const before = loopOf(await harness.store.load(harness.runId));
      const screen: string[] = [];

      const code = await resumeExecute(harness, screen);

      const after = await harness.store.load(harness.runId);
      const loop = loopOf(after);
      const residual = loopBudgetOf(before).resumedLimits;
      expect(residual).not.toBeNull();

      // The bounds the second entry filed are the leftovers, not the shipped defaults.
      expect({
        maxSteps: loop.limits.maxSteps,
        maxWrites: loop.limits.maxWrites,
        maxCommands: loop.limits.maxCommands,
      }).toEqual({
        maxSteps: residual?.maxSteps,
        maxWrites: residual?.maxWrites,
        maxCommands: residual?.maxCommands,
      });
      expect(loop.limits.maxSteps).toBeLessThan(DEFAULT_LIMITS.maxSteps);

      // It stopped on the axis under test, having spent exactly what was left of it.
      expect(loop.termination?.kind).toBe(ENDED[axis]);
      expect(loop.summary[axis]).toBe(EXPECT[axis].left);

      // Two entries together never pass the bound the first entry was given.
      expect(before.summary[axis] + loop.summary[axis]).toBeLessThanOrEqual(EXPECT[axis].bound);

      // And no turn was asked for that nobody was allowed to spend: the first entry's
      // turns, then only what the residual leaves. A dropped hop here is a client that
      // gets asked for a thirteenth turn, which is the whole §19 failure.
      expect(harness.client.calls).toHaveLength(DRIVES[axis].first.length + EXPECT[axis].turns);

      expect(after.outcome).toBe('IMPLEMENTATION_NEEDS_REVIEW');
      expect(code).toBe(EXIT.INCONCLUSIVE);
    },
  );

  it('refuses a third entry rather than re-issuing the allowance the second one spent', async () => {
    const harness = await interruptedLoop('steps');
    const screen: string[] = [];
    await resumeExecute(harness, screen);
    const spent = loopOf(await harness.store.load(harness.runId));
    expect(loopBudgetOf(spent).canReenter).toBe(false);
    const turnsAfterSecond = harness.client.calls.length;

    const code = await resumeExecute(harness, screen);

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(harness.client.calls).toHaveLength(turnsAfterSecond);
    const unchanged = loopOf(await harness.store.load(harness.runId));
    expect(unchanged.summary.steps).toBe(spent.summary.steps);
    expect(unchanged.limits).toEqual(spent.limits);
  });

  it('refuses an axis the record has spent, whatever it claims about how it ended', async () => {
    const harness = await interruptedLoop('steps');
    await resumeExecute(harness, []);
    const spent = loopOf(await harness.store.load(harness.runId));
    // The same restatement this file's own fixture makes, applied to a run that has
    // spent its bound: a person (or a forged record) asserting "it was only
    // interrupted" is not an allowance. §13's answer to an axis the persisted facts
    // cannot continue is a block, not fresh authority.
    await harness.store.save(
      recordWith(await harness.store.load(harness.runId), {
        implementation: {
          ...spent,
          status: 'CANCELLED',
          termination: { kind: 'DEADLINE', detail: 'the record says it was interrupted' },
        },
      }),
    );
    const turnsBefore = harness.client.calls.length;
    const screen: string[] = [];

    const code = await resumeExecute(harness, screen);

    expect(code).toBe(EXIT.INCONCLUSIVE);
    expect(harness.client.calls).toHaveLength(turnsBefore);
    expect(screen.join('\n')).toMatch(/no room|nothing left|spent/i);
    expect(loopOf(await harness.store.load(harness.runId)).limits).toEqual(spent.limits);
  });
});

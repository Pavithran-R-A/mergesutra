import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/implement/limits.js';
import { buildResumePlan } from '../../src/lifecycle/resume-plan.js';
import { runStatusStage } from '../../src/lifecycle/status.js';
import { hasRoomIn, lifecycleBudgetOf, loopBudgetOf } from '../../src/lifecycle/budget.js';
import {
  DEFAULT_REPAIR_LIMITS,
  MAX_REPAIR_CYCLES_CEILING,
  MAX_REVIEW_CYCLES_CEILING,
} from '../../src/repair/bounds.js';
import {
  checkAction,
  finishAction,
  implementHarness,
  readAction,
  writeAction,
} from '../helpers/implement.js';
import { recordWith } from '../helpers/review.js';
import { cycleFor, frozenPlan, measuredPatch } from '../helpers/repair.js';
import { implementedRun } from '../helpers/verifyRun.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { hasGit } from '../helpers/git.js';
import type { ImplementationRecord, TerminationKind } from '../../src/implement/state.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * What a resumed stage may still be allowed to spend.
 *
 * §19's failure has a specific shape: a loop that stopped with 3 of its 12 turns
 * used, restarted by a recovery tool that hands it the shipped defaults again and
 * quietly buys twelve more — fifteen turns of model work and up to twice the writes
 * on a patch one person approved. "Do whatever it takes until PR" is the same
 * mistake with a friendlier name. So the numbers here are subtraction over the
 * record a loop already filed, and the rule they enforce is that a second entry is
 * measured against what the first one left.
 *
 * The arithmetic is honest only as far as the data goes, and this file is equally
 * about that boundary. Stage 6 records a bound for four axes and a spent count for
 * three of them; repair cycles are counted from the plan and the executions that
 * claimed one; a review's round trips survive in no document at all. Where the
 * record cannot prove an allowance, the budget says so in `limitations` rather than
 * defaulting the gap shut — §19's own instruction is to fail conservatively rather
 * than double a run's autonomy by reading a missing number as nothing spent.
 *
 * Two cases run Stage 6 twice over one workspace through the real stage, because
 * "a continued entry cannot spend past the first entry's bound" is a claim about the
 * record the second entry files, and no hand-written object can prove it.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

/**
 * A run whose loop spent 3 of 12 steps, 2 of 8 writes and 1 of 6 checks.
 *
 * Built per test rather than memoised: `afterEach` removes the temporary repository
 * a fixture lives in, so a shared record would eventually be one whose workspace is
 * gone — and the case that reads a status snapshot would then be measuring a missing
 * directory instead of the arithmetic under test.
 */
async function loopRun(): Promise<RunRecord> {
  return (await implementedRun(tempDirs)).source;
}

/** The loop's own record, with its spend, bound or ending restated. */
function loopOf(
  record: RunRecord,
  over: Partial<Pick<ImplementationRecord, 'limits' | 'summary' | 'status' | 'termination'>>,
): ImplementationRecord {
  const implementation = record.implementation;
  if (!implementation) throw new Error('the fixture run filed no loop record');
  return { ...implementation, ...over };
}

const ENDED_ON: Record<'steps' | 'writes' | 'commands', TerminationKind> = {
  steps: 'MAX_STEPS',
  writes: 'MAX_WRITES',
  commands: 'MAX_COMMANDS',
};

/** The same loop, stopped by one axis being spent. */
function loopSpending(
  record: RunRecord,
  axis: 'steps' | 'writes' | 'commands',
  value: number,
): ImplementationRecord {
  const { summary } = record.implementation as ImplementationRecord;
  return loopOf(record, {
    status: 'CANCELLED',
    termination: { kind: ENDED_ON[axis], detail: `the loop stopped with ${axis} at this bound` },
    summary: {
      ...summary,
      steps: axis === 'steps' ? value : summary.steps,
      modelRequests: axis === 'steps' ? value : summary.modelRequests,
      writes: axis === 'writes' ? value : summary.writes,
      commands: axis === 'commands' ? value : summary.commands,
    },
  });
}

/** One review-and-repair cycle, assembled by the product's own constructors. */
function cycleIn(record: RunRecord, reviewCycle: number, repairCycle: number) {
  const implementation = record.implementation as ImplementationRecord;
  const { description } = measuredPatch(
    [
      [
        'src/parse.ts',
        'export function parse(value: string): Date {\n  return new Date(value);\n}\n',
        'MODIFIED',
      ],
    ],
    record.base?.sha ?? 'f'.repeat(40),
  );
  const plan = frozenPlan({
    runId: record.runId,
    criteria: (record.acceptanceContract?.criteria ?? []).map((criterion) => criterion.id),
    patchIdentity: description.identity,
    expectedChecks: ['VG-001'],
    reviewCycle,
    repairCycle,
    createdAt: NOW.toISOString(),
  });
  return {
    plan,
    execution: cycleFor({ plan, patch: description, implementation, createdAt: NOW.toISOString() }),
  };
}

/** The snapshot `mergesutra status` builds over this record. */
async function snapshotOf(record: RunRecord) {
  const where = await implementedRun(tempDirs);
  await where.prepared.store.save(record);
  const { snapshot } = await runStatusStage(
    { runId: record.runId },
    {
      store: where.prepared.store,
      runsRoot: where.prepared.root,
      cwd: record.local?.toplevel ?? where.prepared.root,
      now: () => NOW,
    },
  );
  return snapshot;
}

describe.skipIf(!AVAILABLE)('what a resumed stage may still spend', () => {
  it('hands a continued loop the steps that are left, not the steps the first loop had', async () => {
    const loop = (await loopRun()).implementation as ImplementationRecord;
    const budget = loopBudgetOf(loop);

    expect(budget.steps).toEqual({ bound: 12, spent: 3, left: 9 });
    expect(budget.resumedLimits?.maxSteps).toBe(9);
    expect(budget.resumedLimits?.maxSteps).toBeLessThan(loop.limits.maxSteps);
  });

  it('cuts the write allowance by the writes already spent', async () => {
    const budget = loopBudgetOf((await loopRun()).implementation as ImplementationRecord);

    expect(budget.writes).toEqual({ bound: 8, spent: 2, left: 6 });
    expect(budget.resumedLimits?.maxWrites).toBe(6);
  });

  it('cuts the check allowance by the checks already run', async () => {
    const budget = loopBudgetOf((await loopRun()).implementation as ImplementationRecord);

    expect(budget.commands).toEqual({ bound: 6, spent: 1, left: 5 });
    expect(budget.resumedLimits?.maxCommands).toBe(5);
  });

  it('carries the repeat bound from the record instead of re-defaulting it', async () => {
    const loop = (await loopRun()).implementation as ImplementationRecord;
    const narrowed = loopBudgetOf({
      ...loop,
      limits: { ...loop.limits, maxRepeatedFailures: 2 },
    });

    expect(DEFAULT_LIMITS.maxRepeatedFailures).toBe(3);
    expect(narrowed.resumedLimits?.maxRepeatedFailures).toBe(2);
  });

  it('gives no allowance at all to a loop that used every step', async () => {
    const budget = loopBudgetOf(loopSpending(await loopRun(), 'steps', 12));

    expect(budget.canReenter).toBe(false);
    expect(budget.resumedLimits).toBeNull();
  });

  it('gives no allowance to a loop out of writes even with steps left', async () => {
    const budget = loopBudgetOf(loopSpending(await loopRun(), 'writes', 8));

    expect(budget.steps.left).toBe(9);
    expect(budget.canReenter).toBe(false);
    expect(budget.resumedLimits).toBeNull();
  });

  it('gives no allowance to a loop that used every check even with steps left', async () => {
    const budget = loopBudgetOf(loopSpending(await loopRun(), 'commands', 6));

    expect(budget.canReenter).toBe(false);
    expect(budget.resumedLimits).toBeNull();
  });

  it('leaves an over-spend negative instead of clamping it into room', async () => {
    const budget = loopBudgetOf(loopSpending(await loopRun(), 'steps', 13));

    expect(budget.steps).toEqual({ bound: 12, spent: 13, left: -1 });
    expect(budget.canReenter).toBe(false);
  });

  it('keeps a bound the record never named out of the carried limits, and says so', async () => {
    const budget = loopBudgetOf((await loopRun()).implementation as ImplementationRecord);

    expect(budget.notCarried).toContain('maxRefusals');
    expect(budget.notCarried).toContain('loopDeadlineMs');
    expect(budget.notCarried).not.toContain('maxSteps');
    expect(budget.notCarried).not.toContain('maxRepeatedFailures');
    expect(Object.keys(budget.resumedLimits ?? {})).not.toContain('maxRefusals');
  });

  it('never hands a continued loop more of an axis than the record bounded', async () => {
    const loop = (await loopRun()).implementation as ImplementationRecord;
    const limits = loopBudgetOf(loop).resumedLimits;
    expect(limits).not.toBeNull();

    for (const [key, value] of Object.entries(limits ?? {})) {
      const named = (loop.limits as Record<string, number>)[key];
      const ceiling = named ?? DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS];
      expect(Number(value)).toBeGreaterThan(0);
      expect(Number(value)).toBeLessThanOrEqual(Number(ceiling));
    }
  });

  it('says the bound it carries replaces the record of the entry before it', async () => {
    const limitations = lifecycleBudgetOf(await loopRun()).limitations.join('\n');

    expect(limitations).toMatch(/one entry/i);
    expect(limitations).toMatch(/lifetime/i);
  });

  it('cannot spend past the first entry bound across two real loop entries', async () => {
    const stage = await implementHarness(tempDirs, [
      writeAction('src/guard.ts', 'export const guard = 1;\n'),
      checkAction(['npm', 'test']),
      readAction('src/parse.ts'),
      finishAction('First entry stops here.'),
      readAction('README.md'),
      finishAction('Second entry stops here.'),
    ]);

    const first = await stage.implement();
    expect(first.implementation.summary).toMatchObject({ steps: 4, writes: 1, commands: 1 });
    const budget = loopBudgetOf(first.implementation);
    expect(budget.resumedLimits).toEqual({
      maxSteps: 8,
      maxWrites: 5,
      maxCommands: 3,
      maxRepeatedFailures: 3,
    });
    // A caller that reaches this line has already read `canReenter`; the throw only
    // narrows `null`, which is the budget's way of saying there is nothing to give.
    if (budget.resumedLimits === null) throw new Error('a loop with room left gave no allowance');

    const second = await stage.implement({ limits: budget.resumedLimits });
    const spentAcrossEntries =
      first.implementation.summary.steps + second.implementation.summary.steps;

    expect(second.implementation.limits.maxSteps).toBe(8);
    expect(second.implementation.summary.steps).toBe(2);
    expect(spentAcrossEntries).toBeLessThanOrEqual(first.implementation.limits.maxSteps);
    expect(loopBudgetOf(second.implementation).steps.left).toBe(
      first.implementation.limits.maxSteps - spentAcrossEntries,
    );
  });

  it('counts a review cycle from the plan that claimed it', async () => {
    const record = await loopRun();
    const { plan } = cycleIn(record, 2, 2);
    const budget = lifecycleBudgetOf(recordWith(record, { repairPlan: plan }));

    expect(budget.reviewCycles.used).toBe(2);
    expect(budget.repairCycles.used).toBe(2);
    expect(budget.reviewCycles.left).toBe(MAX_REVIEW_CYCLES_CEILING - 2);
  });

  it('counts a cycle an execution filed even with no plan left on the record', async () => {
    const record = await loopRun();
    const { execution } = cycleIn(record, 3, 3);
    const budget = lifecycleBudgetOf(
      recordWith(record, { repairPlan: null, repairExecutions: [execution] }),
    );

    expect(budget.reviewCycles.used).toBe(3);
    expect(budget.repairCycles.left).toBe(0);
  });

  it('counts no cycle for a run that froze no plan', async () => {
    const budget = lifecycleBudgetOf(await loopRun());

    expect(budget.reviewCycles.used).toBe(0);
    expect(budget.repairCycles.used).toBe(0);
    expect(budget.reviewCycles.left).toBe(MAX_REVIEW_CYCLES_CEILING);
  });

  it('measures a cycle against the ceiling no caller may raise, and names it', async () => {
    const budget = lifecycleBudgetOf(await loopRun());

    expect(DEFAULT_REPAIR_LIMITS.maxReviewCycles).toBeLessThan(MAX_REVIEW_CYCLES_CEILING);
    expect(budget.repairCycles.ceiling).toBe(MAX_REPAIR_CYCLES_CEILING);
    expect(budget.limitations.join('\n')).toMatch(/ceiling/i);
  });

  it('refuses to read a cycle past its ceiling as one with room left', async () => {
    const record = await loopRun();
    const { plan } = cycleIn(record, MAX_REVIEW_CYCLES_CEILING + 1, MAX_REPAIR_CYCLES_CEILING + 1);
    const budget = lifecycleBudgetOf(recordWith(record, { repairPlan: plan }));

    expect(budget.reviewCycles.left).toBeLessThan(0);
    expect(budget.repairCycles.left).toBeLessThan(0);
  });

  it('states that review round trips survive in no document at all', async () => {
    const limitations = lifecycleBudgetOf(await loopRun()).limitations.join('\n');

    expect(limitations).toMatch(/review/i);
    expect(limitations).toMatch(/attempt/i);
    expect(limitations).toMatch(/no count|nothing|no document/i);
  });

  it('shares one re-entry rule with the plan a resume carries', async () => {
    const record = await loopRun();
    const outOfWrites = recordWith(record, { implementation: loopSpending(record, 'writes', 8) });

    expect(loopBudgetOf(outOfWrites.implementation as ImplementationRecord).canReenter).toBe(false);
    expect(hasRoomIn({ stepsLeft: 9, writesLeft: 0, commandsLeft: 5 })).toBe(false);
    expect(hasRoomIn({ stepsLeft: 0, writesLeft: 6, commandsLeft: 5 })).toBe(false);

    expect(buildResumePlan(await snapshotOf(outOfWrites)).action).toBe('AWAIT_HUMAN');
  });

  it('carries no verdict in a budget', async () => {
    const budget = lifecycleBudgetOf(await loopRun());

    expect(JSON.stringify(budget)).not.toMatch(
      /CONTRIBUTION_READY|PASSED|SUCCESS|READY|HEALTH|SCORE|VERIFIED|DEFECT/i,
    );
  });
});

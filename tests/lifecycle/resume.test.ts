import { afterEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../src/core/errors.js';
import { acquireRunLock, readRunLock, runLockDirectory } from '../../src/lifecycle/lock.js';
import { buildResumePlan } from '../../src/lifecycle/resume-plan.js';
import { runResumeStage } from '../../src/lifecycle/resume.js';
import { runStatusStage } from '../../src/lifecycle/status.js';
import { runPrStage } from '../../src/pr/stage.js';
import { recordWith } from '../helpers/review.js';
import { plannedRun } from '../helpers/implement.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { reviewedRun } from '../helpers/repairRun.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';
import { hasGit } from '../helpers/git.js';
import type { LoopLimits } from '../../src/implement/limits.js';
import type { ImplementationRecord } from '../../src/implement/state.js';
import type { ResumePlan } from '../../src/lifecycle/resume-plan.js';
import type {
  ResumeBlock,
  ResumeRefusal,
  ResumeResult,
  ResumeStageDeps,
} from '../../src/lifecycle/resume.js';
import type { RunStore } from '../../src/state/run-store.js';
import type { RunRecord } from '../../src/state/run-record.js';
import type { MemoryRunStore } from '../helpers/github.js';

/**
 * What `resume` may act on, and what it refuses to do to itself.
 *
 * §14 defines the word by refusal: resuming means continuing from "the last safe,
 * factually recoverable boundary", and it explicitly does not mean "do whatever it
 * takes until PR". So every case here is built around a stage that is *offered* to
 * the service and a claim about whether it was allowed to run. The spy is the
 * evidence — a refusal that never reaches the spy is a refusal that happened, and a
 * tool that explains a boundary to a person and then steps over it is the exact
 * failure this command is supposed to prevent.
 *
 * Four properties carry the stage:
 *
 * - **Preview is the default** (§16, §18). Without `execute` no stage runs, no
 *   credential is needed, no lock is claimed, and the stored record comes back
 *   byte-identical. The plan is the whole output.
 * - **The plan is re-read before it is acted on** (§34). Execution builds a plan,
 *   takes the lock, then builds it again from a fresh observation and compares. A
 *   store that hands back a different record on the second read stands in for the
 *   world changing underneath, and the only honest answer is to stop.
 * - **A resume grants nothing** (§17). A missing repair approval, a missing
 *   publication approval, a loop that spent its bound: the service names the
 *   boundary and refuses to cross it, which is what separates this from a retry
 *   button. §19's rule is the arithmetic case — 3 of 12 steps spent buys nine steps
 *   of re-entry, and 12 of 12 buys a person rather than a fresh twelve.
 * - **The lock is held for the action and gone afterwards** (§41–§43, §53), including
 *   when the stage throws, because a lock left behind by a failed resume is a run
 *   nobody can resume again without reading a filesystem.
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

/** A run whose every stage is stored where `resume` will look for it. */
interface Where {
  readonly store: MemoryRunStore;
  readonly runsRoot: string;
  readonly record: RunRecord;
}

async function contractRun(): Promise<Where> {
  const prepared = await contractBackedRun(tempDirs);
  return { store: prepared.store, runsRoot: prepared.root, record: prepared.record };
}

async function loopRun(options: { readonly movePatchAfterPlan?: boolean } = {}): Promise<Where> {
  const fixture = await reviewedRun(tempDirs, options);
  return { store: fixture.store, runsRoot: fixture.runsRoot, record: fixture.record };
}

/** A run that has a plan and has never entered a loop. */
async function plannedWhere(): Promise<Where> {
  const run = await plannedRun(tempDirs);
  return {
    store: run.prepared.store,
    runsRoot: run.prepared.root,
    record: run.record,
  };
}

/** A run with a candidate page, optionally the one a person has approved by digest. */
async function proposedWhere(approve = false): Promise<Where> {
  const fixture = await proposedRun(tempDirs);
  const shown = await runPrStage(
    { runId: fixture.record.runId },
    { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
  );
  if (approve) {
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
  }
  return {
    store: fixture.store,
    runsRoot: fixture.runsRoot,
    record: await fixture.store.load(fixture.record.runId),
  };
}

/** The loop record with the way it ended restated. */
function stoppedAs(
  record: RunRecord,
  over: Partial<Pick<ImplementationRecord, 'status' | 'termination' | 'summary'>>,
): RunRecord {
  const implementation = record.implementation;
  if (!implementation) throw new Error('the fixture run has no loop record to stop');
  return recordWith(record, { implementation: { ...implementation, ...over } });
}

/** A loop the person interrupted at 3 of 12 steps, bounds otherwise untouched. */
function interrupted(record: RunRecord): RunRecord {
  return stoppedAs(record, {
    status: 'CANCELLED',
    termination: { kind: 'DEADLINE', detail: 'the human interrupted the loop' },
  });
}

/** The stage the service is told to run, recorded so a refusal can be proved. */
interface StageSpy {
  readonly calls: { plan: ResumePlan; limits: Partial<LoopLimits> | null }[];
  readonly executeStage: NonNullable<ResumeStageDeps['executeStage']>;
}

function spy(record: RunRecord): StageSpy {
  const calls: StageSpy['calls'] = [];
  return {
    calls,
    executeStage: async (plan, limits) => {
      calls.push({ plan, limits });
      return record;
    },
  };
}

/** The deps every case shares: a fixed clock, a fixed process, and the store to read. */
function deps(where: Where, extra: ResumeStageDeps = {}) {
  return {
    store: where.store,
    runsRoot: where.runsRoot,
    cwd: where.record.local?.toplevel ?? where.runsRoot,
    now: () => NOW,
    pid: PID,
    host: HOST,
    ...extra,
  };
}

function refusalOf(result: ResumeResult): ResumeRefusal {
  if (result.kind !== 'REFUSED') throw new Error(`resume ended as ${result.kind}, not a refusal`);
  return result.refusal;
}

function blockOf(result: ResumeResult): ResumeBlock {
  if (result.kind !== 'BLOCKED') throw new Error(`resume ended as ${result.kind}, not a block`);
  return result.block;
}

/** The words a stop came with — a refusal or a block, never a run that happened. */
function messageOf(result: ResumeResult): string {
  if (result.kind !== 'REFUSED' && result.kind !== 'BLOCKED') {
    throw new Error(`resume ended as ${result.kind}, so it stopped without refusing anything`);
  }
  return result.message;
}

function recordOf(result: ResumeResult): RunRecord {
  if (result.kind !== 'RAN') throw new Error(`resume ended as ${result.kind}, not a stage run`);
  return result.record;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** The record exactly as the store holds it now, for a "nothing was written" claim. */
async function stored(where: Where): Promise<string> {
  return JSON.stringify(await where.store.load(where.record.runId));
}

describe.skipIf(!AVAILABLE)('what a resume may act on', () => {
  it('shows the plan and runs no stage when nobody asks for execution', async () => {
    const where = await contractRun();
    const before = await stored(where);
    const stage = spy(where.record);

    const result = await runResumeStage({ runId: where.record.runId }, deps(where, stage));

    expect(result.kind).toBe('PREVIEW');
    expect(result.plan.action).toBe('CREATE_PLAN');
    expect(stage.calls).toHaveLength(0);
    expect(await stored(where)).toBe(before);
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('states the model cost in a preview that needs no credential to make', async () => {
    const where = await contractRun();
    const stage = spy(where.record);

    const { plan } = await runResumeStage({ runId: where.record.runId }, deps(where, stage));

    expect(plan.requiresModel).toBe(true);
    expect(plan.requiresCredential).toBe(true);
    expect(stage.calls).toHaveLength(0);
  });

  it('hands the plan the same digest a status screen reads from the same facts', async () => {
    const where = await contractRun();
    const stage = spy(where.record);

    const { plan } = await runResumeStage({ runId: where.record.runId }, deps(where, stage));
    const { snapshot } = await runStatusStage(
      { runId: where.record.runId },
      {
        store: where.store,
        runsRoot: where.runsRoot,
        cwd: where.record.local?.toplevel ?? where.runsRoot,
        now: () => NOW,
      },
    );

    expect(plan.observedStateDigest).toBe(buildResumePlan(snapshot).observedStateDigest);
  });

  it('runs the stage the plan names when the person says execute', async () => {
    const where = await plannedWhere();
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.kind).toBe('RAN');
    expect(stage.calls).toHaveLength(1);
    expect(stage.calls[0]?.plan.action).toBe('RUN_IMPLEMENTATION_LOOP');
    // No loop has spent anything, so this is a first entry and the shipped bounds are
    // the honest ones; a residual would be invented history.
    expect(stage.calls[0]?.limits).toBeNull();
    expect(recordOf(result).runId).toBe(where.record.runId);
  });

  it('hands a continued loop the steps the interrupted one left, not a fresh bound', async () => {
    const where = await loopRun();
    await where.store.save(interrupted(where.record));
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.plan.action).toBe('CONTINUE_IMPLEMENTATION');
    expect(stage.calls).toHaveLength(1);
    expect(stage.calls[0]?.limits).toEqual({
      maxSteps: 9,
      maxWrites: 6,
      maxCommands: 5,
      maxRepeatedFailures: 3,
    });
  });

  it('refuses to re-enter a loop whose bound stopped it, quoting what was spent', async () => {
    const where = await loopRun();
    const implementation = where.record.implementation as ImplementationRecord;
    await where.store.save(
      stoppedAs(where.record, {
        status: 'CANCELLED',
        termination: { kind: 'MAX_STEPS', detail: 'the step bound was reached' },
        summary: { ...implementation.summary, steps: implementation.limits.maxSteps },
      }),
    );
    const before = await stored(where);
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.kind).toBe('REFUSED');
    // The plan is the single place this is decided: a loop that ended on its bound is
    // not offered as a continuation at all, so resume has no loop action to run and no
    // fresh bound to imply. §19 holds without a second budget check here, and the
    // numbers are the plan's own sentence rather than one this file invented.
    expect(refusalOf(result)).toBe('AWAIT_HUMAN');
    expect(result.plan.reason).toMatch(/12 of 12 steps/);
    expect(`${result.plan.reason} ${messageOf(result)}`).not.toMatch(
      /fresh|another 12|increase|reset/i,
    );
    expect(stage.calls).toHaveLength(0);
    expect(await stored(where)).toBe(before);
  });

  it('stops at a repair approval no person has given', async () => {
    const where = await loopRun();
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.plan.action).toBe('REPAIR_PLAN_APPROVAL_REQUIRED');
    expect(result.kind).toBe('REFUSED');
    expect(refusalOf(result)).toBe('CAPABILITY_REQUIRED');
    expect(messageOf(result)).not.toMatch(/already approved|granted|fabricat/);
    expect(stage.calls).toHaveLength(0);
  });

  it('stops at the page nobody approved and names no remote of any kind', async () => {
    const where = await proposedWhere();
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.plan.action).toBe('PUBLICATION_APPROVAL_REQUIRED');
    expect(result.kind).toBe('REFUSED');
    expect(refusalOf(result)).toBe('CAPABILITY_REQUIRED');
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(/publish|push|opened|merged|remote/);
    expect(stage.calls).toHaveLength(0);
  });

  it('treats an approved page as a boundary reached, not a success to act on', async () => {
    const where = await proposedWhere(true);
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.kind).toBe('REFUSED');
    expect(refusalOf(result)).toBe('NOTHING_TO_RESUME');
    expect(stage.calls).toHaveLength(0);
  });

  it('routes a loop that stopped by asking for a person to that person', async () => {
    const where = await loopRun();
    await where.store.save(
      stoppedAs(where.record, {
        status: 'NEEDS_HUMAN_REVIEW',
        termination: { kind: 'MODEL_BLOCKED', detail: 'the loop said it needs a person' },
      }),
    );
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(result.plan.action).toBe('AWAIT_HUMAN');
    expect(result.kind).toBe('REFUSED');
    expect(refusalOf(result)).toBe('AWAIT_HUMAN');
    expect(stage.calls).toHaveLength(0);
  });

  it('holds the run for the length of the action and gives it back afterwards', async () => {
    const where = await contractRun();
    const inside: string[] = [];
    const stage: StageSpy = {
      calls: [],
      executeStage: async () => {
        const held = await readRunLock(
          { runId: where.record.runId },
          { runsRoot: where.runsRoot },
        );
        inside.push(held.state);
        if (held.state === 'HELD') {
          inside.push(String(held.holding.owner?.pid), held.holding.owner?.operation ?? 'none');
        }
        return where.record;
      },
    };

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, stage),
    );

    expect(inside).toEqual(['HELD', String(PID), 'resume']);
    expect(result.kind).toBe('RAN');
    if (result.kind === 'RAN') expect(result.lockReleased).toBe(true);
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('will not act on a run another live process is holding', async () => {
    const where = await contractRun();
    const other = await acquireRunLock(
      { runId: where.record.runId },
      { runsRoot: where.runsRoot, pid: 5151, host: HOST, now: () => NOW },
    );
    expect(other.state).toBe('ACQUIRED');
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      deps(where, {
        executeStage: stage.executeStage,
        isProcessAlive: () => true,
      }),
    );

    expect(result.kind).toBe('BLOCKED');
    expect(blockOf(result)).toBe('LOCK_HELD');
    expect(stage.calls).toHaveLength(0);
    const stillHeld = await readRunLock(
      { runId: where.record.runId },
      { runsRoot: where.runsRoot },
    );
    expect(stillHeld.state).toBe('HELD');
    if (stillHeld.state === 'HELD') expect(stillHeld.holding.owner?.pid).toBe(5151);
  });

  it('refuses to act on a run that was not the one it planned for', async () => {
    const where = await contractRun();
    const first = await where.store.load(where.record.runId);
    const moved = recordWith(first, { stage: 'verify' });
    let reads = 0;
    const store: RunStore = {
      save: (record) => where.store.save(record),
      load: async (runId) => {
        reads += 1;
        return reads === 1 ? first : moved;
      },
      list: () => where.store.list(),
    };
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      { ...deps(where, stage), store },
    );

    expect(result.kind).toBe('BLOCKED');
    expect(blockOf(result)).toBe('STATE_CHANGED');
    expect(stage.calls).toHaveLength(0);
  });

  it('refuses an execution whose preview digest is not the one it was given', async () => {
    const where = await contractRun();
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true, expectedObservedStateDigest: 'f'.repeat(64) },
      deps(where, stage),
    );

    expect(result.kind).toBe('BLOCKED');
    expect(blockOf(result)).toBe('STATE_CHANGED');
    expect(messageOf(result)).toMatch(/digest|changed|no longer/i);
    expect(stage.calls).toHaveLength(0);
  });

  it('leaves no lock behind when the stage it was told to run fails', async () => {
    const where = await contractRun();
    const stage: StageSpy = {
      calls: [],
      executeStage: async () => {
        throw new AppError({ kind: 'config', message: 'no BharatCode credential is configured' });
      },
    };

    await expect(
      runResumeStage({ runId: where.record.runId, execute: true }, deps(where, stage)),
    ).rejects.toThrow(AppError);

    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('says it has no way to act rather than inventing one', async () => {
    const where = await contractRun();

    const result = await runResumeStage({ runId: where.record.runId, execute: true }, deps(where));

    expect(result.kind).toBe('BLOCKED');
    expect(blockOf(result)).toBe('NO_EXECUTOR');
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('reports a workspace that cannot be observed as a block, before claiming anything', async () => {
    const where = await loopRun({ movePatchAfterPlan: true });
    await where.store.save(
      recordWith(where.record, {
        local: where.record.local ? { ...where.record.local, toplevel: where.runsRoot } : null,
      }),
    );
    const stage = spy(where.record);

    const result = await runResumeStage(
      { runId: where.record.runId, execute: true },
      { ...deps(where, stage), cwd: path.join(where.runsRoot, 'nowhere-at-all') },
    );

    expect(result.plan.action).toBe('RECOVERY_BLOCKED');
    expect(result.kind).toBe('BLOCKED');
    expect(blockOf(result)).toBe('WORKSPACE_BLOCKED');
    expect(stage.calls).toHaveLength(0);
    expect(await exists(runLockDirectory(where.runsRoot, where.record.runId))).toBe(false);
  });

  it('carries no verdict in a resume result', async () => {
    const where = await contractRun();
    const result = await runResumeStage(
      { runId: where.record.runId },
      deps(where, spy(where.record)),
    );

    expect(JSON.stringify(result)).not.toMatch(
      /CONTRIBUTION_READY|PR ready|PASSED|SUCCESS|VERIFIED|DEFECT|published|pushed/i,
    );
  });
});

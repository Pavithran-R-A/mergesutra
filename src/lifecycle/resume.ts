import type { Runner } from '../core/runner.js';
import type { LoopLimits } from '../implement/limits.js';
import { defaultRunStoreRoot, createFileRunStore, type RunStore } from '../state/run-store.js';
import type { RunRecord } from '../state/run-record.js';
import { loopBudgetOf } from './budget.js';
import { acquireRunLock, releaseRunLock, type RunLockDeps } from './lock.js';
import { buildResumePlan, type ResumeAction, type ResumePlan } from './resume-plan.js';
import { runStatusStage } from './status.js';

/**
 * The service behind `mergesutra resume`: plan first, act only when told, and grant
 * nothing on the way.
 *
 * §14 defines this command by what it is *not*. Resuming means continuing from the
 * last safe, factually recoverable boundary; it does not mean "do whatever it takes
 * until PR", and a person typing `resume` has not thereby given execution consent,
 * repair approval, publication approval, remote permission or a credential. So the
 * whole of this file is a sequence of gates in front of one call — the call that
 * runs a stage — and every gate answers a question the plan can already answer.
 *
 * The order is the design:
 *
 * 1. **Read the plan before touching anything.** `runStatusStage` is read-only and
 *    `buildResumePlan` is arithmetic over it, so a preview costs a disk read and some
 *    Git questions and nothing else. §18 is satisfied by construction: no model client
 *    is constructed on this path, so a preview cannot spend a request even by accident,
 *    and it needs no credential to print that a credential would be needed.
 * 2. **Refuse on the plan's own words.** A blocker, a spent-out loop, a boundary that
 *    the plan itself names as needing somebody's approval — all of these are refusals,
 *    and they happen *before* the lock is claimed, because refusing costs nothing and
 *    a lock held to say "no" is a run nobody else can work on.
 * 3. **Claim the run.** One lifecycle mutation per run, on the filesystem, through
 *    `lock.ts`. Holding it authorises nothing beyond the exclusion (§14): it is not a
 *    capability.
 * 4. **Re-read and compare, immediately before acting.** §34 asks for exactly this
 *    shape and warns off inventing a UX for it: the plan is rebuilt from a fresh
 *    observation and its `observedStateDigest` compared against the one previewed. The
 *    digest covers every fact the plan was read from except the moment they were read,
 *    so equality is not a guess that the state held — it is the same claim a preview
 *    makes about itself. A caller that has the digest a person actually saw may pass it
 *    in, which turns the cross-process case into the same comparison.
 * 5. **Hand the stage the bounds that are left, not the bounds that were used.** The
 *    loop axes come from `budget.ts`, so a resumed entry is measured against what the
 *    entry before it spent (§19) rather than being re-defaulted, which is how a
 *    recovery tool ends up buying twice the autonomy.
 *
 * Two things this file deliberately does not do. It never writes a run record — every
 * save belongs to the stage being resumed, so "resume edited the evidence" has no path
 * — and it never dispatches a stage itself. `src/lifecycle` has no view of the command
 * layer, so the executor arrives as an injected dependency and this module's job is to
 * decide whether it may be called, with what limits, and under what lock. That is also
 * what makes the refusals testable: a refusal that never reaches the executor is a
 * refusal that really happened.
 */

export interface ResumeStageInput {
  /** Omitted means the store's newest run, by `status`'s own rule. */
  readonly runId?: string;
  /** A checkout a person pointed at instead of the one the record names. */
  readonly repo?: string;
  /** Absent or false means preview only — §16's default, and the only safe one. */
  readonly execute?: boolean;
  /** The digest the preview printed, when the caller has it. A mismatch is a block. */
  readonly expectedObservedStateDigest?: string;
}

export interface ResumeStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly runsRoot?: string;
  readonly run?: Runner;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly host?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  /**
   * The stage the plan names, supplied by the command layer.
   *
   * `limits` is non-null only for an action that re-enters the implementation loop,
   * and it is then the residual of the entry that last ran — never a fresh default.
   */
  readonly executeStage?: (
    plan: ResumePlan,
    limits: Partial<LoopLimits> | null,
  ) => Promise<RunRecord>;
}

export type ResumeRefusal = 'CAPABILITY_REQUIRED' | 'AWAIT_HUMAN' | 'NOTHING_TO_RESUME';

export type ResumeBlock = 'WORKSPACE_BLOCKED' | 'LOCK_HELD' | 'STATE_CHANGED' | 'NO_EXECUTOR';

export type ResumeResult =
  | { readonly kind: 'PREVIEW'; readonly plan: ResumePlan }
  | {
      readonly kind: 'RAN';
      readonly plan: ResumePlan;
      readonly record: RunRecord;
      readonly lockReleased: boolean;
    }
  | {
      readonly kind: 'REFUSED';
      readonly plan: ResumePlan;
      readonly refusal: ResumeRefusal;
      readonly message: string;
    }
  | {
      readonly kind: 'BLOCKED';
      readonly plan: ResumePlan;
      readonly block: ResumeBlock;
      readonly message: string;
    };

/** The two actions that spend a loop's bounds, and therefore need residual ones. */
const LOOP_ACTIONS: readonly ResumeAction[] = [
  'RUN_IMPLEMENTATION_LOOP',
  'CONTINUE_IMPLEMENTATION',
];

export async function runResumeStage(
  input: ResumeStageInput = {},
  deps: ResumeStageDeps = {},
): Promise<ResumeResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const runsRoot = deps.runsRoot ?? defaultRunStoreRoot(cwd);
  const now = deps.now ?? (() => new Date());
  const lock: RunLockDeps = {
    runsRoot,
    cwd,
    now,
    ...(deps.pid === undefined ? {} : { pid: deps.pid }),
    ...(deps.host === undefined ? {} : { host: deps.host }),
    ...(deps.isProcessAlive === undefined ? {} : { isProcessAlive: deps.isProcessAlive }),
  };

  const previewed = await planOf(input, {
    store,
    runsRoot,
    cwd,
    now,
    ...(deps.run ? { run: deps.run } : {}),
  });
  if (!input.execute) return { kind: 'PREVIEW', plan: previewed.plan };

  if (previewed.plan.action === 'RECOVERY_BLOCKED') {
    return {
      kind: 'BLOCKED',
      plan: previewed.plan,
      block: 'WORKSPACE_BLOCKED',
      message:
        'Nothing runs, because the status screen already reports a fact no command can clear by ' +
        'being attempted. Recovery does not work around a blocker: it would destroy the evidence ' +
        'this run is made of before it produced anything you could look at.',
    };
  }

  const refusal = capabilityRefusal(previewed.plan);
  if (refusal) return { kind: 'REFUSED', plan: previewed.plan, ...refusal };

  const executeStage = deps.executeStage;
  if (!executeStage) {
    return {
      kind: 'BLOCKED',
      plan: previewed.plan,
      block: 'NO_EXECUTOR',
      message:
        'This call has no stage to run, so it runs nothing. A resume that could not reach the ' +
        'command layer would be a resume that invents one, and inventing a way past the boundary ' +
        'is the failure this command exists to prevent.',
    };
  }

  const acquired = await acquireRunLock({ runId: previewed.plan.runId }, lock);
  if (acquired.state === 'BLOCKED') {
    return {
      kind: 'BLOCKED',
      plan: previewed.plan,
      block: 'LOCK_HELD',
      message: `${acquired.message} Nothing was claimed, changed or removed about it.`,
    };
  }

  let released = false;
  const release = async (): Promise<boolean> => {
    released = true;
    return (await releaseRunLock(acquired.handle)).state === 'RELEASED';
  };

  try {
    const current = await planOf(input, {
      store,
      runsRoot,
      cwd,
      now,
      ...(deps.run ? { run: deps.run } : {}),
    });
    const digest = current.plan.observedStateDigest;
    if (digest !== previewed.plan.observedStateDigest) {
      return {
        kind: 'BLOCKED',
        plan: current.plan,
        block: 'STATE_CHANGED',
        message:
          'The observed state changed between the plan and the action, so the plan a person was ' +
          'shown is no longer the plan this command would carry out. It is left unexecuted rather ' +
          'than adjusted, because adjusting mid-flight is how a recovery tool ends up doing work ' +
          'nobody previewed.',
      };
    }
    if (
      input.expectedObservedStateDigest !== undefined &&
      input.expectedObservedStateDigest !== digest
    ) {
      return {
        kind: 'BLOCKED',
        plan: current.plan,
        block: 'STATE_CHANGED',
        message:
          `The digest this execution was given does not match the state now on disk (${digest}). ` +
          'Run `mergesutra resume` again to read the current plan, and execute that one.',
      };
    }

    // Equal digests mean the plan, the record and the bounds are the ones previewed: the
    // digest covers every fact the plan was read from except when they were read.
    const limits = residualLimits(current.plan.action, current.record);
    const record = await executeStage(current.plan, limits);
    return { kind: 'RAN', plan: current.plan, record, lockReleased: await release() };
  } finally {
    if (!released) await releaseRunLock(acquired.handle);
  }
}

interface PlanReading {
  readonly plan: ResumePlan;
  readonly record: RunRecord;
}

/**
 * One read of the run the way `status` reads it, and the plan that follows from it.
 *
 * The record is loaded beside the snapshot rather than taken from it because the
 * snapshot reports a loop's spend, not the bounds that were never recorded, and a
 * resumed loop has to be bounded by the whole of what the last entry was given.
 */
async function planOf(
  input: ResumeStageInput,
  deps: { store: RunStore; runsRoot: string; cwd: string; now: () => Date; run?: Runner },
): Promise<PlanReading> {
  const { runId, snapshot } = await runStatusStage(
    { ...(input.runId ? { runId: input.runId } : {}), ...(input.repo ? { repo: input.repo } : {}) },
    {
      store: deps.store,
      runsRoot: deps.runsRoot,
      cwd: deps.cwd,
      now: deps.now,
      ...(deps.run ? { run: deps.run } : {}),
    },
  );
  return { plan: buildResumePlan(snapshot), record: await deps.store.load(runId) };
}

/**
 * The bounds a re-entered loop is given, which are the ones left over (§19).
 *
 * `null` means "not a loop action", and the loop action with no room left never
 * reaches here: the plan has already turned that run into `AWAIT_HUMAN`, so the only
 * way to a residual set of limits is a set that actually has room in it. Handing a
 * spent loop a fresh default would be the doubling of autonomy that this whole
 * subsystem exists to make impossible.
 */
function residualLimits(action: ResumeAction, record: RunRecord): Partial<LoopLimits> | null {
  if (!LOOP_ACTIONS.includes(action) || !record.implementation) return null;
  return loopBudgetOf(record.implementation).resumedLimits;
}

/**
 * The boundaries a resume may name but not cross (§17).
 *
 * The plan already carries these as its own vocabulary, so this is a translation of
 * `requiresRepairApproval`, `requiresPublicationApproval`, and the two actions that
 * mean "a person is the next step" — not a second opinion about them. Wording stays
 * inside the build: no message here mentions a remote, a push or a publication,
 * because there is no publisher in this stage to describe.
 */
function capabilityRefusal(plan: ResumePlan): { refusal: ResumeRefusal; message: string } | null {
  if (plan.requiresRepairApproval || plan.requiresPublicationApproval) {
    return {
      refusal: 'CAPABILITY_REQUIRED',
      message:
        'The next step belongs to a person, not to this command: the plan reaches a boundary that ' +
        'needs a decision it does not hold. `resume` cannot make that decision on the way past it, ' +
        'so it stops here and leaves the run exactly as the status screen describes it.',
    };
  }
  if (plan.action === 'AWAIT_HUMAN') {
    return {
      refusal: 'AWAIT_HUMAN',
      message:
        'This run is waiting on a human decision, and a decision is not something a resume can ' +
        'manufacture by re-asking the question. The plan names what is outstanding; acting on it ' +
        'would spend a request to produce the same sentence.',
    };
  }
  if (plan.action === 'NOTHING_TO_RESUME') {
    return {
      refusal: 'NOTHING_TO_RESUME',
      message:
        'There is nothing left for this build to do. The run has reached the last boundary this ' +
        'stage knows about, and reaching it is not the same as going past it.',
    };
  }
  return null;
}

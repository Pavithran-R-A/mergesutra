import { DEFAULT_LIMITS, type LoopLimits } from '../implement/limits.js';
import type { ImplementationRecord } from '../implement/state.js';
import { MAX_REPAIR_CYCLES_CEILING, MAX_REVIEW_CYCLES_CEILING } from '../repair/bounds.js';
import type { RunRecord } from '../state/run-record.js';

/**
 * What a run has left, measured from what it already spent — Stage 11.
 *
 * An agent loop's spend is the one thing a recovery tool can get wrong twice over:
 * first by handing a resumed loop the shipped defaults as though nothing had been
 * bought (`If 8/12 steps were already spent: resume does not get another 12 as
 * though it were a new task`), and then by hiding the mistake, because a loop that
 * ends on its own bound and a loop restarted at full price both leave a record that
 * looks finished. So this module holds the subtraction and nothing else decides.
 *
 * **Cumulative, with no new state to keep.** The bound a loop was given and the
 * count of what it spent are already recorded together (`implementation.limits`,
 * `implementation.summary`), and a second entry writes both again. That makes the
 * carried allowance self-sustaining: entry two is bounded by entry one's *leftover*,
 * so the axis can never be spent past the number the run started with, and no
 * lifetime ledger has to exist. `resumedLimits` is what a caller passes on the way
 * back in; `maxSteps` in the record after that is the residual, which is the fact
 * the limitations below exist to make legible.
 *
 * **The arithmetic lives here alone.** `hasRoomIn` is the re-entry rule, exported so
 * the resume plan and this module cannot drift into answering the same question
 * differently — a plan that promises a loop the budget module then refuses is a
 * preview that lies.
 *
 * **Only what the record can prove is a bound.** Stage 6 records four axes and
 * counts spend on three of them; the other eight knobs it was given are nowhere in
 * the document, so they are named in {@link LoopBudget.notCarried} rather than
 * assumed carried. Cycle numbers come from the plan and the executions that claimed
 * them, measured against the ceilings no caller may raise — a run's own lowered
 * cycle limit is not recorded either. Where the data cannot support an accounting,
 * this says so instead of defaulting the gap shut: doubling a run's autonomy by
 * reading a missing number as zero spent is the exact failure the whole module
 * exists to prevent.
 *
 * This module decides nothing and writes nothing. It reads a record and subtracts.
 */

/** The axes a loop both bounded and spent, so a residual means something. */
const COUNTED_AXES = ['maxSteps', 'maxWrites', 'maxCommands'] as const;

/** The bounds a loop records; `maxRepeatedFailures` is bounded but never counted. */
const RECORDED_BOUNDS: readonly (keyof LoopLimits)[] = [...COUNTED_AXES, 'maxRepeatedFailures'];

export interface AxisAllowance {
  /** What the entry was bounded at, read from the record. */
  readonly bound: number;
  readonly spent: number;
  /**
   * Bound minus spend, and *not* clamped.
   *
   * A record that spent past its bound is a contradiction worth seeing, and
   * turning -1 into 0 would hide it while leaving the answer unchanged.
   */
  readonly left: number;
}

/** The three numbers a re-entry decision reads. */
export interface ReentryRoom {
  readonly stepsLeft: number;
  readonly writesLeft: number;
  readonly commandsLeft: number;
}

export interface LoopBudget {
  readonly steps: AxisAllowance;
  readonly writes: AxisAllowance;
  readonly commands: AxisAllowance;
  /** Carried whole: bounded by the record, with no count of how often it fired. */
  readonly repeatedFailures: number;
  readonly room: ReentryRoom;
  readonly canReenter: boolean;
  /**
   * The limits a continued entry is given, or null when it may not be continued.
   *
   * Null rather than a clamped one: an axis with nothing left cannot be handed over
   * as `1`, because the only reason `1` would be there is to make the call site
   * simpler, and a loop restarted at a minimum is still a loop restarted.
   */
  readonly resumedLimits: Partial<LoopLimits> | null;
  /** Bounds this record never named, so a resumed entry gets the default again. */
  readonly notCarried: readonly (keyof LoopLimits)[];
}

export interface CycleAllowance {
  readonly used: number;
  /** The ceiling no caller may raise, which is not the limit this run ran under. */
  readonly ceiling: number;
  readonly left: number;
}

export interface LifecycleBudget {
  /** Null until a loop has run: there is no spend to carry into a first entry. */
  readonly loop: LoopBudget | null;
  readonly reviewCycles: CycleAllowance;
  readonly repairCycles: CycleAllowance;
  /** What the record cannot prove, stated instead of assumed away. */
  readonly limitations: readonly string[];
}

/** A loop may be entered again only with room on every axis it will be given. */
export function hasRoomIn(room: ReentryRoom): boolean {
  return room.stepsLeft > 0 && room.writesLeft > 0 && room.commandsLeft > 0;
}

export function loopBudgetOf(implementation: ImplementationRecord): LoopBudget {
  const steps = axis(implementation.limits.maxSteps, implementation.summary.steps);
  const writes = axis(implementation.limits.maxWrites, implementation.summary.writes);
  const commands = axis(implementation.limits.maxCommands, implementation.summary.commands);
  const room: ReentryRoom = {
    stepsLeft: steps.left,
    writesLeft: writes.left,
    commandsLeft: commands.left,
  };
  const canReenter = hasRoomIn(room);

  return {
    steps,
    writes,
    commands,
    repeatedFailures: implementation.limits.maxRepeatedFailures,
    room,
    canReenter,
    resumedLimits: canReenter
      ? {
          maxSteps: steps.left,
          maxWrites: writes.left,
          maxCommands: commands.left,
          maxRepeatedFailures: implementation.limits.maxRepeatedFailures,
        }
      : null,
    notCarried: (Object.keys(DEFAULT_LIMITS) as (keyof LoopLimits)[]).filter(
      (key) => !RECORDED_BOUNDS.includes(key),
    ),
  };
}

export function lifecycleBudgetOf(record: RunRecord): LifecycleBudget {
  const loop = record.implementation ? loopBudgetOf(record.implementation) : null;
  const executions = record.repairExecutions;
  const reviewCycles = cycle(
    highest(
      record.repairPlan?.reviewCycle,
      executions.map((item) => item.reviewCycle),
    ),
    MAX_REVIEW_CYCLES_CEILING,
  );
  const repairCycles = cycle(
    highest(
      record.repairPlan?.repairCycle,
      executions.map((item) => item.repairCycle),
    ),
    MAX_REPAIR_CYCLES_CEILING,
  );

  return {
    loop,
    reviewCycles,
    repairCycles,
    limitations: [
      ...(loop
        ? [
            "BUDGET-LINEAGE: the bound a continued loop is given replaces the bound in its record, so what a record shows is one entry of spending against that entry's allowance — not a lifetime total across every time this run was entered.",
            `BUDGET-UNRECORDED: ${loop.notCarried.join(', ')} were never bounded in this record, so a continued loop is given the shipped default for each of them again. Only steps, writes and check runs are carried down.`,
          ]
        : []),
      "BUDGET-CEILING: cycles are measured against the ceilings no caller may raise, because a run's own cycle limit is never recorded. A cycle number left here is a maximum, not a promise that this run still holds it.",
      "BUDGET-ATTEMPTS: a review's round trips are written on the review document and replaced by the next one, and a review interrupted before it files anything leaves no count of the attempt at all. Nothing here can say how many times this patch has been asked about.",
    ],
  };
}

function axis(bound: number, spent: number): AxisAllowance {
  return { bound, spent, left: bound - spent };
}

function cycle(used: number, ceiling: number): CycleAllowance {
  return { used, ceiling, left: ceiling - used };
}

function highest(current: number | undefined, claimed: readonly number[]): number {
  return Math.max(current ?? 0, ...claimed);
}

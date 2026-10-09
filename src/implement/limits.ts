import { AppError } from '../core/errors.js';

/**
 * The bounds on one implementation loop — Stage 6.
 *
 * An agent loop's default failure mode is not a wrong answer, it is never
 * finishing: a model that keeps asking for one more file, or keeps re-running
 * the check that keeps failing, turns a paid API into a bill and a reviewable
 * run into a pile of nothing. So every axis of growth has a number beside it,
 * the numbers are small on purpose, and hitting one is a *reported outcome* —
 * state persisted, worktree preserved, a truthful `BLOCKED` /
 * `NEEDS_HUMAN_REVIEW` — rather than an error that loses the run.
 *
 * The caps are enforced in code (`resolveLimits`), not left to a config file,
 * because "the operator can raise the limit to anything" is how a bounded loop
 * becomes unbounded. Raising a default means changing this file.
 */

export interface LoopLimits {
  /** Model round trips, including the one that finishes. */
  readonly maxSteps: number;
  /** Successful WRITE_FILE actions. Refused writes count too — see `maxRefusals`. */
  readonly maxWrites: number;
  /** RUN_CHECK actions that reach the runner. */
  readonly maxCommands: number;
  /** Refused actions before the loop gives up on a model that will not adjust. */
  readonly maxRefusals: number;
  /**
   * Identical consecutive actions the loop tolerates. The key is the action's
   * structure plus what it actually returned, so this is "the model did the same
   * thing again and nothing changed" — the first repeat is answered with a
   * warning, and the run ends at this count.
   */
  readonly maxRepeatedFailures: number;
  /**
   * Consecutive rejected answers, not a tally for the run. A usable action in
   * between resets the count, because the model answered and the run gained
   * information; `maxSteps` bounds the spend whichever way the turns go. More
   * refusals than this in a row is cost with no information.
   */
  readonly maxSchemaRepairs: number;
  /** Files the initial context may carry. */
  readonly maxContextFiles: number;
  /** Total bytes of repository text in one request. */
  readonly maxContextBytes: number;
  /** Characters accepted from one model turn before it is refused as too large. */
  readonly maxModelOutputChars: number;
  readonly commandTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
  /** Wall-clock ceiling for the whole loop, on top of the step count. */
  readonly loopDeadlineMs: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  maxSteps: 12,
  maxWrites: 6,
  maxCommands: 4,
  maxRefusals: 4,
  maxRepeatedFailures: 3,
  maxSchemaRepairs: 1,
  maxContextFiles: 6,
  maxContextBytes: 48 * 1024,
  maxModelOutputChars: 96 * 1024,
  commandTimeoutMs: 60_000,
  maxCommandOutputBytes: 128 * 1024,
  loopDeadlineMs: 8 * 60_000,
};

/**
 * Ceiling per knob. A "sensible" larger run is a sequence of runs — each with
 * its own persisted record — not one loop with no exit.
 */
export const LIMIT_CAPS: LoopLimits = {
  maxSteps: 40,
  maxWrites: 20,
  maxCommands: 15,
  maxRefusals: 20,
  maxRepeatedFailures: 5,
  maxSchemaRepairs: 2,
  maxContextFiles: 25,
  maxContextBytes: 256 * 1024,
  maxModelOutputChars: 256 * 1024,
  commandTimeoutMs: 300_000,
  maxCommandOutputBytes: 1024 * 1024,
  loopDeadlineMs: 20 * 60_000,
};

export function resolveLimits(overrides: Partial<LoopLimits> = {}): LoopLimits {
  const limits = { ...DEFAULT_LIMITS, ...defined(overrides) };
  for (const [key, value] of Object.entries(limits) as [keyof LoopLimits, number][]) {
    if (!Number.isFinite(value) || value < 1) {
      throw new AppError({
        kind: 'validation',
        message: `Loop limit ${key} must be a positive number; got ${value}.`,
        remediation: 'Omit the limit to use the default, or pass a smaller number.',
      });
    }
    if (value > LIMIT_CAPS[key]) {
      throw new AppError({
        kind: 'validation',
        message: `Loop limit ${key}=${value} exceeds the MergeSutra ceiling of ${LIMIT_CAPS[key]}.`,
        remediation:
          'The loop stays bounded by design. Split the work into several runs instead of raising the ceiling.',
      });
    }
  }
  return limits;
}

function defined(overrides: Partial<LoopLimits>): Partial<LoopLimits> {
  const out: { -readonly [K in keyof LoopLimits]?: LoopLimits[K] } = {};
  for (const [key, value] of Object.entries(overrides) as [
    keyof LoopLimits,
    number | undefined,
  ][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

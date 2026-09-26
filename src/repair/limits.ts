import { AppError } from '../core/errors.js';
import { DEFAULT_LIMITS, type LoopLimits } from '../implement/limits.js';

/**
 * The bounds on one repair cycle — Stage 9R.
 *
 * A repair loop is the more dangerous of the two editing paths this product has.
 * Stage 6 starts from nothing and is expected to explore; Stage 9R starts from a
 * patch that already exists, a set of receipts that already describe it, and a
 * reviewer's list of what to change. An agent handed a diff and suggestions can
 * keep doing useful-looking work for a very long time, and every extra write
 * makes the evidence the run is being judged on older. So the budget here is
 * below Stage 6's default on every axis, and the three that grow a diff — steps,
 * writes, commands — are capped at single digits.
 *
 * The other difference from `implement/limits.ts` is what happens when a caller
 * asks for more. There, over the ceiling is an error, because a raised limit is
 * a decision about a run the operator is planning. Here it is a clamp: a repair
 * that requests forty steps is not refused, it is run with eight, and the record
 * says eight. Refusing would lose a cycle a human already approved, and the
 * approved thing was the plan's scope — not a bigger budget than this file has.
 */

const KEYS = Object.keys(DEFAULT_LIMITS) as (keyof LoopLimits)[];

/**
 * The strictest a repair loop may ever be, however it is asked.
 *
 * Every number is at or below Stage 6's *default*, which is what makes a repair
 * cycle strictly narrower than an implementation cycle rather than merely
 * differently-shaped.
 */
export const REPAIR_LIMIT_CEILINGS: LoopLimits = {
  maxSteps: 8,
  maxWrites: 4,
  maxCommands: 3,
  maxRefusals: 2,
  maxRepeatedFailures: 2,
  maxSchemaRepairs: 1,
  maxContextFiles: 4,
  maxContextBytes: 24 * 1024,
  maxModelOutputChars: 64 * 1024,
  commandTimeoutMs: 30_000,
  maxCommandOutputBytes: 64 * 1024,
  loopDeadlineMs: 4 * 60_000,
};

/** What a repair cycle gets when nobody asks for anything. */
export const REPAIR_DEFAULT_LIMITS: LoopLimits = {
  ...REPAIR_LIMIT_CEILINGS,
  maxSteps: 6,
  maxWrites: 3,
  maxCommands: 2,
};

/**
 * Clamp a requested repair budget into the only range a repair may occupy.
 *
 * A value that is not a positive whole number is an error rather than something
 * to clamp: `maxSteps: 0` is not "a small loop", it is a loop that cannot run,
 * and silently turning it into 1 would hide the caller's mistake.
 */
export function resolveRepairLimits(overrides: Partial<LoopLimits> = {}): LoopLimits {
  const limits = { ...REPAIR_DEFAULT_LIMITS } as { -readonly [K in keyof LoopLimits]: number };

  for (const key of KEYS) {
    const requested = overrides[key];
    if (requested === undefined) continue;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new AppError({
        kind: 'validation',
        message:
          `Repair loop limit ${key} must be a whole number from 1 to ` +
          `${String(REPAIR_LIMIT_CEILINGS[key])}; got ${String(requested)}.`,
        remediation:
          'Omit the limit to use the repair default, or pass a smaller number. A repair budget ' +
          'cannot be raised past its ceiling by a flag.',
      });
    }
    // Clamped by two ceilings, not one: this file's own, and Stage 6's *default*.
    // The second is what makes a repair cycle strictly narrower than an
    // implementation cycle rather than merely differently-shaped, and it keeps
    // holding if a default there is ever lowered.
    limits[key] = Math.min(requested, REPAIR_LIMIT_CEILINGS[key], DEFAULT_LIMITS[key]);
  }

  return limits;
}

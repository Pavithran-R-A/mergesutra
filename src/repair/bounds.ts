/**
 * What Stage 9 is allowed to spend on a repair, and what no caller may raise.
 *
 * A review that produces ten findings does not entitle the product to ten
 * unbounded edits, and a caller that wants more cycles is not evidence that more
 * cycles would help. So the numbers a run uses and the numbers a run may never
 * exceed are separate constants: the first is a default a caller may lower, the
 * second is a ceiling that ignores a caller who raises it.
 *
 * Exhausting a bound is a result, not a retry. Whatever a cycle could not reach
 * goes to a human with the reason, because the alternative — quietly looping
 * until something passes — is how a bounded process turns into an unbounded one.
 */

export interface RepairLimits {
  readonly maxReviewCycles: number;
  readonly maxRepairCycles: number;
  readonly maxFindingsPerRepair: number;
}

export const DEFAULT_REPAIR_LIMITS: RepairLimits = {
  maxReviewCycles: 2,
  maxRepairCycles: 2,
  maxFindingsPerRepair: 5,
};

export const MAX_REVIEW_CYCLES_CEILING = 3;
export const MAX_REPAIR_CYCLES_CEILING = 3;
export const MAX_FINDINGS_PER_REPAIR_CEILING = 10;

const CEILINGS: RepairLimits = {
  maxReviewCycles: MAX_REVIEW_CYCLES_CEILING,
  maxRepairCycles: MAX_REPAIR_CYCLES_CEILING,
  maxFindingsPerRepair: MAX_FINDINGS_PER_REPAIR_CEILING,
};

export const MAX_FINDINGS_PER_REPAIR = DEFAULT_REPAIR_LIMITS.maxFindingsPerRepair;

/**
 * The bound a run actually gets, whatever was asked for.
 *
 * A requested limit is clamped rather than refused: a caller that passes 500 has
 * usually misread the option, and the ceiling is the thing that matters. The
 * clamp is invisible in the resulting plan, which is why the plan builder says
 * which cap it applied when it stops a cycle.
 */
export function resolveLimit(name: keyof RepairLimits, requested?: number): number {
  const ceiling = CEILINGS[name];
  const wanted = Math.floor(requested ?? DEFAULT_REPAIR_LIMITS[name]);
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  return Math.min(wanted, ceiling);
}

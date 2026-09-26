import { describe, expect, it } from 'vitest';
import { EXIT, exitForOutcome } from '../../src/cli/exit-codes.js';
import type { RunOutcome } from '../../src/state/run-record.js';

/**
 * One outcome, one code, so a script can tell the stages apart without
 * reading prose. The five Stage 7 verdicts exist because "it passed", "it
 * failed", "nothing was allowed to run", "we stopped listening" and "a human
 * stopped us" are five different things to automate around.
 */

function code(outcome: RunOutcome): number {
  return exitForOutcome(outcome);
}

describe('exit codes for Stage 7 outcomes', () => {
  it('exits 0 only when the gates genuinely ran and passed', () => {
    expect(code('VERIFICATION_PASS')).toBe(EXIT.OK);
  });

  it('exits 1 when a gate ran and failed — the run reached a real verdict', () => {
    expect(code('VERIFICATION_FAIL')).toBe(EXIT.ERROR);
  });

  it('exits 4 when nothing could run, and 3 when the answer stayed open', () => {
    expect(code('VERIFICATION_BLOCKED')).toBe(EXIT.BLOCKED);
    expect(code('VERIFICATION_INCONCLUSIVE')).toBe(EXIT.INCONCLUSIVE);
    expect(code('VERIFICATION_CANCELLED')).toBe(EXIT.INCONCLUSIVE);
  });

  it('keeps every Stage 6 outcome exactly where Stage 6 left it', () => {
    // A model's FINISH is still only a claim, so it still exits 3.
    expect(code('IMPLEMENTED_BY_MODEL')).toBe(EXIT.INCONCLUSIVE);
    expect(code('IMPLEMENTATION_BLOCKED')).toBe(EXIT.BLOCKED);
    expect(code('IMPLEMENTATION_INCONCLUSIVE')).toBe(EXIT.INCONCLUSIVE);
    expect(code('IMPLEMENTATION_NEEDS_REVIEW')).toBe(EXIT.INCONCLUSIVE);
  });

  it('gives every outcome in the domain a code, so none can exit undefined', () => {
    const all = [
      'INTAKE_COMPLETE',
      'INSPECT_COMPLETE',
      'CONTRACT_DERIVED',
      'PLAN_COMPLETE',
      'IMPLEMENTED_BY_MODEL',
      'IMPLEMENTATION_BLOCKED',
      'IMPLEMENTATION_INCONCLUSIVE',
      'IMPLEMENTATION_NEEDS_REVIEW',
      'VERIFICATION_PASS',
      'VERIFICATION_FAIL',
      'VERIFICATION_BLOCKED',
      'VERIFICATION_INCONCLUSIVE',
      'VERIFICATION_CANCELLED',
      'REVIEW_RECORDED',
      'REVIEW_NEEDS_HUMAN',
      'REVIEW_STALE',
      'REVIEW_INCONCLUSIVE',
      'REVIEW_CANCELLED',
      'INCONCLUSIVE',
      'BLOCKED',
    ] as const satisfies readonly RunOutcome[];
    for (const outcome of all) {
      expect(code(outcome), outcome).toBeTypeOf('number');
    }
  });
});

describe('exit codes for Stage 9 outcomes', () => {
  /**
   * A review is the first document in this product a human might read as a
   * sign-off, so the exit code carries part of the honesty: nothing a model
   * wrote ends a run successfully. Only the facts around a review — it went
   * stale, it needs a person, it was interrupted — choose which non-zero code a
   * script sees.
   */
  it('never exits 0 for a review, however clean its findings list reads', () => {
    expect(code('REVIEW_RECORDED')).toBe(EXIT.INCONCLUSIVE);
  });

  it('exits 4 when the review describes bytes that no longer exist', () => {
    expect(code('REVIEW_STALE')).toBe(EXIT.BLOCKED);
  });

  it('counts a routed, unfinished or interrupted review as an open end', () => {
    expect(code('REVIEW_NEEDS_HUMAN')).toBe(EXIT.INCONCLUSIVE);
    expect(code('REVIEW_INCONCLUSIVE')).toBe(EXIT.INCONCLUSIVE);
    expect(code('REVIEW_CANCELLED')).toBe(EXIT.INCONCLUSIVE);
  });

  it('leaves every earlier stage exactly where it was', () => {
    expect(code('PLAN_COMPLETE')).toBe(EXIT.OK);
    expect(code('CONTRACT_DERIVED')).toBe(EXIT.OK);
  });
});

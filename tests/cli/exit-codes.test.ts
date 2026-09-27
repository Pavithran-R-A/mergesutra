import { describe, expect, it } from 'vitest';
import { EXIT, exitForOutcome } from '../../src/cli/exit-codes.js';
import { RUN_OUTCOMES, type RunOutcome } from '../../src/state/run-record.js';

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
      'REPAIR_APPLIED',
      'REPAIR_NEEDS_HUMAN',
      'REPAIR_BLOCKED',
      'PR_CANDIDATE_RECORDED',
      'PR_APPROVED_LOCAL',
      'PR_PUBLICATION_BLOCKED',
    ] as const satisfies readonly RunOutcome[];
    for (const outcome of all) {
      expect(code(outcome), outcome).toBeTypeOf('number');
    }
    // The list above is the whole domain, not a sample of it: an outcome a stage can
    // write has to have a code, or a script sees `undefined` where it expected news.
    expect([...all].sort()).toEqual([...RUN_OUTCOMES].sort());
  });
});

/**
 * Stage 10 ends a run without ending it in the way a script hopes for. Nothing it
 * can do changes anything on GitHub, so none of its outcomes has earned exit 0: the
 * candidate is a proposal, the approval is a human's yes about a proposal, and both
 * mean the next step belongs to somebody else — a publisher that does not exist in
 * this build. `PR_PUBLICATION_BLOCKED` exits 4 because the run stopped with an
 * approval on file that cannot be obeyed, which is the news a wrapper has to see.
 */
describe('exit codes for Stage 10 publication outcomes', () => {
  it('never exits 0 for a candidate, however complete its evidence reads', () => {
    expect(code('PR_CANDIDATE_RECORDED')).toBe(EXIT.INCONCLUSIVE);
  });

  it('exits 3 when a human has approved and nothing has been published', () => {
    expect(code('PR_APPROVED_LOCAL')).toBe(EXIT.INCONCLUSIVE);
  });

  it('exits 4 when publication could not have gone ahead at all', () => {
    expect(code('PR_PUBLICATION_BLOCKED')).toBe(EXIT.BLOCKED);
  });

  it('does not treat a local approval as the old success code', () => {
    expect(code('PR_APPROVED_LOCAL')).not.toBe(EXIT.OK);
    expect(code('PR_APPROVED_LOCAL')).not.toBe(EXIT.ERROR);
  });
});

describe('exit codes for Stage 9R repair outcomes', () => {
  /**
   * A repair is the one stage in this product that edits the repository, and none
   * of its outcomes exits 0. `REPAIR_APPLIED` means bytes moved where a human
   * approved that they could, which is a claim Stage 7 has to judge all over again;
   * `REPAIR_NEEDS_HUMAN` means the cycle reached outside its scope or left no
   * trace; `REPAIR_BLOCKED` means it never started, which is exactly what stops
   * everything downstream.
   */
  it('exits 3 for a repair that changed the patch, because that is a claim and not a verdict', () => {
    expect(code('REPAIR_APPLIED')).toBe(EXIT.INCONCLUSIVE);
  });

  it('exits 3 when a repair has to be escalated to a person, and never 0', () => {
    expect(code('REPAIR_NEEDS_HUMAN')).toBe(EXIT.INCONCLUSIVE);
  });

  it('exits 4 when the cycle never ran', () => {
    expect(code('REPAIR_BLOCKED')).toBe(EXIT.BLOCKED);
  });

  it('gives the new outcomes codes without moving an older one', () => {
    expect(code('REVIEW_RECORDED')).toBe(EXIT.INCONCLUSIVE);
    expect(code('REVIEW_STALE')).toBe(EXIT.BLOCKED);
    expect(code('VERIFICATION_PASS')).toBe(EXIT.OK);
    expect(code('IMPLEMENTED_BY_MODEL')).toBe(EXIT.INCONCLUSIVE);
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

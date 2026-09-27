/**
 * Process exit codes, fixed and documented.
 *
 * A script must be able to tell "nothing was verified" from "it ran and
 * passed", so every non-success state has its own code rather than sharing 1.
 */
import type { RunOutcome } from '../state/run-record.js';

export const EXIT = {
  /** The stage ran and reached its defined completion state. */
  OK: 0,
  /** A real failure: bad input, or an operation that could not complete. */
  ERROR: 1,
  /** The command is planned and not implemented. It deliberately does nothing. */
  PLANNED: 2,
  /** A stage finished but left a gap that needs a human decision. */
  INCONCLUSIVE: 3,
  /** A required input could not be obtained; nothing downstream can proceed. */
  BLOCKED: 4,
  /** Configuration is missing or invalid. */
  CONFIG: 78,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * One outcome, one code — shared by every stage command so that `issue` and
 * `inspect` cannot drift apart on what "success" sounds like to a script.
 *
 * Stage 6 has no `EXIT.OK`: a model that asked to stop has claimed work, and the
 * claim is checked by a later stage. `IMPLEMENTED_BY_MODEL` therefore exits 3.
 *
 * Stage 7 earns `EXIT.OK` because the answer is no longer a claim: deterministic
 * gates ran under a digested consent and the exit codes said so. Even then the
 * success is `VERIFICATION_PASS` — the gates passed, not "ship it".
 *
 * Stage 9 has no `EXIT.OK` either. `REVIEW_RECORDED` means a model read these
 * bytes and MergeSutra stored what it said, which is a thing to go and read, not
 * a thing to exit 0 over; and `REVIEW_STALE` is a block, because the patch moved
 * while it was being reviewed and every finding in that document is about bytes
 * that are gone.
 *
 * Stage 9R adds three outcomes and gives none of them `EXIT.OK`, which is the
 * whole point of a repair: bytes moved under a plan a human approved, and the only
 * thing that can call them good is a verification run that has not happened yet.
 * `REPAIR_APPLIED` and `REPAIR_NEEDS_HUMAN` both exit 3 — one because the gates
 * must be re-run, the other because a person must read a delta that escaped the
 * plan — and `REPAIR_BLOCKED` exits 4 with the untouched workspace, which is the
 * same news as `REVIEW_STALE` to a script: stop and look, there is nothing to
 * carry forward.
 *
 * Stage 10 adds the last three words and still no `EXIT.OK`, which is the point of
 * this one too. `PR_APPROVED_LOCAL` is as far as this build can go — a human has
 * named a digest and MergeSutra has written that down — and it exits 3, because what
 * it means is that a publication has not happened. There is no code for "the pull
 * request exists", and giving one would let a script report success for an event no
 * remote was ever asked to cause. `PR_PUBLICATION_BLOCKED` exits 4, the same stop-and-look
 * news the other blocks give.
 */
export function exitForOutcome(outcome: RunOutcome): ExitCode {
  switch (outcome) {
    case 'INTAKE_COMPLETE':
    case 'INSPECT_COMPLETE':
    case 'CONTRACT_DERIVED':
    case 'PLAN_COMPLETE':
    case 'VERIFICATION_PASS':
      return EXIT.OK;
    case 'VERIFICATION_FAIL':
      return EXIT.ERROR;
    case 'IMPLEMENTED_BY_MODEL':
    case 'IMPLEMENTATION_INCONCLUSIVE':
    case 'IMPLEMENTATION_NEEDS_REVIEW':
    case 'VERIFICATION_INCONCLUSIVE':
    case 'VERIFICATION_CANCELLED':
    case 'REVIEW_RECORDED':
    case 'REVIEW_NEEDS_HUMAN':
    case 'REVIEW_INCONCLUSIVE':
    case 'REVIEW_CANCELLED':
    case 'REPAIR_APPLIED':
    case 'REPAIR_NEEDS_HUMAN':
    case 'PR_CANDIDATE_RECORDED':
    case 'PR_APPROVED_LOCAL':
    case 'INCONCLUSIVE':
      return EXIT.INCONCLUSIVE;
    case 'IMPLEMENTATION_BLOCKED':
    case 'VERIFICATION_BLOCKED':
    case 'REVIEW_STALE':
    case 'REPAIR_BLOCKED':
    case 'PR_PUBLICATION_BLOCKED':
    case 'BLOCKED':
      return EXIT.BLOCKED;
  }
}

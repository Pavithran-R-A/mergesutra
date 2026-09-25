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
    case 'INCONCLUSIVE':
      return EXIT.INCONCLUSIVE;
    case 'IMPLEMENTATION_BLOCKED':
    case 'VERIFICATION_BLOCKED':
    case 'BLOCKED':
      return EXIT.BLOCKED;
  }
}

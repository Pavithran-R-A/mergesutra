/**
 * Process exit codes, fixed and documented.
 *
 * A script must be able to tell "nothing was verified" from "it ran and
 * passed", so every non-success state has its own code rather than sharing 1.
 */
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

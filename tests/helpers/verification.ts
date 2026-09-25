import { riskOf } from '../../src/process/tool-policy.js';
import { scopeDigest, type ExecutionConsent } from '../../src/verify/consent.js';
import type { PlannedGate, VerificationPlan } from '../../src/verify/plan.js';

/**
 * Plans and gates for the Stage 7 tests.
 *
 * These are written by hand rather than produced by `buildVerificationPlan`
 * because a test of the engine should not inherit its fixture from the
 * discovery code it is also trying to trust. The fields the schema requires are
 * all here, so a literal that type-checks is a plan the rest of the system
 * would accept.
 */

/** The workspace every test pretends to own. */
export const WORKSPACE = '/repo/.mergesutra/worktrees/run-1';

export function plannedGate(over: Partial<PlannedGate> & Pick<PlannedGate, 'id'>): PlannedGate {
  const argv = over.argv ?? ['npm', 'test'];
  return {
    name: 'test',
    command: argv.join(' '),
    argv,
    cwd: '.',
    requirementLevel: 'REPOSITORY_REQUIRED',
    corroboratedBy: [],
    relevantCriteria: ['AC-1'],
    timeoutMs: 120_000,
    ...over,
    provenance: over.provenance ?? {
      source: 'CI_WORKFLOW',
      file: '.github/workflows/ci.yml',
      detail: 'runs the suite',
      line: 11,
    },
    executionClass: over.executionClass ?? 'READ_ONLY',
    /** Derived, exactly as the planner does, so no test can state a risk. */
    risk: riskOf({ op: 'execute', argv, cwd: over.cwd ?? '.' }),
  };
}

export function builtinGate(over: Partial<PlannedGate> & Pick<PlannedGate, 'id'>): PlannedGate {
  return plannedGate({
    name: over.name ?? 'diff-check',
    argv: over.argv ?? ['git', 'diff', '--check'],
    provenance: {
      source: 'MERGESUTRA_BUILTIN',
      file: null,
      detail: 'MergeSutra adds a whitespace check of its own',
      line: null,
    },
    requirementLevel: 'MERGESUTRA_ADDITIONAL',
    ...over,
  } as PlannedGate);
}

export function planOf(
  gates: readonly PlannedGate[],
  over: Partial<VerificationPlan> = {},
): VerificationPlan {
  return {
    schemaVersion: 1,
    mergeSutraVersion: '0.0.1',
    runId: 'run-1',
    baseSha: 'a'.repeat(40),
    patchIdentity: 'b'.repeat(64),
    createdAt: '2026-09-25T00:00:00.000Z',
    revision: 1,
    gates,
    revisions: [],
    refused: [],
    missingPrerequisites: [],
    notes: [],
    ...over,
  };
}

export function consentFor(target: VerificationPlan, ids: readonly string[]): ExecutionConsent {
  return {
    planDigest: scopeDigest(target),
    gateIds: ids,
    grantedAt: '2026-09-25T00:00:00.000Z',
  };
}

/** A clock that moves forward on every read, so durations are real but tiny. */
export function steppingClock(start = Date.parse('2026-09-25T10:00:00.000Z'), stepMs = 1_000) {
  let at = start;
  return () => new Date((at += stepMs));
}

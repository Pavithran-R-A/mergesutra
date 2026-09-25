import { riskOf } from '../../src/process/tool-policy.js';
import type { RunResult, Runner } from '../../src/core/runner.js';
import { runVerification, type VerificationRun } from '../../src/verify/engine.js';
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
    commandForms: [argv.join(' ')],
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

/** A command that finished and said it was happy. */
export const SUCCEEDED: RunResult = {
  code: 0,
  stdout: 'all good\n',
  stderr: '',
  timedOut: false,
  truncated: false,
};

/** A command that finished and said it was not. */
export const EXITED_FAILING: RunResult = {
  code: 1,
  stdout: '',
  stderr: '1 test failed\n',
  timedOut: false,
  truncated: false,
};

/** Successive readings of the workspace's patch identity; the last one repeats. */
export function identitiesProbe(values: readonly (string | null)[]) {
  let seen = 0;
  return async () => {
    const value = values[seen] ?? values[values.length - 1] ?? null;
    seen += 1;
    return value;
  };
}

/**
 * Run a plan for real, with every command answered from a table.
 *
 * The engine, the consent decision and the receipts are all genuinely involved;
 * only the processes are scripted, so a test here measures judgement rather than
 * what happens to be installed on the machine.
 */
export async function verifyScripted(
  plan: VerificationPlan,
  calls: string[],
  commands: Record<string, RunResult>,
  consent?: ExecutionConsent,
  identities: (string | null)[] = [plan.patchIdentity, plan.patchIdentity],
): Promise<VerificationRun> {
  const runner: Runner = async (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    const response = commands[key];
    if (!response) throw new Error(`the engine ran a command nobody scripted: ${key}`);
    return response;
  };
  return runVerification(
    { plan, workspace: WORKSPACE, consent, signal: undefined },
    {
      now: steppingClock(),
      runFor: () => runner,
      currentPatchIdentity: identitiesProbe(identities),
    },
  );
}

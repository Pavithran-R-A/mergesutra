import { z } from 'zod';
import { createRunner, type Runner } from '../core/runner.js';
import { AppError } from '../core/errors.js';
import { resolveInsideRoot } from '../security/path-safety.js';
import { defaultRedactor } from '../security/redaction.js';
import {
  BLOCKED_CODES,
  decideExecution,
  scopeDigest,
  type BlockedCode,
  type ExecutionConsent,
  type ExecutionStatus,
} from './consent.js';
import {
  buildReceipt,
  gateReceiptSchema,
  type GateReceipt,
  type GateResult,
  type Termination,
} from './receipt.js';
import { describePatch } from './patch.js';
import type { PlannedGate, VerificationPlan } from './plan.js';

/**
 * Running a verification plan, and recording what came back — Stage 7.
 *
 * This is the only module in MergeSutra that executes a repository's commands,
 * so its shape is built around three things that must not be possible here:
 *
 * - **Running something nobody agreed to.** Every gate is put to
 *   `decideExecution` first, which applies the tool policy before it looks at
 *   consent, so a `rm -rf` discovered in a CI file is refused rather than
 *   consented into being. A gate that does not run still gets a receipt saying
 *   so; silently dropping it would turn "we did not check that" into a shorter
 *   list nobody notices.
 * - **Judging a command we did not run.** The engine never decides whether a
 *   gate passed by reading its output. A zero exit status is a pass, a non-zero
 *   one is a failure, and the two cases where *we* ended the process — the
 *   timeout and the output ceiling — are inconclusive, because in both the
 *   command was still talking when we stopped listening. Nothing here parses
 *   "1 test failed" and nothing here turns a truncated log into a verdict.
 * - **Recording a fact about the wrong patch.** The run opens by checking that
 *   the workspace still is the patch the plan was written for, and re-checks
 *   after every gate it ran. If a gate rewrote the patch, the receipts after
 *   that point say which patch they describe, and the run stops being a PASS on
 *   its own merits. MergeSutra cleans nothing up: a workspace a test suite
 *   modified is evidence about that suite, and destroying it would be destroying
 *   the only copy of the finding.
 *
 * Gates run in plan order, one at a time, and a failure does not stop the ones
 * after it. The repository's checks are independent facts about one diff, and a
 * report that only names the first failure makes the operator re-run the tool to
 * learn about the second.
 */

export const VERIFICATION_RUN_SCHEMA_VERSION = 1;

const GATE_ID = z.string().regex(/^VG-\d{3}$/, 'expected a gate id like VG-001');
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-character hex digest');
const COMMIT = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

/** What the whole run concluded, from the receipts it holds. */
export const runVerdictSchema = z.enum(['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'CANCELLED']);
export type RunVerdict = z.infer<typeof runVerdictSchema>;

const patchPreconditionSchema = z
  .object({
    status: z.enum(['MATCHED', 'STALE', 'UNDESCRIBABLE']),
    expectedIdentity: DIGEST,
    observedIdentity: DIGEST.nullable(),
    reason: z.string().min(1),
  })
  .strict();
export type PatchPrecondition = z.infer<typeof patchPreconditionSchema>;

const contaminationSchema = z
  .object({
    /** The gate that was running when the workspace stopped matching its own patch. */
    gateId: GATE_ID,
    expectedIdentity: DIGEST,
    observedIdentity: DIGEST,
    reason: z.string().min(1),
  })
  .strict();
export type Contamination = z.infer<typeof contaminationSchema>;

const gateOutcomeSchema = z
  .object({
    gateId: GATE_ID,
    status: z.enum(['CONSENTED', 'SELF_AUTHORED', 'OPERATOR_SUPPLIED', 'BLOCKED', 'REFUSED']),
    requiresConsent: z.boolean(),
    code: z.string().nullable(),
    reason: z.string().min(1),
    receipt: gateReceiptSchema,
  })
  .strict();
export type GateOutcome = z.infer<typeof gateOutcomeSchema>;

export const verificationRunSchema = z
  .object({
    schemaVersion: z.literal(VERIFICATION_RUN_SCHEMA_VERSION),
    runId: z.string().min(1),
    /** The commands the human agreed to, digested. Not the plan's prose. */
    planDigest: DIGEST,
    planRevision: z.number().int().positive(),
    workspace: z.string().min(1),
    baseSha: COMMIT,
    /** The patch the run *started* against; later receipts may name another. */
    patchIdentity: DIGEST,
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    result: runVerdictSchema,
    patchPrecondition: patchPreconditionSchema,
    contamination: contaminationSchema.nullable(),
    gates: z.array(gateOutcomeSchema).min(1).readonly(),
    notes: z.array(z.string()).readonly(),
  })
  .strict();
export type VerificationRun = z.infer<typeof verificationRunSchema>;

export interface VerifyInput {
  readonly plan: VerificationPlan;
  /** The workspace these gates run in. It must still be the plan's patch. */
  readonly workspace: string;
  readonly consent?: ExecutionConsent;
  readonly signal?: AbortSignal;
}

export interface GateExecutionSpec {
  /** Absolute, confined to `workspace`, and derived from the gate's own cwd. */
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface VerifyDeps {
  readonly now?: () => Date;
  /** Build the runner for one gate, since only the gate knows its own budget. */
  readonly runFor?: (spec: GateExecutionSpec) => Runner;
  /**
   * What the workspace looks like as a patch right now. Null means it can no
   * longer be described at all — a moved HEAD, a deleted workspace.
   */
  readonly currentPatchIdentity?: (spec: {
    workspace: string;
    baseSha: string;
  }) => Promise<string | null>;
}

interface PerGateState {
  /** The identity the next receipt will claim, until a gate changes it. */
  identity: string;
  contamination: Contamination | null;
  cancelled: boolean;
  undescribable: string | null;
}

export async function runVerification(
  input: VerifyInput,
  deps: VerifyDeps = {},
): Promise<VerificationRun> {
  const { plan, workspace } = input;
  const now = deps.now ?? (() => new Date());
  const runFor =
    deps.runFor ?? ((spec) => createRunner({ cwd: spec.cwd, timeoutMs: spec.timeoutMs }));
  const describe =
    deps.currentPatchIdentity ??
    (async (spec) => {
      try {
        const patch = await describePatch({ workspace: spec.workspace, baseSha: spec.baseSha });
        return patch.identity;
      } catch {
        return null;
      }
    });

  const startedAt = now();
  const expected = plan.patchIdentity;
  const observed = await describe({ workspace, baseSha: plan.baseSha });
  const precondition = preconditionOf(expected, observed);

  const state: PerGateState = {
    identity: precondition.status === 'MATCHED' ? expected : (observed ?? expected),
    contamination: null,
    cancelled: false,
    undescribable: null,
  };

  const outcomes: GateOutcome[] = [];
  for (const gate of plan.gates) {
    outcomes.push(
      await runOneGate(gate, {
        plan,
        workspace,
        consent: input.consent,
        signal: input.signal,
        precondition,
        state,
        now,
        runFor,
        describe,
      }),
    );
  }

  const notes = [...plan.missingPrerequisites];
  if (state.undescribable !== null) {
    notes.push(
      `Verification stopped early: after the gate above, the workspace could no longer be ` +
        `described as a patch on ${plan.baseSha.slice(0, 12)}. ${state.undescribable}`,
    );
  }
  if (state.cancelled) {
    notes.push('The operator cancelled this run; the gates it had not reached are marked NOT_RUN.');
  }

  return parseVerificationRun({
    schemaVersion: VERIFICATION_RUN_SCHEMA_VERSION,
    runId: plan.runId,
    planDigest: scopeDigest(plan),
    planRevision: plan.revision,
    workspace,
    baseSha: plan.baseSha,
    patchIdentity: expected,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    result: verdictOf(outcomes, state),
    patchPrecondition: precondition,
    contamination: state.contamination,
    gates: outcomes,
    notes,
  });
}

export function parseVerificationRun(value: unknown): VerificationRun {
  const parsed = verificationRunSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use a verification run that does not match MergeSutra's own shape: ${
        issue?.path.join('.') || 'document'
      }: ${issue?.message ?? 'invalid'}.`,
      remediation:
        'Re-run verification. A run record that has been edited is no longer a record of what ran.',
    });
  }
  return parsed.data;
}

async function runOneGate(
  gate: PlannedGate,
  ctx: {
    plan: VerificationPlan;
    workspace: string;
    consent: ExecutionConsent | undefined;
    signal: AbortSignal | undefined;
    precondition: PatchPrecondition;
    state: PerGateState;
    now: () => Date;
    runFor: (spec: GateExecutionSpec) => Runner;
    describe: (spec: { workspace: string; baseSha: string }) => Promise<string | null>;
  },
): Promise<GateOutcome> {
  const { plan, workspace, consent, signal, precondition, state, now } = ctx;

  const stopped = stopReason(signal, precondition, state);
  if (stopped) {
    return outcome(
      gate,
      stopped.status,
      stopped.code,
      stopped.reason,
      receiptFor(gate, {
        result: stopped.result,
        exitCode: null,
        termination: stopped.termination,
        stdout: '',
        stderr: stopped.stderr ?? '',
        identity: state.identity,
        workspace,
        baseSha: plan.baseSha,
        now,
      }),
    );
  }

  const decision = decideExecution(gate, { plan, workspace, consent });
  if (!decision.allowed) {
    return outcome(
      gate,
      decision.status,
      decision.code,
      decision.reason,
      receiptFor(gate, {
        result: decision.status === 'REFUSED' ? 'REFUSED' : 'BLOCKED',
        exitCode: null,
        termination: 'NOT_EXECUTED',
        stdout: '',
        stderr: '',
        identity: state.identity,
        workspace,
        baseSha: plan.baseSha,
        now,
      }),
    );
  }

  let cwd: string;
  try {
    cwd = resolveInsideRoot(workspace, gate.cwd, "a gate's working directory");
  } catch (error) {
    return outcome(
      gate,
      'REFUSED',
      null,
      error instanceof Error ? error.message : 'The gate named a directory this run does not own.',
      receiptFor(gate, {
        result: 'REFUSED',
        exitCode: null,
        termination: 'NOT_EXECUTED',
        stdout: '',
        stderr: '',
        identity: state.identity,
        workspace,
        baseSha: plan.baseSha,
        now,
      }),
    );
  }

  const startedAt = now();
  let result: GateResult;
  let exitCode: number | null;
  let termination: Termination;
  let stdout = '';
  let stderr = '';
  let failure: string | null = null;

  try {
    // `plannedGateSchema` requires at least one argv element, so the program is
    // there; the type just cannot see a schema's promise.
    const [program, ...rest] = gate.argv;
    const ran = await ctx.runFor({ cwd, timeoutMs: gate.timeoutMs })(program as string, rest);
    if (ran.timedOut === true) {
      result = 'INCONCLUSIVE';
      exitCode = null;
      termination = 'TIMED_OUT';
    } else if (ran.truncated === true) {
      result = 'INCONCLUSIVE';
      exitCode = ran.code;
      termination = 'OUTPUT_LIMIT';
    } else if (ran.code === 0) {
      result = 'PASS';
      exitCode = 0;
      termination = 'EXITED';
    } else {
      result = 'FAIL';
      exitCode = ran.code;
      termination = 'EXITED';
    }
    stdout = ran.stdout;
    stderr = ran.stderr;
  } catch (error) {
    // The command could not be reached. That is a fact about this attempt, and
    // it says nothing about the code under review, so it is neither a pass nor
    // the failure of the change.
    failure = defaultRedactor.text(error instanceof Error ? error.message : String(error));
    result = 'INCONCLUSIVE';
    exitCode = null;
    termination = 'NOT_EXECUTED';
    stderr = failure;
  }

  const receipt = receiptFor(gate, {
    result,
    exitCode,
    termination,
    stdout,
    stderr,
    identity: state.identity,
    workspace,
    baseSha: plan.baseSha,
    now,
    startedAt,
  });

  await noteContamination(gate, ctx, state);

  return outcome(gate, decision.status, decision.code, decision.reason, receipt, failure);
}

/** Re-read the patch after a gate that really ran, and record what moved. */
async function noteContamination(
  gate: PlannedGate,
  ctx: {
    plan: VerificationPlan;
    workspace: string;
    describe: (spec: { workspace: string; baseSha: string }) => Promise<string | null>;
  },
  state: PerGateState,
): Promise<void> {
  const observed = await ctx.describe({
    workspace: ctx.workspace,
    baseSha: ctx.plan.baseSha,
  });
  if (observed === null) {
    state.undescribable =
      `The command \`${gate.command}\` ran, and the workspace can no longer be ` +
      `described as a patch on its base commit.`;
    return;
  }
  if (observed === state.identity || state.contamination !== null) return;
  state.contamination = {
    gateId: gate.id,
    expectedIdentity: state.identity,
    observedIdentity: observed,
    reason:
      `After \`${gate.command}\` (${gate.id}) ran, the workspace no longer contains the patch this ` +
      `run was verifying. MergeSutra has not cleaned, reset or removed anything: the change the ` +
      `gate made is yours to look at, and it is the evidence.`,
  };
  // From here on, a receipt describes what is on disk, not what was agreed to.
  state.identity = observed;
}

function preconditionOf(expected: string, observed: string | null): PatchPrecondition {
  if (observed === expected) {
    return {
      status: 'MATCHED',
      expectedIdentity: expected,
      observedIdentity: observed,
      reason: 'The workspace is still the patch this plan was written for.',
    };
  }
  if (observed === null) {
    return {
      status: 'UNDESCRIBABLE',
      expectedIdentity: expected,
      observedIdentity: null,
      reason:
        'The workspace could not be described as a patch at all, so no gate could be run against ' +
        'a patch identity this run could name. Nothing was executed.',
    };
  }
  return {
    status: 'STALE',
    expectedIdentity: expected,
    observedIdentity: observed,
    reason:
      `The patch has changed since this plan was written: the plan names ` +
      `${expected.slice(0, 12)} and the workspace now is ${observed.slice(0, 12)}. Nothing was ` +
      `executed, because a receipt written now would describe a diff the operator never agreed to.`,
  };
}

function stopReason(
  signal: AbortSignal | undefined,
  precondition: PatchPrecondition,
  state: PerGateState,
): {
  status: ExecutionStatus;
  code: string;
  reason: string;
  result: GateResult;
  termination: Termination;
  stderr?: string;
} | null {
  if (precondition.status !== 'MATCHED') {
    return {
      status: 'BLOCKED',
      code: precondition.status === 'STALE' ? 'BLOCKED_PATCH_STALE' : 'BLOCKED_PATCH_UNDESCRIBABLE',
      reason: precondition.reason,
      result: 'BLOCKED',
      termination: 'NOT_EXECUTED',
    };
  }
  if (signal?.aborted) {
    return {
      status: 'BLOCKED',
      code: 'BLOCKED_RUN_CANCELLED',
      reason: 'This run was cancelled before the gate was reached.',
      result: 'NOT_RUN',
      termination: 'CANCELLED',
    };
  }
  if (state.undescribable !== null) {
    return {
      status: 'BLOCKED',
      code: 'BLOCKED_PATCH_UNDESCRIBABLE',
      reason:
        `Not run: ${state.undescribable} Every remaining gate is left unexecuted rather than ` +
        'recorded against an identity this run cannot name.',
      result: 'NOT_RUN',
      termination: 'NOT_EXECUTED',
    };
  }
  return null;
}

function receiptFor(
  gate: PlannedGate,
  input: {
    result: GateResult;
    exitCode: number | null;
    termination: Termination;
    stdout: string;
    stderr: string;
    identity: string;
    workspace: string;
    baseSha: string;
    now: () => Date;
    startedAt?: Date;
  },
): GateReceipt {
  const startedAt = input.startedAt ?? input.now();
  return buildReceipt({
    gate,
    workspace: input.workspace,
    baseSha: input.baseSha,
    patchIdentity: input.identity,
    startedAt,
    finishedAt: input.now(),
    result: input.result,
    exitCode: input.exitCode,
    termination: input.termination,
    stdout: input.stdout,
    stderr: input.stderr,
  });
}

function outcome(
  gate: PlannedGate,
  status: ExecutionStatus,
  code: BlockedCode | string | null,
  reason: string,
  receipt: GateReceipt,
  failure?: string | null,
): GateOutcome {
  return {
    gateId: gate.id,
    status,
    // Either of the two consent codes means the same thing to the operator: a
    // yes naming these gates for this plan is what is missing. A stale yes is
    // still a missing yes — printing nothing here would hide the one action
    // that unblocks the round.
    requiresConsent:
      status === 'BLOCKED' && (BLOCKED_CODES as readonly string[]).includes(code ?? ''),
    code: code ?? (failure !== null && failure !== undefined ? 'GATE_COULD_NOT_RUN' : null),
    reason: failure !== null && failure !== undefined ? `${reason} (${failure})` : reason,
    receipt,
  };
}

function verdictOf(outcomes: readonly GateOutcome[], state: PerGateState): RunVerdict {
  const results = outcomes.map((entry) => entry.receipt.result);
  if (
    results.includes('NOT_RUN') &&
    outcomes.some((entry) => entry.code === 'BLOCKED_RUN_CANCELLED')
  ) {
    return 'CANCELLED';
  }
  if (results.includes('BLOCKED') || results.includes('REFUSED')) return 'BLOCKED';
  if (state.contamination !== null) return 'INCONCLUSIVE';
  if (results.includes('INCONCLUSIVE') || results.includes('NOT_RUN')) return 'INCONCLUSIVE';
  if (results.includes('FAIL')) return 'FAIL';
  return 'PASS';
}

/**
 * Whether a verdict is the one that says every gate passed.
 *
 * Exported as a question rather than a constant because `PASS` is this module's
 * own word, produced by the weighing above: a caller that compares the verdict to
 * a string it typed out is keeping a second definition of green, and the second
 * definition is the one that drifts.
 */
export function verdictIsPassed(result: RunVerdict): boolean {
  return result === 'PASS';
}

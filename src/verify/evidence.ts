import { z } from 'zod';
import { AppError } from '../core/errors.js';
import {
  criterionStatusSchema,
  evidenceSchema,
  type Evidence,
  type VerificationStep,
} from '../contract/schema.js';
import { normalizeCommand } from './gates.js';
import { stalenessOf } from './patch.js';
import { gateResultSchema, type GateReceipt } from './receipt.js';
import { runVerdictSchema, type GateOutcome, type VerificationRun } from './engine.js';
import type { PlannedGate, VerificationPlan } from './plan.js';
import type { AcceptanceCriterion } from '../contract/schema.js';

/**
 * What the Acceptance Contract is allowed to claim, worked out from receipts.
 *
 * A gate result and a criterion status are different facts, and this module is
 * where the distance between them is either crossed on evidence or left alone.
 * The rule it enforces is the one the whole stage exists for: a criterion is
 * backed by the commands **its own verification plan named**, matched by the
 * same rule that built the gate, so no green thing nearby can be credited to a
 * requirement nobody checked it against.
 *
 * Four decisions carry that:
 *
 * - **Relevance is a command match, not a theme.** A criterion asking for
 *   `node scripts/check-banner.js` is not served by a passing `npm test`, however
 *   sure one is that the suite covers it. If nothing in the plan ran that
 *   command, the criterion says so.
 * - **Every step of the criterion counts.** One passing command out of two leaves
 *   the record `PARTIALLY_VERIFIED`, and the status that goes with that is
 *   `INCONCLUSIVE`. The strongest state a criterion can reach is the one all of
 *   its own evidence supports.
 * - **A step that asks for a person cannot be satisfied by a process.** Those
 *   keep the record at `MANUAL_REVIEW_REQUIRED` rather than being dropped when
 *   they become inconvenient.
 * - **Evidence describes one patch.** A receipt whose identity no longer matches
 *   the workspace is quoted, marked `STALE`, and does not count — which is how a
 *   resume after implementation work cannot inherit yesterday's green.
 *
 * A sentence from BharatCode has no route in here. Claims are filed in `claims`,
 * beside the record, and are read by nothing that decides a status.
 */

export const EVIDENCE_RECORD_SCHEMA_VERSION = 1;

const GATE_ID = z.string().regex(/^VG-\d{3}$/, 'expected a gate id like VG-001');
const CRITERION_ID = z.string().regex(/^AC-\d+$/, 'expected an acceptance criterion id like AC-1');
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-character hex digest');
const COMMIT = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

/**
 * How far the receipts get a criterion, kept apart from its status because the
 * two answer different questions — one is about the evidence, the other is what
 * the contract may say.
 */
export const SUFFICIENCIES = [
  'VERIFIED',
  'PARTIALLY_VERIFIED',
  'NOT_VERIFIED',
  'FAILED',
  'BLOCKED',
  'MANUAL_REVIEW_REQUIRED',
] as const;
export const sufficiencySchema = z.enum(SUFFICIENCIES);
export type Sufficiency = z.infer<typeof sufficiencySchema>;

export const criterionEvidenceSchema = z
  .object({
    criterionId: CRITERION_ID,
    statement: z.string().min(1),
    /** The contract's own vocabulary: this record feeds a contract, not a new one. */
    status: criterionStatusSchema,
    sufficiency: sufficiencySchema,
    /** Every gate this entry quotes, so a reader can find the receipt. */
    gateIds: z.array(GATE_ID).readonly(),
    /** One entry per step of the criterion's own verification plan. */
    evidence: z.array(evidenceSchema).readonly(),
    limitations: z.array(z.string()).readonly(),
  })
  .strict();
export type CriterionEvidence = z.infer<typeof criterionEvidenceSchema>;

export const modelClaimSchema = z
  .object({
    /** Which model output said it — an action, an attempt, a review. */
    source: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();
export type ModelClaim = z.infer<typeof modelClaimSchema>;

export const acceptanceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_RECORD_SCHEMA_VERSION),
    runId: z.string().min(1),
    planRevision: z.number().int().positive(),
    /** The engine's verdict on its own gates. Not a verdict on the contribution. */
    verification: runVerdictSchema,
    /** The patch the run verified, and the patch that is here now. */
    patchIdentity: DIGEST,
    currentPatchIdentity: DIGEST,
    /**
     * Fixed false, by the type. Stage 7 decides whether verification passed;
     * calling a patch contribution-ready belongs to the later stages that read
     * this record along with review and packaging, so this document cannot
     * express a claim it has no authority to make.
     */
    contributionReady: z.literal(false),
    criteria: z.array(criterionEvidenceSchema).readonly(),
    claims: z.array(modelClaimSchema).readonly(),
    notes: z.array(z.string()).readonly(),
  })
  .strict();
export type AcceptanceEvidence = z.infer<typeof acceptanceEvidenceSchema>;

/** The parts of a criterion this module reads; a full contract satisfies it. */
export type CriterionView = Pick<AcceptanceCriterion, 'id' | 'statement' | 'verificationPlan'>;

export interface MapEvidenceInput {
  readonly criteria: readonly CriterionView[];
  readonly plan: VerificationPlan;
  readonly run: VerificationRun;
  /**
   * What the workspace holds now. Defaults to the identity the run started on,
   * and differs whenever implementation work continued after verification.
   */
  readonly currentPatchIdentity?: string;
  readonly claims?: readonly ModelClaim[];
}

/** A gate and what the run said about it. Several may answer one command. */
interface Ran {
  readonly gate: PlannedGate;
  readonly outcome: GateOutcome;
}

/** How one step of a criterion's own plan fared, before it becomes a status. */
type StepFinding =
  | { readonly kind: 'VERIFIED'; readonly ran: Ran }
  | { readonly kind: 'FAILED'; readonly ran: Ran }
  | { readonly kind: 'STALE'; readonly ran: Ran; readonly current: string }
  | { readonly kind: 'BLOCKED'; readonly ran: Ran }
  | { readonly kind: 'NO_ANSWER'; readonly ran: Ran }
  | { readonly kind: 'UNCOVERED'; readonly command: string }
  | { readonly kind: 'UNREPORTED'; readonly gate: PlannedGate }
  | { readonly kind: 'NEEDS_A_HUMAN'; readonly step: VerificationStep };

export function mapAcceptanceEvidence(input: MapEvidenceInput): AcceptanceEvidence {
  const { plan, run } = input;
  const current = input.currentPatchIdentity ?? run.patchIdentity;
  const outcomes = new Map(run.gates.map((outcome) => [outcome.gateId, outcome]));
  const gatesByCommand = new Map<string, PlannedGate[]>();
  for (const gate of plan.gates) {
    // A gate answers for every spelling the plan says it carries — the
    // invocation it ran, and the script bodies that invocation reaches.
    const forms = new Set([gate.command, ...gate.commandForms].map(normalizeCommand));
    for (const key of forms) {
      const existing = gatesByCommand.get(key);
      if (existing) existing.push(gate);
      else gatesByCommand.set(key, [gate]);
    }
  }
  const ctx = { gatesByCommand, outcomes, current };

  const criteria = input.criteria.map((criterion) =>
    describeCriterion(
      criterion,
      criterion.verificationPlan.map((step) => findingFor(step, ctx)),
      plan.revision,
    ),
  );

  const notes = [
    ...run.notes,
    ...(run.contamination ? [run.contamination.reason] : []),
    ...(current === run.patchIdentity
      ? []
      : [
          `This record was written after the run: the workspace now holds ${current.slice(0, 12)} ` +
            `rather than the ${run.patchIdentity.slice(0, 12)} the gates ran against, so evidence ` +
            `gathered before the change is marked STALE.`,
        ]),
    'This says what deterministic gates established. Calling a change contribution-ready is a ' +
      'later stage reading this record along with review and packaging, not a conclusion ' +
      'available here.',
  ];

  return parseAcceptanceEvidence({
    schemaVersion: EVIDENCE_RECORD_SCHEMA_VERSION,
    runId: run.runId,
    planRevision: plan.revision,
    verification: run.result,
    patchIdentity: run.patchIdentity,
    currentPatchIdentity: current,
    contributionReady: false,
    criteria,
    claims: input.claims ?? [],
    notes,
  });
}

export function parseAcceptanceEvidence(value: unknown): AcceptanceEvidence {
  const parsed = acceptanceEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use an acceptance evidence record that does not match MergeSutra's own shape: ${issue?.path.join('.') ?? 'document'}: ${issue?.message ?? 'invalid'}.`,
      remediation:
        'Re-derive the record from the run and the plan. A record that has been edited is no longer a reading of the receipts.',
    });
  }
  return parsed.data;
}

/**
 * One step, judged.
 *
 * The order is the conservative one: a failure anywhere in what the command
 * claimed decides the step, and only a step where *every* gate that ran that
 * command passed can be called verified. A mixed answer — one gate passing and
 * one inconclusive about the same command — is not averaged.
 */
function findingFor(
  step: VerificationStep,
  ctx: {
    gatesByCommand: Map<string, PlannedGate[]>;
    outcomes: Map<string, GateOutcome>;
    current: string;
  },
): StepFinding {
  if (!('command' in step)) return { kind: 'NEEDS_A_HUMAN', step };
  const command = normalizeCommand(step.command);
  const candidates = ctx.gatesByCommand.get(command);
  if (!candidates || candidates.length === 0) return { kind: 'UNCOVERED', command };

  const ran: Ran[] = [];
  for (const gate of candidates) {
    const outcome = ctx.outcomes.get(gate.id);
    // The plan gained a gate this run never saw. Nothing is known about it, so
    // the run is not allowed to answer for it.
    if (!outcome) return { kind: 'UNREPORTED', gate };
    ran.push({ gate, outcome });
  }

  const failing = ran.find((one) => one.outcome.receipt.result === 'FAIL');
  if (failing) return { kind: 'FAILED', ran: failing };
  const passed = ran.filter((one) => one.outcome.receipt.result === 'PASS');
  if (passed.length === ran.length) {
    const one = passed[0] as Ran;
    const identity = one.outcome.receipt.patchIdentity;
    return stalenessOf(identity, ctx.current).status === 'STALE'
      ? { kind: 'STALE', ran: one, current: ctx.current }
      : { kind: 'VERIFIED', ran: one };
  }
  const unrun = ran.find(
    (one) => one.outcome.receipt.result === 'BLOCKED' || one.outcome.receipt.result === 'REFUSED',
  );
  if (unrun && passed.length === 0) return { kind: 'BLOCKED', ran: unrun };
  const other = ran.find((one) => one.outcome.receipt.result !== 'PASS') as Ran;
  return { kind: 'NO_ANSWER', ran: other };
}

function describeCriterion(
  criterion: CriterionView,
  findings: readonly StepFinding[],
  planRevision: number,
): CriterionEvidence {
  const steps = findings.filter((finding) => finding.kind !== 'NEEDS_A_HUMAN');
  const humans = findings.filter((finding) => finding.kind === 'NEEDS_A_HUMAN');
  const verdict = combine(steps, humans);
  const quoted = findings.flatMap(quote);

  return {
    criterionId: criterion.id,
    statement: criterion.statement,
    status: verdict.status,
    sufficiency: verdict.sufficiency,
    gateIds: [...new Set(quoted)].sort(),
    evidence: findings.map((finding) => evidenceFor(finding, planRevision)),
    limitations: findings
      .flatMap((finding) => limitationFor(finding, planRevision))
      .concat(humans.map(humanWanted)),
  };
}

function combine(
  steps: readonly StepFinding[],
  humans: readonly StepFinding[],
): { status: z.infer<typeof criterionStatusSchema>; sufficiency: Sufficiency } {
  const kinds = steps.map((finding) => finding.kind);
  const has = (kind: StepFinding['kind']) => kinds.includes(kind);
  const verified = kinds.filter((kind) => kind === 'VERIFIED').length;

  if (steps.length === 0) {
    return {
      status: 'NOT_AVAILABLE',
      sufficiency: humans.length > 0 ? 'MANUAL_REVIEW_REQUIRED' : 'NOT_VERIFIED',
    };
  }
  if (has('FAILED')) return { status: 'FAIL', sufficiency: 'FAILED' };
  if (has('BLOCKED') && verified === 0) return { status: 'BLOCKED', sufficiency: 'BLOCKED' };
  if (verified === steps.length) {
    return humans.length > 0
      ? { status: 'INCONCLUSIVE', sufficiency: 'MANUAL_REVIEW_REQUIRED' }
      : { status: 'PASS', sufficiency: 'VERIFIED' };
  }
  if (verified > 0) return { status: 'INCONCLUSIVE', sufficiency: 'PARTIALLY_VERIFIED' };
  // Something was reached and gave no answer, or the run never covered the plan.
  // Either way the question is still open, which is not the same as unaskable.
  if (has('NO_ANSWER') || has('UNREPORTED')) {
    return { status: 'INCONCLUSIVE', sufficiency: 'NOT_VERIFIED' };
  }
  return { status: 'NOT_AVAILABLE', sufficiency: 'NOT_VERIFIED' };
}

function evidenceFor(finding: StepFinding, planRevision: number): Evidence {
  switch (finding.kind) {
    case 'VERIFIED':
    case 'FAILED': {
      const receipt = finding.ran.outcome.receipt;
      return {
        executed: true,
        command: finding.ran.gate.command,
        result: {
          status: receipt.result === 'PASS' ? 'PASS' : 'FAIL',
          exitCode: receipt.exitCode ?? (receipt.result === 'PASS' ? 0 : 1),
          // The output is not stored as a file by the engine, so pointing at one
          // would be a broken promise; the digest is the handle that exists.
          outputRef: null,
          durationMs: receipt.durationMs,
        },
        provenance: receiptPointer(finding.ran),
      };
    }
    case 'STALE':
      return {
        executed: false,
        reason: `STALE: ${stalenessOf(finding.ran.outcome.receipt.patchIdentity, finding.current).reason}`,
        provenance: receiptPointer(finding.ran),
      };
    case 'BLOCKED':
      return {
        executed: false,
        reason: `Nothing ran: ${finding.ran.outcome.reason}`,
        provenance: receiptPointer(finding.ran),
      };
    case 'NO_ANSWER':
      return {
        executed: false,
        reason: `${finding.ran.outcome.receipt.result}: the command was reached and MergeSutra got no verdict out of it. ${finding.ran.outcome.reason}`,
        provenance: receiptPointer(finding.ran),
      };
    case 'UNREPORTED':
      return {
        executed: false,
        reason: `The plan names ${finding.gate.id} for this command and the run reported no outcome for it.`,
        provenance: `verification plan revision ${planRevision}`,
      };
    case 'UNCOVERED':
      return {
        executed: false,
        reason: `No gate in this plan runs \`${finding.command}\`, so this criterion has no evidence either way.`,
        provenance: `verification plan revision ${planRevision}`,
      };
    case 'NEEDS_A_HUMAN':
      return {
        executed: false,
        reason: `This step is a ${finding.step.kind.replace('_', ' ')} for a person to perform, not a command.`,
        provenance: finding.step.from ?? 'the acceptance contract',
      };
  }
}

function limitationFor(finding: StepFinding, planRevision: number): string[] {
  switch (finding.kind) {
    case 'VERIFIED':
    case 'NEEDS_A_HUMAN':
      return [];
    case 'FAILED':
      return [
        `${finding.ran.gate.id} (\`${finding.ran.gate.command}\`) exited ${finding.ran.outcome.receipt.exitCode}, so this criterion is not met.`,
      ];
    case 'STALE':
      return [
        `${finding.ran.gate.id}'s evidence is STALE and does not count: ${
          stalenessOf(finding.ran.outcome.receipt.patchIdentity, finding.current).reason
        }`,
      ];
    case 'BLOCKED':
      return [
        `${finding.ran.gate.id} (\`${finding.ran.gate.command}\`) was never executed, so it says nothing about this criterion either way.`,
      ];
    case 'NO_ANSWER':
      return [
        `${finding.ran.gate.id} (\`${finding.ran.gate.command}\`) ended in ${finding.ran.outcome.receipt.result}, which is not an answer about this criterion.`,
      ];
    case 'UNREPORTED':
      return [
        `The run reported no outcome for ${finding.gate.id} (\`${finding.gate.command}\`): plan revision ${planRevision} is not the plan that ran.`,
      ];
    case 'UNCOVERED':
      return [`No gate runs \`${finding.command}\`, the check this criterion asked for.`];
  }
}

function humanWanted(finding: StepFinding): string {
  if (finding.kind !== 'NEEDS_A_HUMAN') return '';
  const step = finding.step;
  return (
    `This criterion asks for ${step.kind.replace('_', ' ')} from a person` +
    `${step.from ? ` (${step.from})` : ''}; no command MergeSutra ran can stand in for one.`
  );
}

function quote(finding: StepFinding): string[] {
  if (finding.kind === 'UNCOVERED' || finding.kind === 'NEEDS_A_HUMAN') return [];
  if (finding.kind === 'UNREPORTED') return [finding.gate.id];
  return [finding.ran.gate.id];
}

function receiptPointer(ran: Ran): string {
  const receipt = ran.outcome.receipt;
  const where = receipt.provenanceFile
    ? `${receipt.provenanceSource} at ${receipt.provenanceFile}`
    : receipt.provenanceSource;
  return `gate ${ran.gate.id} ran \`${ran.gate.command}\` in ${ran.gate.cwd} (${where}); output sha256 ${receipt.outputSha256.slice(0, 12)}`;
}

/**
 * Whether one command, run before and after the patch, shows a test catching the
 * defect — the optional and deliberately narrow mechanism the steering document
 * allows as stronger evidence for a bug fix.
 *
 * The two sides have to be *the same gate*: same argv, same directory, same base
 * commit, and genuinely different patches. A comparison that fails those is
 * refused rather than recorded as inconclusive, because a base run and a patched
 * run of two different commands is not weak evidence — it is a mistake, and
 * writing "not demonstrated" beside a mistake would let it into a report.
 *
 * What it can say is only this: the targeted command failed on the base and
 * passes now. `statement` carries that limit in the record itself, because a
 * passing regression test is evidence about one behaviour and not proof that the
 * change as a whole is correct.
 */
export const regressionEvidenceSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_RECORD_SCHEMA_VERSION),
    gateId: GATE_ID,
    command: z.string().min(1),
    cwd: z.string().min(1),
    baseSha: COMMIT,
    baseIdentity: DIGEST,
    patchedIdentity: DIGEST,
    baseResult: gateResultSchema,
    patchedResult: gateResultSchema,
    demonstrated: z.boolean(),
    statement: z.string().min(1),
  })
  .strict();
export type RegressionEvidence = z.infer<typeof regressionEvidenceSchema>;

export function compareRegressionEvidence(
  base: GateReceipt,
  patched: GateReceipt,
): RegressionEvidence {
  const mismatch = incomparable(base, patched);
  if (mismatch) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing a regression comparison: ${mismatch}`,
      remediation:
        'Run the same gate against the base and against the patched workspace, and compare those two receipts.',
    });
  }

  const { demonstrated, statement } = describe(base, patched);
  return {
    schemaVersion: EVIDENCE_RECORD_SCHEMA_VERSION,
    gateId: patched.gateId,
    command: patched.argv.join(' '),
    cwd: patched.cwd,
    baseSha: patched.baseSha,
    baseIdentity: base.patchIdentity,
    patchedIdentity: patched.patchIdentity,
    baseResult: base.result,
    patchedResult: patched.result,
    demonstrated,
    statement: `${statement} This is regression evidence about \`${patched.argv.join(' ')}\`, not proof that the whole change is correct.`,
  };
}

function incomparable(base: GateReceipt, patched: GateReceipt): string | null {
  if (base.argv.join(' ') !== patched.argv.join(' ') || base.cwd !== patched.cwd) {
    return `the two receipts are not the same gate: \`${base.argv.join(' ')}\` in ${base.cwd} against \`${patched.argv.join(' ')}\` in ${patched.cwd}.`;
  }
  if (base.baseSha !== patched.baseSha) {
    return `the two receipts sit on different base commits (${base.baseSha.slice(0, 12)} and ${patched.baseSha.slice(0, 12)}), so the difference between them is not the patch.`;
  }
  if (base.patchIdentity === patched.patchIdentity) {
    return 'both receipts describe the same patch, so there is no before and after to compare.';
  }
  return null;
}

function describe(
  base: GateReceipt,
  patched: GateReceipt,
): { demonstrated: boolean; statement: string } {
  const gate = `\`${base.argv.join(' ')}\``;
  const unanswered = (which: string, result: GateReceipt['result']) =>
    `${gate} never produced a result ${which} (${result}), so there is nothing to compare ${which === 'on the base' ? 'against' : 'there'}.`;
  if (base.result !== 'PASS' && base.result !== 'FAIL') {
    return { demonstrated: false, statement: unanswered('on the base', base.result) };
  }
  if (patched.result !== 'PASS' && patched.result !== 'FAIL') {
    return { demonstrated: false, statement: unanswered('on the patch', patched.result) };
  }
  if (base.result === 'FAIL') {
    return {
      demonstrated: true,
      statement: `${gate} failed on the base and passes on the patch, which is regression evidence that the test detects the defect it was written for.`,
    };
  }
  return patched.result === 'PASS'
    ? {
        demonstrated: false,
        statement: `${gate} passed on both sides, so this comparison is not regression evidence: the test did not need the fix in order to pass.`,
      }
    : {
        demonstrated: false,
        statement: `${gate} passed on the base and fails on the patch, which is a regression the change introduced rather than evidence of a fix.`,
      };
}

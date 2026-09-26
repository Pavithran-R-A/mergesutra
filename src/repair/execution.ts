import { z } from 'zod';
import { implementationRecordSchema, type ImplementationRecord } from '../implement/state.js';
import { AppError } from '../core/errors.js';
import { decideRepairApproval, type RepairApproval } from './consent.js';
import type { RepairPlan } from './plan.js';
import { classifyRepairScope, repairScopeDeltaSchema } from './scope.js';
import type { PatchDescription } from '../verify/patch.js';

/**
 * What one repair cycle actually did — Stage 9R.
 *
 * A plan says what was meant; an approval says a human allowed it. Neither of them
 * survives contact with the workspace, and after a cycle there are facts nobody
 * else can reconstruct: there were two patches where there had been one, a loop
 * wrote some of what it was shown and was refused the rest, and the receipts the
 * run was proud of now describe bytes that are gone. Held separately each of those
 * is readable. Held wrongly together they mislead — a passing verification and a
 * repair that ran after it say nothing at all about which came first, which is
 * exactly the question a reviewer asks of a contribution that was edited twice.
 * This document holds them in the only order that makes sense: consent, then A,
 * then what the loop did, then B, then what must happen next.
 *
 * Three properties are the whole design.
 *
 * 1. **It cannot be written without the yes.** The builder recomputes the digest
 *    of the plan it was handed and refuses unless the approval on offer matches it
 *    — so this record cannot describe a cycle that ran on a model's say-so, and the
 *    consent it carries is the same scope-bound consent a human was shown, not a
 *    looser claim invented next to it. The digest is derived, never accepted: a
 *    caller who could supply the number could authorise a plan nobody read.
 * 2. **It records, it does not judge.** There is no verdict field, no criterion
 *    status, no `success`, and no place for the model's reasoning beyond the action
 *    log the loop already kept. An out-of-scope repair is stored with its scope
 *    still saying `OUTSIDE_PLANNED_SCOPE` — this module's job is to make the
 *    overreach legible, not to smooth it over on the way to disk.
 * 3. **It keeps stale things stale.** `verificationRequired` is the patch delta
 *    speaking, not a caller's preference: bytes moved, so the gates have to run
 *    again. It stays true when the cycle is being escalated to a human, because a
 *    green state that has gone stale does not become green again by being handed
 *    to somebody — and nothing here is allowed to fall back to it either way.
 *
 * The patch identities are copied from Stage 7's measurements and the delta from
 * Stage 9's scope guard, so a reader can re-derive both from the repository. This
 * module writes no files, runs no commands, and asks no model anything; it is
 * arithmetic over documents that already exist, which is why it can be trusted to
 * describe the other three.
 */

export const REPAIR_EXECUTION_SCHEMA_VERSION = 1;

const identitySchema = z.string().regex(/^[0-9a-f]{64}$/, 'A patch identity is a sha256 digest.');

/**
 * One cycle's worth of consequence.
 *
 * The shape is deliberately closed (`.strict()`): a field added later is a field
 * some stage could start quoting, and the arguments for adding one belong here
 * rather than in whichever caller needs them right now.
 */
export const repairExecutionSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_EXECUTION_SCHEMA_VERSION),
    runId: z.string().min(1),
    /** Which review these findings came from, and which cycle of repairs this was. */
    reviewCycle: z.number().int().positive(),
    repairCycle: z.number().int().positive(),
    /** The scope a human approved by digest. Lineage to the plan, by reference. */
    planDigest: identitySchema,
    patchBeforeIdentity: identitySchema,
    patchAfterIdentity: identitySchema,
    patchChanged: z.boolean(),
    /** False only when this cycle moved no bytes, which is not a repair. */
    verificationRequired: z.boolean(),
    /** Stage 9's guard's own words: what changed, and whether it was planned. */
    scope: repairScopeDeltaSchema,
    /** Stage 6's own record of this cycle — writes, refusals, bounds, claims. */
    implementation: implementationRecordSchema,
    createdAt: z.string().min(1),
  })
  .strict();

export type RepairExecution = z.infer<typeof repairExecutionSchema>;

export interface RepairExecutionInput {
  readonly plan: RepairPlan;
  /**
   * The human's yes, or nothing. Optional in the *input* rather than required so a
   * caller that has no approval can still reach this function and be refused; there
   * is no path through it that records a cycle nobody approved.
   */
  readonly approval?: RepairApproval | null;
  /** Measured from the workspace immediately before the cycle ran. */
  readonly patchBefore: PatchDescription;
  /** Measured from the workspace after it, from the same base. */
  readonly patchAfter: PatchDescription;
  readonly implementation: ImplementationRecord;
  readonly createdAt: string;
}

function refusal(message: string, remediation: string, details: Record<string, unknown>): never {
  throw new AppError({ kind: 'validation', message, remediation, details });
}

/**
 * Assemble one cycle's record, or refuse to.
 *
 * The order of the checks is the order of the stakes. Consent comes first, before
 * anything is measured or compared, because a caller that has no approval has no
 * business asking what a repair did; then the run identity, because a loop record
 * from another run would attribute one contribution's edits to another; and only
 * then the patch arithmetic, which the scope guard does and whose preconditions
 * are inherited rather than restated here.
 */
export function buildRepairExecution(input: RepairExecutionInput): RepairExecution {
  const decision = decideRepairApproval({ plan: input.plan, approval: input.approval ?? null });
  if (!decision.allowed) {
    refusal(
      decision.reason,
      'Freeze the plan, show it and its files to a human, and pass the approval they gave for that digest.',
      { status: decision.status, runId: input.plan.runId },
    );
  }

  if (input.implementation.runId !== input.plan.runId) {
    refusal(
      `This cycle's loop record belongs to run ${input.implementation.runId} and the plan is frozen for run ${input.plan.runId}, so the two are not the same work.`,
      'Pass the implementation record from the loop that ran against this run’s workspace.',
      { implementationRunId: input.implementation.runId, planRunId: input.plan.runId },
    );
  }

  const scope = classifyRepairScope({
    plan: input.plan,
    patchBefore: input.patchBefore,
    patchAfter: input.patchAfter,
  });

  return repairExecutionSchema.parse({
    schemaVersion: REPAIR_EXECUTION_SCHEMA_VERSION,
    runId: input.plan.runId,
    reviewCycle: input.plan.reviewCycle,
    repairCycle: input.plan.repairCycle,
    // The digest this build computed, not the string the caller happened to hold:
    // a yes typed in uppercase is the same yes, and the record should read the same
    // either way.
    planDigest: decision.expectedDigest,
    patchBeforeIdentity: scope.reviewedPatchIdentity,
    patchAfterIdentity: scope.repairPatchIdentity,
    patchChanged: scope.patchChanged,
    verificationRequired: scope.patchChanged,
    scope,
    implementation: input.implementation,
    createdAt: input.createdAt,
  });
}

/**
 * Read a stored execution back.
 *
 * A document with an extra key is not a repair record with a harmless annotation;
 * it is a record somebody wrote a verdict into, so unknown keys are refused by name
 * rather than dropped.
 */
export function parseRepairExecution(value: unknown): RepairExecution {
  const parsed = repairExecutionSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to accept this repair execution record: ${issue?.path.join('.') ?? 'document'}: ${issue?.message ?? 'it is malformed'}.`,
      remediation:
        'A repair execution is written by a repair cycle from a plan, an approval and two measurements of one patch. It is not authored by hand.',
      details: { reason: issue?.message ?? 'malformed' },
    });
  }
  return parsed.data;
}

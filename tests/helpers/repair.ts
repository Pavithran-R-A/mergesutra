import { buildReviewDocument, type ReviewDocument } from '../../src/review/schema.js';
import { buildRepairExecution, type RepairExecution } from '../../src/repair/execution.js';
import { approveRepairPlan } from '../../src/repair/consent.js';
import {
  REPAIR_PLAN_SCHEMA_VERSION,
  parseRepairPlan,
  type RepairPlan,
} from '../../src/repair/plan.js';
import type { ImplementationRecord } from '../../src/implement/state.js';
import type { PatchDescription } from '../../src/verify/patch.js';

/**
 * The documents a run holds once it has been reviewed and repaired.
 *
 * Stage 9R's tests need a repair cycle that is *real* — a plan that passed the
 * repair plan's own schema, an approval derived from that plan's digest, an
 * execution that the builder agreed to write — because the whole lifecycle rule
 * they go on to test is about which of these documents a later stage may quote.
 * Hand-written literals would let a test pass over a document no builder would
 * ever produce, which is the failure mode this product exists to prevent.
 *
 * A cycle that changed nothing is what these build. That is deliberate: a changed
 * patch would mean two measurements, and a test fixture that invents the second
 * one is claiming bytes it never saw. Callers that need a moved patch measure it
 * and pass it in.
 */

export function frozenPlan(input: {
  readonly runId: string;
  readonly criteria: readonly string[];
  readonly patchIdentity: string;
  readonly expectedChecks: readonly string[];
  readonly expectedFiles?: readonly string[];
  readonly repairCycle?: number;
  readonly createdAt: string;
}): RepairPlan {
  return parseRepairPlan({
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: input.runId,
    reviewCycle: 1,
    repairCycle: input.repairCycle ?? 1,
    reviewedPatchIdentity: input.patchIdentity,
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: [...input.criteria],
        intendedChange: 'Give the parser the branch the criterion asks for.',
        expectedFiles: [...(input.expectedFiles ?? ['src/parse.ts'])],
        expectedChecks: [...input.expectedChecks],
      },
    ],
    criteria: [...input.criteria],
    expectedFiles: [...(input.expectedFiles ?? ['src/parse.ts'])],
    expectedChecks: [...input.expectedChecks],
    createdAt: input.createdAt,
  });
}

/** One cycle a human approved by digest, over a patch that came back unchanged. */
export function cycleFor(input: {
  readonly plan: RepairPlan;
  readonly patch: PatchDescription;
  readonly implementation: ImplementationRecord;
  readonly createdAt: string;
}): RepairExecution {
  return buildRepairExecution({
    plan: input.plan,
    approval: approveRepairPlan({ plan: input.plan, approvedAt: input.createdAt }),
    patchBefore: input.patch,
    patchAfter: input.patch,
    implementation: input.implementation,
    createdAt: input.createdAt,
  });
}

/** A review that filed nothing, which is the only verdict a helper may invent. */
export function reviewWithoutFindings(input: {
  readonly runId: string;
  readonly baseSha: string;
  readonly patchIdentity: string;
  readonly at: string;
}): ReviewDocument {
  return buildReviewDocument({
    runId: input.runId,
    baseSha: input.baseSha,
    reviewedPatchIdentity: input.patchIdentity,
    currentPatchIdentity: input.patchIdentity,
    modelId: 'scripted-review-model',
    reviewedAt: input.at,
    attempts: 1,
    body: { summary: 'Nothing to report on these bytes.', findings: [] },
    dispositions: [],
  });
}

import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { criterionIdSchema } from '../plan/schema.js';
import type { ReviewContextManifest } from '../review/manifest.js';
import type { ReviewDocument } from '../review/schema.js';
import { isRepositoryRelativePath } from '../security/path-safety.js';
import type { RunRecord } from '../state/run-record.js';
import {
  MAX_REPAIR_CYCLES_CEILING,
  MAX_REVIEW_CYCLES_CEILING,
  resolveLimit,
  type RepairLimits,
} from './bounds.js';

/**
 * The frozen repair plan — what one repair cycle is for.
 *
 * This is the only document Stage 9 writes that turns a model's words into work,
 * so it is built from findings MergeSutra has already weighed against the
 * manifest, and it stops there. It names the patch those findings describe, the
 * files they point at and the gates they answer to; it has no field for how the
 * repair went, because a plan that could report success would be a model grading
 * its own edit. What a repair achieved is decided by re-verifying the bytes it
 * actually left behind.
 *
 * Two absences do the security work. There is no command anywhere in it — checks
 * are gate ids the run already has receipts for, so a plan cannot become a shell
 * string with a schema drawn around it — and no file that was not in the reviewed
 * material, so it cannot point a writer at anything a reviewer never saw.
 *
 * It is written down before anything is mutated. A reader who finds a changed
 * workspace and no plan has a run that edited on a model's say-so, which is the
 * failure this document exists to make visible.
 */

export const REPAIR_PLAN_SCHEMA_VERSION = 1;

const identitySchema = z.string().regex(/^[0-9a-f]{64}$/, 'A patch identity is a sha256 digest.');
const gateIdSchema = z
  .string()
  .regex(/^VG-\d{3}$/, 'A repair may only be aimed at a verification gate id like VG-001.');
const repositoryFileSchema = z.string().min(1).refine(isRepositoryRelativePath, {
  message:
    'A repair may only name a repository-relative path inside the reviewed workspace. A file outside it cannot be reached by the confined writer, so planning one would be a request to escape.',
});
const taskSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0, {
    message: 'A repair item must say what to change.',
  });

export const repairItemSchema = z
  .object({
    findingId: z.string().regex(/^RF-\d{3}$/, 'expected a finding id like RF-001'),
    criterionIds: z.array(criterionIdSchema).default([]),
    /** The reviewer's own proposed action, kept as a description of work. */
    intendedChange: taskSchema,
    expectedFiles: z
      .array(repositoryFileSchema)
      .min(
        1,
        'A repair item must name at least one file to change, or there is nothing to confine.',
      ),
    expectedChecks: z.array(gateIdSchema).default([]),
  })
  .strict();

export const repairPlanSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_PLAN_SCHEMA_VERSION),
    runId: z.string().min(1),
    reviewCycle: z.number().int().positive(),
    repairCycle: z.number().int().positive(),
    /** The bytes these findings describe. A repair that changes them invalidates this plan. */
    reviewedPatchIdentity: identitySchema,
    findings: z.array(repairItemSchema).min(1),
    criteria: z.array(criterionIdSchema),
    expectedFiles: z.array(repositoryFileSchema),
    expectedChecks: z.array(gateIdSchema),
    createdAt: z.string().min(1),
  })
  .strict();

export type RepairItem = z.infer<typeof repairItemSchema>;
export type RepairPlan = z.infer<typeof repairPlanSchema>;

export interface BuildRepairPlanInput {
  readonly record: RunRecord;
  readonly review: ReviewDocument;
  readonly manifest: ReviewContextManifest;
  readonly reviewCycle: number;
  readonly repairCycle: number;
  readonly createdAt: string;
  readonly limits?: Partial<RepairLimits>;
}

function refusal(message: string, remediation: string, details: Record<string, unknown>): never {
  throw new AppError({
    kind: 'validation',
    message,
    remediation,
    details,
  });
}

/**
 * Freeze a plan from the candidates in one review.
 *
 * Every precondition here is a fact about provenance rather than a preference:
 * the review must belong to this run, must describe the patch the manifest
 * vouched for, and must contain something MergeSutra called a repair candidate.
 * A review that has gone stale is refused outright — its findings are about bytes
 * that no longer exist, and repairing to them would edit against a description.
 */
export function buildRepairPlan(input: BuildRepairPlanInput): RepairPlan {
  const { record, review, manifest } = input;

  if (review.runId !== record.runId) {
    refusal(
      `This review is for run ${review.runId} and cannot be planned against run ${record.runId}.`,
      'Pass the review that belongs to the record it was written for.',
      { reviewRunId: review.runId, recordRunId: record.runId },
    );
  }

  if (review.patchPrecondition.status === 'STALE') {
    refusal(
      'The patch moved after this review, so its findings describe bytes that are gone.',
      'Re-run the review against the current patch, then plan a repair from that.',
      {
        reviewedPatchIdentity: review.reviewedPatchIdentity,
        currentPatchIdentity: review.currentPatchIdentity,
      },
    );
  }

  if (manifest.reviewedPatchIdentity !== review.reviewedPatchIdentity) {
    refusal(
      'The context manifest vouches for a different patch identity than the review does.',
      'Author the manifest and the review from the same pinned patch.',
      {
        manifestIdentity: manifest.reviewedPatchIdentity,
        reviewIdentity: review.reviewedPatchIdentity,
      },
    );
  }

  const reviewCeiling = resolveLimit('maxReviewCycles', input.limits?.maxReviewCycles);
  const repairCeiling = resolveLimit('maxRepairCycles', input.limits?.maxRepairCycles);
  if (input.reviewCycle > reviewCeiling || input.repairCycle > repairCeiling) {
    refusal(
      `Review cycle ${input.reviewCycle} and repair cycle ${input.repairCycle} are past this build's limits of ${reviewCeiling} and ${repairCeiling}. The ceilings no caller may raise are ${MAX_REVIEW_CYCLES_CEILING} review cycles and ${MAX_REPAIR_CYCLES_CEILING} repair cycles.`,
      'Stop routing this run and send what remains to a human; another cycle is not a remedy.',
      {
        reviewCycle: input.reviewCycle,
        repairCycle: input.repairCycle,
        maxReviewCycles: reviewCeiling,
        maxRepairCycles: repairCeiling,
      },
    );
  }

  const candidates = review.findings.filter(
    (finding) => finding.disposition === 'VALID_REPAIR_CANDIDATE',
  );
  if (candidates.length === 0) {
    refusal(
      `Nothing in this review is a repair candidate: ${review.findings.length} finding(s), none MergeSutra weighed as one.`,
      'A review whose findings went to a human, or were refused as unsupported, is not a work order.',
      { findings: review.findings.length },
    );
  }

  const cap = resolveLimit('maxFindingsPerRepair', input.limits?.maxFindingsPerRepair);
  if (candidates.length > cap) {
    refusal(
      `A repair cycle carries at most ${cap} findings and this review has ${candidates.length} candidates.`,
      `Route ${candidates.length - cap} of them to a human, or to a later cycle if one is left. A cap a caller could raise would not be a bound.`,
      { candidates: candidates.length, maxFindingsPerRepair: cap },
    );
  }

  const byRef = new Map(manifest.references.map((reference) => [reference.ref, reference]));
  const gates = record.verificationPlan?.gates ?? [];

  const items = candidates.map((finding) => {
    const references = finding.contextRefs.flatMap((ref) => {
      const found = byRef.get(ref);
      return found ? [found] : [];
    });
    const files = [
      ...new Set(references.flatMap((reference) => (reference.path ? [reference.path] : []))),
    ].sort();
    const criterionIds = [...new Set(finding.criterionIds)].sort();
    /**
     * The gates this run already promised those criteria, plus any receipt the
     * reviewer cited. Not the evidence rows' `gateIds`: those are empty exactly
     * when a gate could not be credited to a criterion, and a repair plan that
     * inherited that emptiness would schedule a fix with nothing to re-run.
     */
    const checks = [
      ...new Set([
        ...references.flatMap((reference) => (reference.gateId ? [reference.gateId] : [])),
        ...gates
          .filter((gate) => gate.relevantCriteria.some((id) => criterionIds.includes(id)))
          .map((gate) => gate.id),
      ]),
    ].sort();

    return repairItemSchema.parse({
      findingId: finding.id,
      criterionIds,
      intendedChange: finding.proposedAction,
      expectedFiles: files,
      expectedChecks: checks,
    });
  });

  return parseRepairPlan({
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: record.runId,
    reviewCycle: input.reviewCycle,
    repairCycle: input.repairCycle,
    reviewedPatchIdentity: review.reviewedPatchIdentity,
    findings: items,
    criteria: [...new Set(items.flatMap((item) => [...item.criterionIds]))].sort(),
    expectedFiles: [...new Set(items.flatMap((item) => [...item.expectedFiles]))].sort(),
    expectedChecks: [...new Set(items.flatMap((item) => [...item.expectedChecks]))].sort(),
    createdAt: input.createdAt,
  });
}

export function parseRepairPlan(value: unknown): RepairPlan {
  return repairPlanSchema.parse(value);
}

import { z } from 'zod';
import { AppError } from '../core/errors.js';
import type { PatchDescription, PatchFileFact } from '../verify/patch.js';
import type { RepairPlan } from './plan.js';

/**
 * The scope guard — what the repair itself did, Stage 9.
 *
 * A repair cycle ends with two things: a plan that says what was meant, and a
 * workspace that says what happened. This module holds them side by side and
 * writes down the difference, because the difference is the only part a reader
 * cannot reconstruct afterwards — the plan is on disk, the workspace is on disk,
 * and which bytes came from which stage is exactly the fact that gets lost.
 *
 * It compares two *measurements of the same patch*, both from Stage 7's
 * `describePatch`, and reasons about the delta between them. That framing is the
 * whole design. The repaired patch still contains every file the contribution
 * touched, so listing patch B and calling it "the repair's work" would credit or
 * blame this cycle for the earlier stages' edits — and, worse, would bury the one
 * path nobody planned among a dozen that were always there. A file counts as the
 * repair's only if its bytes, its presence, or its change kind moved between the
 * two measurements.
 *
 * Two limits are worth stating because they are the point of the exercise. This
 * document describes; it has no writer, so an unexpected file is reported and
 * stays exactly where it is — quietly deleting a model's work would be the same
 * overreach from the other direction. And it has no verdict, so an in-scope repair
 * is not a passing one: `WITHIN_PLANNED_SCOPE` means only "nothing outside the
 * plan was touched", and what the repair achieved is decided by re-running the
 * gates against the new bytes.
 */

export const REPAIR_SCOPE_SCHEMA_VERSION = 1;

const identitySchema = z.string().regex(/^[0-9a-f]{64}$/, 'A patch identity is a sha256 digest.');

export const repairFileDeltaSchema = z.enum([
  'ADDED_BY_REPAIR',
  'CHANGED_BY_REPAIR',
  'REMOVED_BY_REPAIR',
  'UNCHANGED',
]);
export type RepairFileDelta = z.infer<typeof repairFileDeltaSchema>;

export const repairFileScopeSchema = z.enum(['EXPECTED', 'UNEXPECTED', 'PRE_EXISTING_PATCH_FILE']);
export type RepairFileScope = z.infer<typeof repairFileScopeSchema>;

export const repairScopeOutcomeSchema = z.enum([
  'WITHIN_PLANNED_SCOPE',
  'OUTSIDE_PLANNED_SCOPE',
  'REPAIR_LEFT_NO_TRACE',
]);
export type RepairScopeOutcome = z.infer<typeof repairScopeOutcomeSchema>;

export const scopeFileSchema = z
  .object({
    path: z.string().min(1),
    delta: repairFileDeltaSchema,
    classification: repairFileScopeSchema,
  })
  .strict();
export type ScopeFile = z.infer<typeof scopeFileSchema>;

export const repairScopeDeltaSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_SCOPE_SCHEMA_VERSION),
    runId: z.string().min(1),
    reviewCycle: z.number().int().positive(),
    repairCycle: z.number().int().positive(),
    /** The patch the findings were written about, and which the plan was frozen for. */
    reviewedPatchIdentity: identitySchema,
    /** The patch the workspace holds now. */
    repairPatchIdentity: identitySchema,
    patchChanged: z.boolean(),
    files: z.array(scopeFileSchema).readonly(),
    unexpectedFiles: z.array(z.string()).readonly(),
    plannedButUntouchedFiles: z.array(z.string()).readonly(),
    outcome: repairScopeOutcomeSchema,
  })
  .strict();
export type RepairScopeDelta = z.infer<typeof repairScopeDeltaSchema>;

export interface ClassifyRepairScopeInput {
  readonly plan: RepairPlan;
  /** Measured immediately before the repair, from the same base as `patchAfter`. */
  readonly patchBefore: PatchDescription;
  /** Measured after the repair, from the same base. */
  readonly patchAfter: PatchDescription;
}

function refuse(message: string, remediation: string, details: Record<string, unknown>): never {
  throw new AppError({ kind: 'validation', message, remediation, details });
}

function byPath(patch: PatchDescription): Map<string, PatchFileFact> {
  return new Map(patch.files.map((file) => [file.path, file]));
}

function moved(
  before: PatchFileFact | undefined,
  after: PatchFileFact | undefined,
): RepairFileDelta {
  if (!before) return after ? 'ADDED_BY_REPAIR' : 'UNCHANGED';
  if (!after) return 'REMOVED_BY_REPAIR';
  if (before.change !== after.change) return 'CHANGED_BY_REPAIR';
  return before.contentSha256 === after.contentSha256 ? 'UNCHANGED' : 'CHANGED_BY_REPAIR';
}

/**
 * Compare the two measurements against the plan's named files.
 *
 * The preconditions are what make the comparison mean anything. A plan was frozen
 * for one patch, so measuring the "before" state from any other patch would
 * classify files the findings never described as though the repair had produced
 * them; and two diffs of different bases are not two views of one contribution,
 * they are two unrelated answers.
 */
export function classifyRepairScope(input: ClassifyRepairScopeInput): RepairScopeDelta {
  const { plan, patchBefore, patchAfter } = input;

  if (patchBefore.identity !== plan.reviewedPatchIdentity) {
    refuse(
      'The "before" measurement is not the patch this plan was frozen for, so it describes a different patch than the findings do.',
      'Capture the patch identity immediately before the repair and pass that measurement, with the plan that names it.',
      {
        measuredIdentity: patchBefore.identity,
        plannedIdentity: plan.reviewedPatchIdentity,
      },
    );
  }

  if (patchBefore.baseSha !== patchAfter.baseSha) {
    refuse(
      `The two measurements were diffed against different bases (${patchBefore.baseSha} and ${patchAfter.baseSha}), so there is no delta between them to classify.`,
      'Describe both patches from the base the run recorded.',
      { before: patchBefore.baseSha, after: patchAfter.baseSha },
    );
  }

  const before = byPath(patchBefore);
  const after = byPath(patchAfter);
  const planned = new Set(plan.expectedFiles);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();

  const files = paths.map((path) => {
    const delta = moved(before.get(path), after.get(path));
    const classification: RepairFileScope =
      delta === 'UNCHANGED'
        ? 'PRE_EXISTING_PATCH_FILE'
        : planned.has(path)
          ? 'EXPECTED'
          : 'UNEXPECTED';
    return scopeFileSchema.parse({ path, delta, classification });
  });

  const unexpectedFiles = files
    .filter((file) => file.classification === 'UNEXPECTED')
    .map((file) => file.path);
  const touched = new Set(
    files.filter((file) => file.delta !== 'UNCHANGED').map((file) => file.path),
  );
  const plannedButUntouchedFiles = plan.expectedFiles.filter((path) => !touched.has(path)).sort();
  const patchChanged = patchBefore.identity !== patchAfter.identity;

  const outcome: RepairScopeOutcome =
    unexpectedFiles.length > 0
      ? 'OUTSIDE_PLANNED_SCOPE'
      : patchChanged
        ? 'WITHIN_PLANNED_SCOPE'
        : 'REPAIR_LEFT_NO_TRACE';

  return repairScopeDeltaSchema.parse({
    schemaVersion: REPAIR_SCOPE_SCHEMA_VERSION,
    runId: plan.runId,
    reviewCycle: plan.reviewCycle,
    repairCycle: plan.repairCycle,
    reviewedPatchIdentity: patchBefore.identity,
    repairPatchIdentity: patchAfter.identity,
    patchChanged,
    files,
    unexpectedFiles,
    plannedButUntouchedFiles,
    outcome,
  });
}

/**
 * Where a repair cycle goes next.
 *
 * Only one of the three outcomes leads back to the gates. A repair that reached
 * outside its plan cannot be re-verified as though the extra edits were intended
 * — the verification would then be evidence for work nobody approved — and a
 * repair that left no trace cannot be called a repair, however much the model said
 * it finished. Both go to a human with the delta attached.
 *
 * Note what is absent: no route here says "ready". Even the in-scope path only
 * earns the right to be verified again.
 */
export function routeRepairScope(
  delta: RepairScopeDelta,
): 'REVERIFY_THROUGH_STAGE_7' | 'NEEDS_HUMAN_REVIEW' {
  return delta.outcome === 'WITHIN_PLANNED_SCOPE'
    ? 'REVERIFY_THROUGH_STAGE_7'
    : 'NEEDS_HUMAN_REVIEW';
}

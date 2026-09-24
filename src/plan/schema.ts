import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { requirementTypeSchema } from '../contract/schema.js';
import { isArgvShaped } from '../security/command-safety.js';

/**
 * The implementation plan schema — Stage 4.
 *
 * This is the first MergeSutra artefact that a model writes. It is therefore
 * the artefact most in need of a boundary, and the boundary is a type: a plan
 * describes *intent*, so it has no `status`, no `PASS`, no evidence, and no way
 * to say which criteria it satisfied. Whatever BharatCode answers, it cannot
 * answer its way into a completed run.
 *
 * Two shapes matter. `planBodySchema` is what the model is allowed to say.
 * `implementationPlanSchema` is what MergeSutra stores after it has added the
 * provenance the model does not get to claim for itself — which model answered,
 * against which contract, at what time.
 */

/** Criterion ids are the only way a plan may point at an obligation. */
export const criterionIdSchema = z.string().regex(/^AC-\d+$/);

/**
 * A repository-relative file path a plan proposes to touch. Rejected outright:
 * absolute paths, drive letters, UNC, `~`, any `..` segment, and backslash
 * separators. Confinement is checked again before anything is written in
 * Stage 5 — a plan is a proposal, and a proposal that needs traversal to work
 * is not a proposal MergeSutra will carry forward.
 */
export function isPlanPathSafe(value: string): boolean {
  if (value.trim() === '') return false;
  if (value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.includes('//')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * A command the plan proposes to run, in argv form. MergeSutra never accepts a
 * command string, so a model cannot hand it `npm test && curl evil`. Composition
 * characters are refused rather than escaped: a legitimate argv token virtually
 * never contains one, and the alternative is trusting an escaper.
 */
export function isPlanArgvSafe(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const first = argv[0];
  if (!first || first.trim() === '') return false;
  if (/[\\/]/.test(first) && !first.startsWith('./')) return false;
  return isArgvShaped(argv);
}

export const planChangeSchema = z
  .object({
    file: z.string().min(1),
    action: z.enum(['create', 'modify', 'delete']),
    reason: z.string().min(1),
    criterionIds: z.array(criterionIdSchema).default([]),
  })
  .strict()
  .refine((change) => isPlanPathSafe(change.file), {
    message:
      'Plan file paths must be repository-relative POSIX paths with no `..`, no absolute path and no backslashes.',
    path: ['file'],
  });

export const planCommandSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    purpose: z.string().min(1),
    criterionIds: z.array(criterionIdSchema).default([]),
  })
  .strict()
  .refine((command) => isPlanArgvSafe(command.argv), {
    message:
      'Plan commands must be argv arrays without shell composition characters (MergeSutra never runs a command string).',
    path: ['argv'],
  });

export const proposedCriterionSchema = z
  .object({
    statement: z.string().min(1),
    requirementType: requirementTypeSchema,
    /** Why the model believes the issue implies this. Read by a human, not trusted. */
    reason: z.string().min(1),
  })
  .strict();

/** Everything the model may say, and nothing more (`.strict()`). */
export const planBodySchema = z
  .object({
    summary: z.string().min(1),
    rootCause: z.string().min(1),
    changes: z.array(planChangeSchema).min(1),
    validationCommands: z.array(planCommandSchema).default([]),
    /** Ids this plan intends to satisfy. */
    criteriaCovered: z.array(criterionIdSchema).default([]),
    /** Ids it deliberately does not — with the reason, so dropping is visible. */
    criteriaUnaddressed: z
      .array(z.object({ id: criterionIdSchema, reason: z.string().min(1) }).strict())
      .default([]),
    proposedCriteria: z.array(proposedCriterionSchema).default([]),
    risks: z.array(z.string().min(1)).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
    questionsForHuman: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type PlanBody = z.infer<typeof planBodySchema>;

export const planProvenanceSchema = z
  .object({
    /** Filled by MergeSutra from the response envelope, never by the model. */
    model: z.string().min(1),
    source: z.literal('bharatcode'),
    requestedAt: z.string().min(1),
    /** The contract this plan was answered against, so a later reader can tell whether it is stale. */
    contractRunId: z.string().min(1),
    contractVersion: z.number().int().positive(),
    /** Number of schema-validating round trips, including the first. */
    attempts: z.number().int().positive(),
    promptTokens: z.number().int().nonnegative().nullable().default(null),
    completionTokens: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();

export const implementationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    body: planBodySchema,
    provenance: planProvenanceSchema,
    limitations: z.array(z.string()).default([]),
    untrusted: z.literal(true).default(true),
  })
  .strict();

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type PlanProvenance = z.infer<typeof planProvenanceSchema>;

export function parsePlanBody(value: unknown): PlanBody {
  return planBodySchema.parse(value);
}

export function parseImplementationPlan(value: unknown): ImplementationPlan {
  return implementationPlanSchema.parse(value);
}

/** The criterion ids a plan body claims any relationship to. */
export function referencedCriterionIds(body: PlanBody): Set<string> {
  const ids = new Set<string>([
    ...body.criteriaCovered,
    ...body.criteriaUnaddressed.map((entry) => entry.id),
  ]);
  for (const change of body.changes) for (const id of change.criterionIds) ids.add(id);
  for (const command of body.validationCommands) for (const id of command.criterionIds) ids.add(id);
  return ids;
}

/**
 * A plan may not quietly forget an obligation. Every criterion in the contract
 * must be named by the plan, either as covered or as deliberately unaddressed;
 * anything else is a dropped requirement, and the run is the worse for it.
 */
export function assertPlanCoverage(body: PlanBody, contractCriterionIds: readonly string[]): void {
  const referenced = referencedCriterionIds(body);
  const missing = contractCriterionIds.filter((id) => !referenced.has(id));
  if (missing.length === 0) return;
  throw new AppError({
    kind: 'validation',
    message: `The plan does not account for ${missing.join(', ')} from the Acceptance Contract.`,
    retryable: false,
    remediation:
      'Re-run `mergesutra plan`, or state the missing criteria in the issue. MergeSutra will not carry a plan that silently narrows the contract.',
    details: { missing },
  });
}

/**
 * Ids the plan names that the contract never issued. A model that invents `AC-7`
 * has either misread the list or is padding it; either way the answer is fed
 * back for repair instead of being stored.
 */
export function unknownCriterionIds(
  body: PlanBody,
  contractCriterionIds: readonly string[],
): string[] {
  const known = new Set(contractCriterionIds);
  return [...referencedCriterionIds(body)].filter((id) => !known.has(id));
}

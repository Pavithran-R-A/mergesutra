import { z } from 'zod';

/**
 * The Acceptance Contract schema — Stage 3.
 *
 * A *repository* contract says what a repository demands of any change. This
 * contract says what **one particular patch** must prove before MergeSutra may
 * call the issue closed, and every `PASS` in it must point at evidence that
 * actually exists. That is why nothing here has a `confidence`, a `score`, or a
 * free-form "notes" field: those are places a run can become untruthful.
 *
 * Design: `docs/ACCEPTANCE_CONTRACT.md`. The types are derived from the Zod
 * schemas, and each discriminated union is built through a small helper because
 * `z.discriminatedUnion` loses its literal narrowing once it is wrapped in
 * `z.optional()` — and a branch that cannot narrow cannot prevent a
 * `PASS`-without-evidence from being written at all.
 */

/** What kind of thing a criterion is about. */
export const requirementTypeSchema = z.enum([
  'functional',
  'compatibility',
  'convention',
  'safety',
  'scope',
]);
export type RequirementType = z.infer<typeof requirementTypeSchema>;

/**
 * Where the requirement came from. `repository_policy` and `inferred` are the
 * two an implementation stage must never use to launder its own preferences:
 * only a file (`repository_policy`), the issue (`issue`), or a human (`human`)
 * can put a requirement here.
 */
export const criterionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), detail: z.string() }).strict(),
  z
    .object({ kind: z.literal('repository_policy'), file: z.string(), line: z.number().nullable() })
    .strict(),
  z.object({ kind: z.literal('inferred'), reason: z.string() }).strict(),
  z.object({ kind: z.literal('human'), by: z.string() }).strict(),
]);
export type CriterionSource = z.infer<typeof criterionSourceSchema>;

export const checkSourceSchema = z.enum([
  'REPOSITORY_REQUIRED',
  'MERGESUTRA_ADDITIONAL',
  'OPTIONAL',
]);
export type CheckSource = z.infer<typeof checkSourceSchema>;

/**
 * How a criterion will be checked. `command` is the argv form and is only
 * allowed on the kinds that run a command — a `static_review` step that claims
 * to have run something would be a lie the type system should have refused.
 */
const verificationStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['test', 'lint', 'format', 'typecheck', 'build', 'secret_scan']),
      command: z.string(),
      source: checkSourceSchema,
      /** Where the command came from, so a reader can verify the claim. */
      from: z.string().nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['static_review', 'manual']),
      source: checkSourceSchema,
      from: z.string().nullable().default(null),
    })
    .strict(),
]);
export type VerificationStep = z.infer<typeof verificationStepSchema>;

/**
 * A fact that a check happened and what it produced. Built as a union of an
 * unexecuted branch and an executed one so that a recorded outcome has to carry
 * its exit code: `evidence: { executed: true }` without `result` will not type,
 * and neither will a `result` without a `command` that produced it.
 */
const evidenceSchema = z.discriminatedUnion('executed', [
  z
    .object({
      executed: z.literal(false),
      /** Why nothing ran: skipped by policy, tool missing, gate not applicable. */
      reason: z.string(),
      provenance: z.string(),
    })
    .strict(),
  z
    .object({
      executed: z.literal(true),
      command: z.string(),
      result: z.discriminatedUnion('status', [
        z
          .object({
            status: z.enum(['PASS', 'FAIL']),
            exitCode: z.number().int(),
            /** Where the captured output lives; never inlined, never secret. */
            outputRef: z.string().nullable().default(null),
            durationMs: z.number().int().nonnegative().nullable().default(null),
          })
          .strict(),
        z
          .object({
            status: z.enum(['BLOCKED', 'INCONCLUSIVE']),
            reason: z.string(),
          })
          .strict(),
      ]),
      provenance: z.string(),
    })
    .strict(),
]);
export type Evidence = z.infer<typeof evidenceSchema>;

export const criterionStatusSchema = z.enum([
  'PENDING',
  'PASS',
  'FAIL',
  'SKIPPED',
  'NOT_AVAILABLE',
  'BLOCKED',
  'INCONCLUSIVE',
]);
export type CriterionStatus = z.infer<typeof criterionStatusSchema>;

/**
 * A criterion at rest is `PENDING` with no evidence. This is the type-level
 * statement of the project's central rule: a status of `PASS` is only
 * constructible together with the evidence that justifies it.
 */
const criterionSchema = z.discriminatedUnion('status', [
  z
    .object({
      id: z.string().regex(/^AC-\d+$/),
      statement: z.string(),
      requirementType: requirementTypeSchema,
      source: criterionSourceSchema,
      verificationPlan: z.array(verificationStepSchema),
      status: z.literal('PENDING'),
      evidence: z.array(z.never()).length(0).default([]),
      limitations: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^AC-\d+$/),
      statement: z.string(),
      requirementType: requirementTypeSchema,
      source: criterionSourceSchema,
      verificationPlan: z.array(verificationStepSchema),
      status: z.enum(['FAIL', 'SKIPPED', 'NOT_AVAILABLE', 'BLOCKED', 'INCONCLUSIVE']),
      evidence: z.array(evidenceSchema),
      limitations: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^AC-\d+$/),
      statement: z.string(),
      requirementType: requirementTypeSchema,
      source: criterionSourceSchema,
      verificationPlan: z.array(verificationStepSchema),
      status: z.literal('PASS'),
      evidence: z.array(evidenceSchema).min(1),
      limitations: z.array(z.string()).default([]),
    })
    .strict(),
]);
export type AcceptanceCriterion = z.infer<typeof criterionSchema>;

/**
 * Why the criteria changed after the first derivation. `reason` is required,
 * and the ids are listed explicitly so a dropped criterion leaves a trace
 * rather than vanishing between runs.
 */
export const contractRevisionSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().min(1),
    /** Ids this revision introduced, changed, or removed. */
    affectedCriterionIds: z.array(z.string()),
    createdAt: z.string(),
  })
  .strict();
export type ContractRevision = z.infer<typeof contractRevisionSchema>;

export const acceptanceContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Which contract shape produced this one. Bumped only on a real change. */
    version: z.number().int().positive(),
    runId: z.string(),
    issueUrl: z.string().nullable(),
    /** Pinned identity inherited from intake; a contract cannot move it. */
    repository: z
      .object({
        fullName: z.string().nullable(),
        baseSha: z.string().nullable(),
        localPath: z.string().nullable(),
      })
      .strict(),
    criteria: z.array(criterionSchema).min(1),
    revisions: z.array(contractRevisionSchema).default([]),
    /**
     * What this contract does not know. Mandatory: a contract that has looked
     * at everything is a contract that has not looked hard enough.
     */
    limitations: z.array(z.string()).default([]),
    untrusted: z.literal(true).default(true),
  })
  .strict();
export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>;

export function parseAcceptanceContract(value: unknown): AcceptanceContract {
  return acceptanceContractSchema.parse(value);
}

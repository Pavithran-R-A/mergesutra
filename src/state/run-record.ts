import { z } from 'zod';
import { acceptanceContractSchema } from '../contract/schema.js';
import { AppError } from '../core/errors.js';
import { repositoryContractSchema } from '../discovery/contract.js';
import { implementationRecordSchema } from '../implement/state.js';
import { implementationPlanSchema } from '../plan/schema.js';
import { reviewDocumentSchema } from '../review/schema.js';
import { VERSION } from '../version.js';
import { executionConsentSchema } from '../verify/consent.js';
import { verificationRunSchema } from '../verify/engine.js';
import { acceptanceEvidenceSchema } from '../verify/evidence.js';
import { verificationPlanSchema } from '../verify/plan.js';

/**
 * The run record: everything MergeSutra has established so far, in one
 * versioned document.
 *
 * It exists for two reasons. Later stages must be able to resume without
 * re-asking GitHub, and a human must be able to audit what a run actually
 * believed at the time. So the record keeps provenance with each value — not
 * just "baseSha" but how the SHA was learned — and it is schema-validated on
 * load, because a stale or hand-edited record must fail loudly rather than
 * silently mislead a later stage.
 *
 * Version 5 added the Stage 6 loop record beside the plan. A plan says what a
 * model proposed; an implementation record says what MergeSutra actually ran,
 * refused and wrote. Keeping both in one document is what lets a reader compare
 * the claim against the actions without opening two files.
 *
 * Version 6 adds Stage 7's four documents: the verification plan (a promise
 * made before anything ran), the verification run (what happened to it), the
 * execution consent (which gates a human named), and the acceptance evidence
 * (what each criterion may claim). None of them can say the contribution is
 * ready — that word lives in no schema in this file, by design.
 *
 * Version 7 adds Stage 9's review document, and it is the first bump this file
 * has had to answer for: records written by 6 are already on disk, in runs a
 * human may still be reading, and this product's whole promise is that a later
 * stage can pick up a run from the evidence on disk. So the bump is additive and
 * the reader is version-aware. A 6 record is validated as a 6 record, then given
 * `review: null` in memory — never an empty review, which would say a reviewer
 * looked and found nothing. Nothing is rewritten on the way in; the file a human
 * audited stays the file the run wrote, and only a legitimate stage save writes
 * the current version. A version this build does not read is refused with the
 * same loud error as always, rather than guessed at.
 *
 * Nothing secret belongs in here. There is no credential field to fill in.
 */

export const RUN_SCHEMA_VERSION = 7;

/**
 * The record versions this build reads, oldest first.
 *
 * A window, not a history: a version is in this list only while this file holds a
 * schema that validates exactly what its author wrote and a transform that can
 * say what that record did not contain.
 */
export const RUN_SCHEMA_VERSIONS_SUPPORTED: readonly number[] = [6, RUN_SCHEMA_VERSION];

export const RUN_STAGES = ['intake', 'inspect', 'contract', 'plan', 'implement', 'verify'] as const;
export const RUN_OUTCOMES = [
  'INTAKE_COMPLETE',
  'INSPECT_COMPLETE',
  'CONTRACT_DERIVED',
  'PLAN_COMPLETE',
  // Stage 6 has four, because "the model stopped" and "the run was stopped" and
  // "the model could not be reached" are different facts a reader must not have
  // to infer from a status called BLOCKED.
  'IMPLEMENTED_BY_MODEL',
  'IMPLEMENTATION_BLOCKED',
  'IMPLEMENTATION_INCONCLUSIVE',
  'IMPLEMENTATION_NEEDS_REVIEW',
  // Stage 7 mirrors the engine's five run verdicts one-for-one. A record that
  // collapsed `CANCELLED` into `INCONCLUSIVE` would hide the fact that a human
  // stopped the run, and a PASS here says only that the gates passed — the
  // contribution is not called ready by anything in this file.
  'VERIFICATION_PASS',
  'VERIFICATION_FAIL',
  'VERIFICATION_BLOCKED',
  'VERIFICATION_INCONCLUSIVE',
  'VERIFICATION_CANCELLED',
  'INCONCLUSIVE',
  'BLOCKED',
] as const;
export const RUN_CHECK_STATUSES = [
  'PASS',
  'WARN',
  'FAIL',
  'SKIP',
  'NOT_AVAILABLE',
  // The renderer already has this word, and a record that states "this happened"
  // without judging it needs a status that does not pretend to be a result.
  'INFO',
] as const;

export const injectionFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    severity: z.enum(['medium', 'high']),
    note: z.string(),
    excerpt: z.string(),
  })
  .strict();

export const issueRefSchema = z
  .object({
    host: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    canonical: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

export const issueDocumentSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(['open', 'closed']),
    body: z.string(),
    bodyLength: z.number().int().nonnegative(),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    wasTruncated: z.boolean(),
    labels: z.array(z.string()).readonly(),
    author: z.string(),
    url: z.string(),
    commentCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
    isPullRequest: z.boolean(),
    untrusted: z.literal(true),
    injectionFindings: z.array(injectionFindingSchema).readonly(),
  })
  .strict();

export const repositoryIdentitySchema = z
  .object({
    host: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    fullName: z.string().min(1),
    defaultBranch: z.string().min(1),
    isFork: z.boolean().nullable(),
    isArchived: z.boolean().nullable(),
    isPrivate: z.boolean().nullable(),
    htmlUrl: z.string(),
    description: z.string(),
    source: z.enum(['github-api', 'local-git', 'fixture']),
  })
  .strict();

export const commitRefSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
    shortSha: z.string().min(4),
    source: z.enum(['github-api', 'local-git']),
  })
  .strict();

export const localSnapshotSchema = z
  .object({
    requestedPath: z.string().min(1),
    toplevel: z.string().min(1),
    branch: z.string().min(1),
    isDetachedHead: z.boolean(),
    head: commitRefSchema,
    originUrl: z.string(),
    origin: issueRefSchema.omit({ number: true, canonical: true, url: true }).nullable(),
    defaultBranch: z.string(),
    isDirty: z.boolean(),
    dirtyCount: z.number().int().nonnegative(),
    dirtySample: z.array(z.string()).readonly(),
    isLinkedWorktree: z.boolean(),
    gitVersion: z.string(),
  })
  .strict();

export const runCheckSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(RUN_CHECK_STATUSES),
    detail: z.string(),
  })
  .strict();

/**
 * The fields every version from 6 onward holds, written once.
 *
 * The v6 and v7 schemas are this shape plus their own `schemaVersion` literal and
 * their own additions, so a reader of old records validates the shape their
 * author actually wrote — and a hand-edited v6 file cannot smuggle a v7 field in
 * by claiming to be a 6.
 */
const runRecordFieldsV6 = {
  runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  createdAt: z.string().min(1),
  mergeSutraVersion: z.string().min(1),
  stage: z.enum(RUN_STAGES),
  outcome: z.enum(RUN_OUTCOMES),
  issueRef: issueRefSchema.nullable(),
  issue: issueDocumentSchema.nullable(),
  repository: repositoryIdentitySchema.nullable(),
  base: commitRefSchema.nullable(),
  local: localSnapshotSchema.nullable(),
  /** Present once Stage 2 has read the repository. */
  contract: repositoryContractSchema.nullable(),
  /** Present once Stage 3 has derived criteria. Not the same thing as above. */
  acceptanceContract: acceptanceContractSchema.nullable().default(null),
  /** Present once Stage 4 has asked a model — and the answer passed the schema. */
  plan: implementationPlanSchema.nullable().default(null),
  /**
   * Present once Stage 6 has run the loop. It records actions and their
   * results, and it has no field in which a criterion could be called `PASS`
   * — the loop cannot report a verdict because there is nowhere to write one.
   */
  implementation: implementationRecordSchema.nullable().default(null),
  /**
   * Present once Stage 7 has planned, run and judged gates. Four documents,
   * kept separate on purpose: the plan is the promise made before anything
   * ran, the run is what actually happened to it, the consent is the human's
   * named yes, and the evidence is what each criterion may claim from the
   * receipts. Collapsing any two would let a later stage quote a promise as
   * if it were an observation.
   */
  verificationPlan: verificationPlanSchema.nullable().default(null),
  verification: verificationRunSchema.nullable().default(null),
  executionConsent: executionConsentSchema.nullable().default(null),
  evidence: acceptanceEvidenceSchema.nullable().default(null),
  checks: z.array(runCheckSchema).readonly(),
  nextStage: z.string(),
  limitations: z.array(z.string()).readonly(),
};

const runRecordV6Schema = z.object({ schemaVersion: z.literal(6), ...runRecordFieldsV6 }).strict();

export const runRecordSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
    ...runRecordFieldsV6,
    /**
     * Present once Stage 9 has reviewed these exact bytes.
     *
     * `null` and "zero findings" are different facts and only one of them is a
     * review: null says no reviewer was ever shown this patch, while a document
     * with an empty `findings` list says one was and reported nothing. A
     * migrated v6 record gets the first, because that is what happened to it.
     * The document also carries the patch identity it vouches for, so a reader
     * can tell a review from a review that has gone stale.
     */
    review: reviewDocumentSchema.nullable().default(null),
  })
  .strict();

export type InjectionFindingStored = z.infer<typeof injectionFindingSchema>;
export type IssueRefStored = z.infer<typeof issueRefSchema>;
export type RunCheck = z.infer<typeof runCheckSchema>;
export type RunStage = z.infer<typeof runRecordSchema>['stage'];
export type RunOutcome = z.infer<typeof runRecordSchema>['outcome'];
export type LocalSnapshotStored = z.infer<typeof localSnapshotSchema>;
export type RepositoryIdentityStored = z.infer<typeof repositoryIdentitySchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

export interface NewRunRecordInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly stage: RunStage;
  readonly outcome: RunOutcome;
  readonly issueRef: RunRecord['issueRef'];
  readonly issue: RunRecord['issue'];
  readonly repository: RunRecord['repository'];
  readonly base: RunRecord['base'];
  readonly local: RunRecord['local'];
  readonly contract: RunRecord['contract'];
  /** Only the `contract` command sets this; every other stage leaves it null. */
  readonly acceptanceContract?: RunRecord['acceptanceContract'];
  /** Only the `plan` command sets this, and it is model output kept as untrusted. */
  readonly plan?: RunRecord['plan'];
  /** Only the `implement` command sets this, and it is a loop's account of itself. */
  readonly implementation?: RunRecord['implementation'];
  /** Only the `verify` command sets these four, from the engine and nothing else. */
  readonly verificationPlan?: RunRecord['verificationPlan'];
  readonly verification?: RunRecord['verification'];
  readonly executionConsent?: RunRecord['executionConsent'];
  readonly evidence?: RunRecord['evidence'];
  /** Only the review stage sets this, and only from a review of these exact bytes. */
  readonly review?: RunRecord['review'];
  readonly checks: readonly RunCheck[];
  readonly nextStage: string;
  readonly limitations?: readonly string[];
}

export function createRunRecord(input: NewRunRecordInput): RunRecord {
  return runRecordSchema.parse({
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    mergeSutraVersion: VERSION,
    stage: input.stage,
    outcome: input.outcome,
    issueRef: input.issueRef,
    issue: input.issue,
    repository: input.repository,
    base: input.base,
    local: input.local,
    contract: input.contract,
    acceptanceContract: input.acceptanceContract ?? null,
    plan: input.plan ?? null,
    implementation: input.implementation ?? null,
    verificationPlan: input.verificationPlan ?? null,
    verification: input.verification ?? null,
    executionConsent: input.executionConsent ?? null,
    evidence: input.evidence ?? null,
    review: input.review ?? null,
    checks: [...input.checks],
    nextStage: input.nextStage,
    limitations: [...(input.limitations ?? [])],
  });
}

/**
 * A 6 record, seen in memory as a 7 record.
 *
 * The transform adds one thing: the fact that Stage 9 never ran. It cannot add a
 * review, a finding, a disposition, a receipt or an approval, because a 6 record
 * has no such evidence and inventing one here would put words a reviewer never
 * said into a document a reader will trust.
 */
function upgradeV6Record(record: z.infer<typeof runRecordV6Schema>): RunRecord {
  return runRecordSchema.parse({
    ...record,
    schemaVersion: RUN_SCHEMA_VERSION,
    review: null,
  });
}

function issueDetail(issues: readonly z.ZodIssue[]): string {
  return (
    issues.map((i) => `${i.path.join('.') || 'record'}: ${i.message}`).join('; ') ||
    'unrecognised record'
  );
}

function refuseRunRecord(detail: string): never {
  throw new AppError({
    kind: 'validation',
    message: `Run record is not readable: ${detail}`,
    remediation:
      'The .mergesutra run file is from a different MergeSutra version or was edited. Start a fresh run, or remove that file.',
    details: { reason: detail },
  });
}

/**
 * Read a stored record, whatever supported version its author wrote.
 *
 * Old files are validated as the version they claim to be, then transformed —
 * never reinterpreted. A version number that is a number but not a supported one
 * is named in the error, because "I could not read it" and "I have never seen 12"
 * send a human to different places. Anything else fails the way this file has
 * always failed: loudly, with the reason.
 */
export function parseRunRecord(unknown: unknown): RunRecord {
  const declared =
    typeof unknown === 'object' && unknown !== null && 'schemaVersion' in unknown
      ? unknown.schemaVersion
      : undefined;

  if (declared === 6) {
    const asV6 = runRecordV6Schema.safeParse(unknown);
    if (asV6.success) return upgradeV6Record(asV6.data);
    return refuseRunRecord(`as written for version 6: ${issueDetail(asV6.error.issues)}`);
  }

  if (typeof declared === 'number' && !RUN_SCHEMA_VERSIONS_SUPPORTED.includes(declared)) {
    return refuseRunRecord(
      `schemaVersion ${declared} is not a version this MergeSutra reads; it reads ${RUN_SCHEMA_VERSIONS_SUPPORTED.join(
        ' and ',
      )}`,
    );
  }

  const parsed = runRecordSchema.safeParse(unknown);
  if (parsed.success) return parsed.data;
  refuseRunRecord(issueDetail(parsed.error.issues));
}

/** Filesystem-safe, sortable, collision-resistant without needing a server. */
export function newRunId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `run-${stamp}-${suffix}`;
}

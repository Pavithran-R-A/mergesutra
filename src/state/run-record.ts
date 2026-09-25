import { z } from 'zod';
import { acceptanceContractSchema } from '../contract/schema.js';
import { AppError } from '../core/errors.js';
import { repositoryContractSchema } from '../discovery/contract.js';
import { implementationRecordSchema } from '../implement/state.js';
import { implementationPlanSchema } from '../plan/schema.js';
import { VERSION } from '../version.js';

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
 * Nothing secret belongs in here. There is no credential field to fill in.
 */

export const RUN_SCHEMA_VERSION = 5;

export const RUN_STAGES = ['intake', 'inspect', 'contract', 'plan', 'implement'] as const;
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

export const runRecordSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
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
    checks: z.array(runCheckSchema).readonly(),
    nextStage: z.string(),
    limitations: z.array(z.string()).readonly(),
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
    checks: [...input.checks],
    nextStage: input.nextStage,
    limitations: [...(input.limitations ?? [])],
  });
}

export function parseRunRecord(unknown: unknown): RunRecord {
  const parsed = runRecordSchema.safeParse(unknown);
  if (parsed.success) return parsed.data;
  const detail =
    parsed.error.issues.map((i) => `${i.path.join('.') || 'record'}: ${i.message}`).join('; ') ||
    'unrecognised record';
  throw new AppError({
    kind: 'validation',
    message: `Run record is not readable: ${detail}`,
    remediation:
      'The .mergesutra run file is from a different MergeSutra version or was edited. Start a fresh run, or remove that file.',
    details: { reason: detail },
  });
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

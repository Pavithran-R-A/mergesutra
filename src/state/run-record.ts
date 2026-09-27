import { z } from 'zod';
import { acceptanceContractSchema } from '../contract/schema.js';
import { AppError } from '../core/errors.js';
import { repositoryContractSchema } from '../discovery/contract.js';
import { implementationRecordSchema } from '../implement/state.js';
import { implementationPlanSchema } from '../plan/schema.js';
import { publicationRecordSchema } from '../pr/record.js';
import { repairExecutionSchema } from '../repair/execution.js';
import { repairPlanSchema } from '../repair/plan.js';
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
 * Version 7 adds Stage 9's two documents: the review, which is what a model said
 * about a pinned patch, and the frozen repair plan, which is what the run decided
 * to do about it. They are separate because a plan is not a finding and a finding
 * is not a verdict — and neither of them can say the contribution is ready. It is
 * also the first bump this file has had to answer for: records written by 6 are
 * already on disk, in runs a
 * human may still be reading, and this product's whole promise is that a later
 * stage can pick up a run from the evidence on disk. So the bump is additive and
 * the reader is version-aware. A 6 record is validated as a 6 record, then given
 * `review: null` and `repairPlan: null` in memory — never an empty review, which
 * would say a reviewer
 * looked and found nothing. Nothing is rewritten on the way in; the file a human
 * audited stays the file the run wrote, and only a legitimate stage save writes
 * the current version. A version this build does not read is refused with the
 * same loud error as always, rather than guessed at.
 *
 * Version 8 adds Stage 9R's one document: the list of repair executions, each of
 * which says what one approved cycle changed. It is a list rather than a single
 * nullable slot because a run may be repaired more than once, and the fact a reader
 * cannot reconstruct afterwards is the *order* — which cycle produced the bytes now
 * on disk, and which one was escalated instead of re-verified. The v7 migration
 * gives an empty list, never a plausible cycle: an old record has no evidence that
 * any repair ran, and inventing one would attribute writes to a run that never made
 * them.
 *
 * The stage and outcome vocabularies are split at the same time, and that is the
 * part of this bump that is not cosmetic. `repair` is in v8's list and not in v6's
 * or v7's, so an older file cannot claim a stage whose meaning this build only
 * defines alongside an execution list — and a hand-edited record that tries is
 * refused as the version it says it is. The alternative was one enum for every
 * version, which would have let a migrated v7 record arrive in a report reading
 * `stage: repair, repairExecutions: []`: true words in a false order, which is the
 * exact class of thing the record exists to prevent.
 *
 * Version 9 adds Stage 10's one document: the list of publication proposals, each of
 * which is the candidate a human was shown plus the yes they gave it, if they gave
 * one. It is a list for the same reason the executions are — a run can be proposed
 * twice (an edited title is a new candidate, and the old approval dies with the old
 * digest), and which proposal came first is not recoverable afterwards. The
 * migration gives an empty list rather than a candidate: a v8 record was never put in
 * front of anyone as a pull request, and inventing one would manufacture the only
 * document in this file that a later stage could read as consent.
 *
 * `pr` is v9's stage word, and its three outcomes are the last place in this file
 * where a stage is allowed to sound like success and is not. `PR_APPROVED_LOCAL` is
 * the strongest thing Stage 10 can say, and it says a person agreed: nothing was
 * pushed, no pull request exists, and no field anywhere in this record can say
 * otherwise.
 *
 * Nothing secret belongs in here. There is no credential field to fill in.
 */

export const RUN_SCHEMA_VERSION = 9;

/**
 * The record versions this build reads, oldest first.
 *
 * A window, not a history: a version is in this list only while this file holds a
 * schema that validates exactly what its author wrote and a transform that can
 * say what that record did not contain.
 */
export const RUN_SCHEMA_VERSIONS_SUPPORTED: readonly number[] = [6, 7, 8, RUN_SCHEMA_VERSION];

/** What existed before Stage 9R: seven stages, and no way to say a repair ran. */
export const RUN_STAGES_THROUGH_REVIEW = [
  'intake',
  'inspect',
  'contract',
  'plan',
  'implement',
  'verify',
  'review',
] as const;

/**
 * The stages a v8 record may name.
 *
 * `repair` is v8's own: a run in that stage has been through
 * consent, a bounded loop and a scope guard, and the record has to be able to hold
 * what each of them did. Older records are validated against the list above, so
 * this word cannot be backdated into them.
 */
export const RUN_STAGES_THROUGH_REPAIR = [...RUN_STAGES_THROUGH_REVIEW, 'repair'] as const;

/**
 * What existed before Stage 10, plus every stage that could have run through 9R.
 *
 * Kept separate from v8's list only to name what v9 adds; a v8 file is still
 * validated against `RUN_STAGES_THROUGH_REPAIR`, so `pr` cannot be backdated into it
 * any more than `repair` could be backdated into a v7 file.
 */
export const RUN_STAGES = [...RUN_STAGES_THROUGH_REPAIR, 'pr'] as const;
export const RUN_OUTCOMES_THROUGH_REVIEW = [
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
  // Stage 9's five, and none of them is a verdict on the contribution. There is
  // deliberately no `REVIEW_PASS`: a model that filed nothing did not certify
  // anything, and a record whose wording allowed "the review passed" would be
  // read that way by the next person to open it. What these say is what happened
  // to the review itself — it was written down, it needs a person, the bytes
  // moved under it, it made no sense, a human stopped it.
  'REVIEW_RECORDED',
  'REVIEW_NEEDS_HUMAN',
  'REVIEW_STALE',
  'REVIEW_INCONCLUSIVE',
  'REVIEW_CANCELLED',
  'INCONCLUSIVE',
  'BLOCKED',
] as const;

/**
 * Stage 9R's three, and the only way this record can say a repair happened.
 *
 * They describe what came out of a cycle, never what it was worth. `REPAIR_APPLIED`
 * means bytes moved inside the scope a human approved — which is a claim the gates
 * have to judge again, not a result; `REPAIR_NEEDS_HUMAN` means the cycle reached
 * outside that scope or left no trace at all, and an operator has to read the delta;
 * `REPAIR_BLOCKED` means the workspace was never touched, because the consent was
 * missing or stale or the loop stopped before it wrote anything. There is no
 * `REPAIR_PASS` and no `REPAIR_READY`: the word that a repair worked belongs to a
 * re-verified patch, and saying it here would be the loop grading its own edit.
 *
 * Why three and not one per termination reason: Stage 6's own status is already
 * stored, in full, inside each execution record. An outcome that repeated
 * `MAX_WRITES` or `MODEL_UNAVAILABLE` here would be a second copy of a fact that can
 * then disagree with the first.
 */
export const RUN_OUTCOMES_THROUGH_REPAIR = [
  ...RUN_OUTCOMES_THROUGH_REVIEW,
  'REPAIR_APPLIED',
  'REPAIR_NEEDS_HUMAN',
  'REPAIR_BLOCKED',
] as const;

/**
 * Stage 10's three, and the last words this record is allowed to say about a run.
 *
 * They describe what happened to a proposal, not whether it was any good.
 * `PR_CANDIDATE_RECORDED` means the facts were complete enough to assemble a
 * candidate and show it; `PR_APPROVED_LOCAL` means a human then named that
 * candidate's digest, which is the strongest statement available in this build and
 * still says nothing about GitHub; `PR_PUBLICATION_BLOCKED` means the run stopped
 * with a gap — stale evidence, a refused approval, or a publication that cannot be
 * attempted.
 *
 * There is no `PR_CREATED`, `PR_PUBLISHED` or `PR_READY`, and that is not caution for
 * its own sake: Stage 10 has no remote, so a word meaning "the pull request exists"
 * would describe an event nothing in this repository is capable of causing. When a
 * publisher lands, it will be the publisher's own document that says so, and the
 * record will hold that document rather than a promise of one.
 *
 * `PR_APPROVAL_REQUIRED` and `PR_CANDIDATE_STALE` are deliberately absent too. The
 * first is `PR_CANDIDATE_RECORDED` with an unapproved entry, which the entry itself
 * already says; the second is a block with a reason, and the reason is stored where
 * it was measured. Two words for one state is two chances to contradict each other.
 */
export const RUN_OUTCOMES = [
  ...RUN_OUTCOMES_THROUGH_REPAIR,
  'PR_CANDIDATE_RECORDED',
  'PR_APPROVED_LOCAL',
  'PR_PUBLICATION_BLOCKED',
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
  stage: z.enum(RUN_STAGES_THROUGH_REVIEW),
  outcome: z.enum(RUN_OUTCOMES_THROUGH_REVIEW),
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

/**
 * What Stage 9 wrote, shared by every version from 7 onward.
 *
 * The two documents are v7's whole addition, and they are written once here so the
 * v7, v8 and v9 shapes all validate the same review against the same schema. What
 * differs between those versions is what they *add* and which stage words they may
 * speak, not what they re-read.
 */
const runRecordFieldsV7 = {
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
  /**
   * Present once Stage 9 has frozen a work order from that review.
   *
   * Kept beside the review rather than inside it because the two answer
   * different questions: the review is what a model said about these bytes,
   * this is what the run decided to do about it. Writing it down before the
   * workspace is touched is the whole point — a reader who finds changed files
   * and no plan here is looking at an edit that nobody authorised.
   *
   * `null` is not "nothing needed fixing"; it is "no plan was frozen". The
   * distinction survives migration, which gives a v6 record this null.
   */
  repairPlan: repairPlanSchema.nullable().default(null),
};

const runRecordV7Schema = z
  .object({
    schemaVersion: z.literal(7),
    ...runRecordFieldsV6,
    ...runRecordFieldsV7,
  })
  .strict();

/**
 * What Stage 9R wrote, shared by v8 and v9.
 *
 * v8 also widens the stage and outcome vocabularies over the shared v6 fields: only
 * a record that can hold the executions may name the stage that produced them. v9
 * widens them again, and the override is written where it happens rather than being
 * inherited, so this object stays exactly what a v8 author wrote.
 */
const runRecordFieldsV8 = {
  ...runRecordFieldsV6,
  ...runRecordFieldsV7,
  stage: z.enum(RUN_STAGES_THROUGH_REPAIR),
  outcome: z.enum(RUN_OUTCOMES_THROUGH_REPAIR),
  /**
   * Every repair cycle this run has been through, oldest first.
   *
   * A list, not a slot, because the order is the one fact about two cycles that
   * nobody can recover afterwards: which cycle put the current bytes on disk,
   * and which one was escalated to a human instead of re-verified. Each entry
   * is written by Stage 9R's own builder, which refuses a cycle nobody approved,
   * so this array is a record of things that were allowed to happen rather than
   * of things a model says it did.
   *
   * `[]` means no repair cycle ran. It does not mean a cycle ran and found
   * nothing to do — that cycle would be in here, saying `REPAIR_LEFT_NO_TRACE`
   * in its scope. The default is a real state, not an omission, and that is why
   * the migration fills it with an empty list rather than with a plausible cycle.
   */
  repairExecutions: z.array(repairExecutionSchema).readonly().default([]),
};

const runRecordV8Schema = z.object({ schemaVersion: z.literal(8), ...runRecordFieldsV8 }).strict();

export const runRecordSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
    ...runRecordFieldsV8,
    /**
     * v9's own stage and outcome words, overriding v8's.
     *
     * Only a record that can hold a publication may name the stage that proposes
     * one; see the header.
     */
    stage: z.enum(RUN_STAGES),
    outcome: z.enum(RUN_OUTCOMES),
    /**
     * Every candidate this run has put in front of a human, oldest first.
     *
     * A list rather than a slot because a proposal can be revised: a human who
     * edits the title is looking at a different digest, the old approval stops
     * being about this document, and what a reader needs to reconstruct is which
     * yes belonged to which proposal. Each entry is built by Stage 10, which
     * refuses to file an approval that names some other candidate's digest, so
     * this array is a record of consents that were genuinely given.
     *
     * `[]` means Stage 10 never assembled a candidate. One entry with a null
     * approval means one was shown and nobody has agreed to it yet — which is
     * the state most runs will be left in, and the reason the approval is a
     * nullable document rather than a boolean that could be read either way.
     * Nothing in this list can say a pull request exists.
     */
    publications: z.array(publicationRecordSchema).readonly().default([]),
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
  /** Only the review stage sets this, and only after freezing it before any edit. */
  readonly repairPlan?: RunRecord['repairPlan'];
  /**
   * Only the repair stage sets this, and only with the executions it built for
   * cycles a human approved. A caller that has nothing to add omits it; a caller
   * that appends passes the whole prior list plus its own entry, because this is
   * the only place the record is written and an overwrite that drops a cycle would
   * be indistinguishable from a run that never had one.
   */
  readonly repairExecutions?: RunRecord['repairExecutions'];
  /**
   * Only the `pr` command sets this, and only with a candidate it assembled from
   * the evidence already on file — never one it inferred from a model's say-so.
   *
   * As with the executions, an appending caller passes the whole prior list plus its
   * own entry: this is the only place the record is written, and dropping an earlier
   * proposal would erase the history of which candidate a human actually agreed to.
   */
  readonly publications?: RunRecord['publications'];
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
    repairPlan: input.repairPlan ?? null,
    repairExecutions: [...(input.repairExecutions ?? [])],
    publications: [...(input.publications ?? [])],
    checks: [...input.checks],
    nextStage: input.nextStage,
    limitations: [...(input.limitations ?? [])],
  });
}

/**
 * A 6 record, seen in memory as a 7 record.
 *
 * The transform adds one fact and no evidence: Stage 9 never ran, so its review
 * and its frozen repair plan are both null. It cannot add a review, a finding, a
 * disposition, a receipt or an approval, because a 6 record has no such evidence
 * and inventing one here would put words a reviewer never said into a document a
 * reader will trust.
 *
 * It passes through the v7 schema rather than jumping to v8, so the chain is the
 * one this build actually supports: every step adds a field a real stage would
 * have filled, and each step is checked against the shape its own author wrote.
 */
function upgradeV6Record(
  record: z.infer<typeof runRecordV6Schema>,
): z.infer<typeof runRecordV7Schema> {
  return runRecordV7Schema.parse({
    ...record,
    schemaVersion: 7,
    review: null,
    repairPlan: null,
  });
}

/**
 * A 6 or 7 record, seen as an 8 record.
 *
 * One empty list and nothing else. Stage 9R never ran on this run, so there is no
 * cycle to describe, no approval to name and no patch identity to vouch for — and
 * an empty list is the honest reading of that, unlike a slot a later stage could
 * mistake for a repair that found nothing to do.
 */
function upgradeToV8Record(
  record: z.infer<typeof runRecordV7Schema>,
): z.infer<typeof runRecordV8Schema> {
  return runRecordV8Schema.parse({
    ...record,
    schemaVersion: 8,
    repairExecutions: [],
  });
}

/**
 * An 8 record, seen in memory as a 9 record.
 *
 * Still only ever an empty list. Stage 10 never showed this run to anybody as a pull
 * request proposal, so there is no candidate to store and — decisively — no approval
 * to store: a migrated record that arrived holding a human's yes would hand a later
 * stage a consent nobody gave. The stage and outcome words cannot come along either,
 * which is why v8 is validated against its own narrower vocabulary first.
 */
function upgradeV8Record(record: z.infer<typeof runRecordV8Schema>): RunRecord {
  return runRecordSchema.parse({
    ...record,
    schemaVersion: RUN_SCHEMA_VERSION,
    publications: [],
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
    if (asV6.success) return upgradeV8Record(upgradeToV8Record(upgradeV6Record(asV6.data)));
    return refuseRunRecord(`as written for version 6: ${issueDetail(asV6.error.issues)}`);
  }

  if (declared === 7) {
    const asV7 = runRecordV7Schema.safeParse(unknown);
    if (asV7.success) return upgradeV8Record(upgradeToV8Record(asV7.data));
    return refuseRunRecord(`as written for version 7: ${issueDetail(asV7.error.issues)}`);
  }

  if (declared === 8) {
    const asV8 = runRecordV8Schema.safeParse(unknown);
    if (asV8.success) return upgradeV8Record(asV8.data);
    return refuseRunRecord(`as written for version 8: ${issueDetail(asV8.error.issues)}`);
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

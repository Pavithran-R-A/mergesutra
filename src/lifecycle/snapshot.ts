import { z } from 'zod';
import { publicationDigestOf } from '../pr/digest.js';
import { REVIEW_SEVERITIES } from '../review/schema.js';
import { RUN_OUTCOMES, RUN_STAGES, type RunRecord } from '../state/run-record.js';
import { GATE_RESULTS } from '../verify/receipt.js';
import { stalenessOf } from '../verify/patch.js';
import { loopBudgetOf } from './budget.js';
import type { LockReading } from './lock.js';
import { describeLock, lockReportSchema } from './lock-state.js';
import { WORKSPACE_STATES, type LifecycleObservation } from './observe.js';
import { LIFECYCLE_ARTIFACTS, type LifecycleState, type LifecycleVerdict } from './staleness.js';

type States = LifecycleVerdict['states'];

/**
 * The one document a status screen and a recovery plan are both built from.
 *
 * Everything in it already exists somewhere: the run record holds what each stage
 * wrote down, and `observe.ts` holds what this machine will currently say. Neither
 * of those is what a person wants to read. The record cannot answer "is the
 * verification on this page about the files in front of me?" because it has no
 * idea what is in front of you; the observation cannot answer it either, because
 * it does not know what was promised. The snapshot is where the two are put beside
 * each other — and the whole design of this file is about *not* fusing them.
 *
 * Four rules do that work.
 *
 * 1. **Recorded and observed are separate fields, always.** `recorded` is the
 *    stage vocabulary as it was filed; `workspace` is what Git said just now;
 *    `patch` is the pair with a verdict beside it. Nothing here overwrites one
 *    with the other, so a page can say `PASS` and `STALE` in the same row without
 *    either one being a lie — which is the only honest way to report a run whose
 *    bytes moved after its gates ran.
 * 2. **A section is `null` until the stage that owns it has filed anything.**
 *    An absent section is not a failed one, and this file never fills a gap with
 *    an empty-but-passing shape: no review means `review: null`, not zero
 *    findings. The distinction is the same one the run record draws, and it is
 *    the reason a snapshot of a two-hour-old run cannot read as a finished one.
 * 3. **Every row's currency comes from the graph, not from this file.** The
 *    `state` fields are copied out of `observation.verdict`, so a status screen
 *    and a resume plan cannot disagree about what expired, and this module has no
 *    opinion of its own to drift.
 * 4. **Nothing here judges, scores or announces.** There is no health number, no
 *    "ready", no "no defects", no published/pushed/created word — because there
 *    is no field in this build that could support one, and a snapshot that
 *    summarised a review into a verdict would be the one place a machine's
 *    optimism could enter a page whose entire point is the evidence.
 *
 * Like the observation layer, this module is pure: it reads no file, runs no
 * command, calls no model. It is arithmetic over two documents that already
 * exist, which is why the same object can serve a read-only `status` and the
 * preview half of `resume` without a second implementation to keep in step.
 */

export const STATUS_SCHEMA_VERSION = 1;

/**
 * What an action costs, in capabilities rather than in minutes.
 *
 * A next action is only safe if the person reading it knows whether it will spend
 * a model call, run something from the repository, or need a yes from them first.
 * `LOCAL_ONLY` is listed so a suggestion cannot look like a demand: re-rendering a
 * page is the one thing a run can always be told to do.
 */
export const NEXT_ACTION_REQUIREMENTS = [
  'MODEL',
  'REPOSITORY_COMMAND',
  'HUMAN_APPROVAL',
  'EXECUTION_CONSENT',
  'LOCAL_ONLY',
] as const;

export type NextActionRequirement = (typeof NEXT_ACTION_REQUIREMENTS)[number];

export const safeNextActionSchema = z
  .object({
    command: z.string().min(1),
    reason: z.string().min(1),
    requires: z.array(z.enum(NEXT_ACTION_REQUIREMENTS)).min(1).readonly(),
  })
  .strict();
export type SafeNextAction = z.infer<typeof safeNextActionSchema>;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'A digest is a sha256 hex string.');
const lifecycleStateSchema = z.enum(['CURRENT', 'STALE', 'UNMEASURABLE', 'ABSENT']);

const recordedSectionSchema = z
  .object({
    stage: z.enum(RUN_STAGES),
    outcome: z.enum(RUN_OUTCOMES),
    nextStage: z.string(),
    createdAt: z.string(),
    mergeSutraVersion: z.string(),
  })
  .strict();

const workspaceSectionSchema = z
  .object({
    state: z.enum(WORKSPACE_STATES),
    path: z.string().nullable(),
    recordedBaseSha: z.string().nullable(),
    observedHead: z.string().nullable(),
    currentPatchIdentity: z.string().nullable(),
    recordedPatchIdentity: z.string().nullable(),
    detail: z.string(),
  })
  .strict();

const patchSectionSchema = z
  .object({
    recorded: digestSchema.nullable(),
    current: digestSchema.nullable(),
    status: lifecycleStateSchema,
  })
  .strict();

const lifecycleRowSchema = z
  .object({
    artifact: z.enum(LIFECYCLE_ARTIFACTS),
    state: lifecycleStateSchema,
    recorded: digestSchema.nullable(),
    current: digestSchema.nullable(),
    reason: z.string(),
  })
  .strict();

const contractSectionSchema = z
  .object({
    version: z.number().int().positive(),
    criteria: z.number().int().nonnegative(),
    limitations: z.number().int().nonnegative(),
    /** The contract came out of an issue, and this build never lets that be forgotten. */
    untrusted: z.boolean(),
  })
  .strict();

const planSectionSchema = z
  .object({
    model: z.string(),
    source: z.string(),
    requestedAt: z.string(),
    contractVersion: z.number().int().positive(),
    attempts: z.number().int().positive(),
    changes: z.number().int().nonnegative(),
    criteriaCovered: z.number().int().nonnegative(),
    criteriaUnaddressed: z.number().int().nonnegative(),
    untrusted: z.boolean(),
  })
  .strict();

const implementationSectionSchema = z
  .object({
    /** What came out of the loop, not what the loop achieved. */
    status: z.string(),
    termination: z.string(),
    model: z.string(),
    steps: z.number().int().nonnegative(),
    writes: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    /**
     * Spent and left, from the bounds the loop was actually given.
     *
     * A resumed loop has to be able to say what it may still do, so the limits are
     * reported as numbers rather than as a sentence about them.
     */
    budget: z
      .object({
        stepsUsed: z.number().int().nonnegative(),
        stepsLeft: z.number().int(),
        writesUsed: z.number().int().nonnegative(),
        writesLeft: z.number().int(),
        commandsUsed: z.number().int().nonnegative(),
        commandsLeft: z.number().int(),
      })
      .strict(),
    verified: z.boolean(),
    untrusted: z.boolean(),
  })
  .strict();

const verificationSectionSchema = z
  .object({
    /** The engine's verdict on the gates, kept exactly as it was written. */
    result: z.string(),
    planRevision: z.number().int().positive(),
    planDigest: digestSchema,
    /** The patch those receipts were gathered against — not the one here now. */
    patchIdentity: digestSchema,
    baseSha: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    /** The receipts, counted in total and by the result each one carries. */
    gates: z
      .object({
        total: z.number().int().nonnegative(),
        byResult: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    /** The scope this run's consent covered, so a reader can see what was agreed to. */
    consent: z
      .object({
        gateIds: z.number().int().nonnegative(),
        grantedAt: z.string(),
        state: lifecycleStateSchema,
      })
      .strict()
      .nullable(),
    /** The graph's row, printed beside the result rather than in place of it. */
    state: lifecycleStateSchema,
  })
  .strict();

const evidenceSectionSchema = z
  .object({
    total: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    needsAHuman: z.number().int().nonnegative(),
    /** Copied from the document, which can only hold `false`. */
    contributionReady: z.boolean(),
    state: lifecycleStateSchema,
  })
  .strict();

const reviewSectionSchema = z
  .object({
    findings: z
      .object({
        total: z.number().int().nonnegative(),
        bySeverity: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    /** True when a finding was weighed as something a repair cycle may act on. */
    routedToRepair: z.boolean(),
    escalatedToHuman: z.boolean(),
    model: z.string(),
    attempts: z.number().int().positive(),
    reviewedPatchIdentity: digestSchema,
    currentPatchIdentity: digestSchema,
    reviewedAt: z.string(),
    state: lifecycleStateSchema,
  })
  .strict();

const repairSectionSchema = z
  .object({
    plan: z
      .object({
        reviewCycle: z.number().int().positive(),
        repairCycle: z.number().int().positive(),
        reviewedPatchIdentity: digestSchema,
        criteria: z.number().int().nonnegative(),
        expectedFiles: z.number().int().nonnegative(),
        expectedChecks: z.number().int().nonnegative(),
        findings: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    planState: lifecycleStateSchema,
    approvalState: lifecycleStateSchema,
    executions: z
      .array(
        z
          .object({
            reviewCycle: z.number().int().positive(),
            repairCycle: z.number().int().positive(),
            planDigest: digestSchema,
            patchBeforeIdentity: digestSchema,
            patchAfterIdentity: digestSchema,
            /** Stage 9R's guard's own word for what the cycle touched. */
            scope: z.string(),
            verificationRequired: z.boolean(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

const reportSectionSchema = z
  .object({
    /** The pack directory's digest as measured on disk, or `null` when incomplete. */
    packOnDisk: digestSchema.nullable(),
    /**
     * The graph's row for the pack: what a candidate on record claims the page is,
     * against what is actually there. `ABSENT` here means no candidate has ever
     * named a page, which is not the same as the files being missing.
     */
    state: lifecycleStateSchema,
    /** The pack is rendered from the record, so losing it costs a command, not work. */
    regenerable: z.literal(true),
  })
  .strict();

const publicationSectionSchema = z
  .object({
    candidates: z.number().int().nonnegative(),
    latest: z
      .object({
        prTitle: z.string(),
        targetBranch: z.string(),
        proposedBranch: z.string(),
        patchIdentity: digestSchema,
        evidencePackIdentity: digestSchema,
        closesIssue: z.boolean(),
        digest: digestSchema,
      })
      .strict()
      .nullable(),
    approval: z
      .object({
        digest: digestSchema,
        action: z.string(),
        approvedAt: z.string(),
      })
      .strict()
      .nullable(),
    approvalState: lifecycleStateSchema,
    state: lifecycleStateSchema,
    /**
     * The only thing this build can truthfully say about the remote.
     *
     * Not a variable and not a status read from anywhere: no code path in this
     * product has ever contacted one, and a field that could hold a URL would be a
     * promise. Stage 15 will own its own words when it exists.
     */
    remote: z.literal('NOT_ATTEMPTED_BY_THIS_BUILD'),
  })
  .strict();

export const statusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    runId: z.string().min(1),
    /** When this observation was taken, from the caller's clock. */
    observedAt: z.string().min(1),
    recorded: recordedSectionSchema,
    workspace: workspaceSectionSchema,
    patch: patchSectionSchema,
    /**
     * Whether another process has claimed this run, as the read-only lock reader saw it.
     *
     * Required rather than optional, because the one thing a person needs from this row
     * is a yes-or-no about whether to run `resume` — and an absent row would be read as
     * "no lock" by exactly the reader who was going to act on it.
     */
    lock: lockReportSchema,
    contract: contractSectionSchema.nullable(),
    plan: planSectionSchema.nullable(),
    implementation: implementationSectionSchema.nullable(),
    verification: verificationSectionSchema.nullable(),
    evidence: evidenceSectionSchema.nullable(),
    review: reviewSectionSchema.nullable(),
    repair: repairSectionSchema.nullable(),
    report: reportSectionSchema,
    publication: publicationSectionSchema.nullable(),
    lifecycle: z
      .object({
        /** Keyed by the closed artifact vocabulary, so a reader cannot ask for a row that does not exist. */
        states: z.record(z.enum(LIFECYCLE_ARTIFACTS), lifecycleStateSchema),
        rows: z.array(lifecycleRowSchema).readonly(),
      })
      .strict(),
    /** Facts that no command can clear by being run: the workspace is gone, or is not this run's. */
    blockers: z.array(z.string()).readonly(),
    /** Every graph row that was recorded and has since expired or become unverifiable. */
    warnings: z.array(lifecycleRowSchema).readonly(),
    safeNextActions: z.array(safeNextActionSchema).readonly(),
  })
  .strict();

export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>;

export interface StatusSnapshotInput {
  readonly record: RunRecord;
  readonly observation: LifecycleObservation;
  readonly observedAt: string;
  /**
   * The lock as this machine just saw it, from `readRunLock`.
   *
   * Supplied as the *reading* rather than as a description so that the mapping from
   * `ALIVE`/`GONE`/`UNKNOWABLE` to the words a person reads lives in one place: a
   * caller that could pass its own sentence about a lock could pass an optimistic one.
   * This file still touches no filesystem — someone else looked, this file says what
   * looking meant.
   */
  readonly lock: LockReading;
  /**
   * Supplied rather than derived here.
   *
   * Choosing what to suggest next needs every precondition a stage checks before
   * it runs, and those live in the stages. This file's job is to hold the two
   * halves of the picture apart, not to invent a third opinion about them.
   */
  readonly nextActions?: readonly SafeNextAction[];
}

export function buildStatusSnapshot(input: StatusSnapshotInput): StatusSnapshot {
  const { record, observation } = input;
  const states = observation.verdict.states;
  const workspace = observation.workspace;

  return statusSnapshotSchema.parse({
    schemaVersion: STATUS_SCHEMA_VERSION,
    runId: record.runId,
    observedAt: input.observedAt,
    recorded: {
      stage: record.stage,
      outcome: record.outcome,
      nextStage: record.nextStage,
      createdAt: record.createdAt,
      mergeSutraVersion: record.mergeSutraVersion,
    },
    workspace,
    patch: patchOf(workspace.recordedPatchIdentity, workspace.currentPatchIdentity),
    lock: describeLock(input.lock),
    contract: record.acceptanceContract
      ? {
          version: record.acceptanceContract.version,
          criteria: record.acceptanceContract.criteria.length,
          limitations: record.acceptanceContract.limitations.length,
          untrusted: record.acceptanceContract.untrusted,
        }
      : null,
    plan: record.plan
      ? {
          model: record.plan.provenance.model,
          source: record.plan.provenance.source,
          requestedAt: record.plan.provenance.requestedAt,
          contractVersion: record.plan.provenance.contractVersion,
          attempts: record.plan.provenance.attempts,
          changes: record.plan.body.changes.length,
          criteriaCovered: record.plan.body.criteriaCovered.length,
          criteriaUnaddressed: record.plan.body.criteriaUnaddressed.length,
          untrusted: record.plan.untrusted,
        }
      : null,
    implementation: record.implementation
      ? {
          status: record.implementation.status,
          termination: record.implementation.termination.kind,
          model: record.implementation.model,
          steps: record.implementation.summary.steps,
          writes: record.implementation.summary.writes,
          commands: record.implementation.summary.commands,
          refused: record.implementation.summary.refusedActions,
          budget: budgetOf(record.implementation),
          verified: record.implementation.verified,
          untrusted: record.implementation.untrusted,
        }
      : null,
    verification: verificationOf(record, states),
    evidence: evidenceOf(record, states.evidence),
    review: reviewOf(record, states.review),
    repair: repairOf(record, states),
    report: {
      packOnDisk: observation.packOnDisk,
      state: states.pack,
      regenerable: true,
    },
    publication: publicationOf(record, states),
    lifecycle: { states, rows: observation.verdict.rows },
    blockers: blockersOf(workspace),
    warnings: observation.verdict.rows.filter(
      (row) => row.state === 'STALE' || row.state === 'UNMEASURABLE',
    ),
    safeNextActions: [...(input.nextActions ?? [])],
  });
}

/**
 * The patch pair, in the only two words available for it.
 *
 * `ABSENT` when nothing on record has ever described a patch, `UNMEASURABLE` when
 * something did and the workspace will not say what is here now. Neither of those
 * is folded into `CURRENT`: a run whose files cannot be read has not been shown to
 * be unchanged, and an undescribable patch is refused by Stage 7 rather than
 * reported as agreement.
 */
function patchOf(
  recorded: string | null,
  current: string | null,
): z.infer<typeof patchSectionSchema> {
  if (recorded === null) return { recorded: null, current, status: 'ABSENT' };
  if (current === null) return { recorded, current: null, status: 'UNMEASURABLE' };
  return { recorded, current, status: stalenessOf(recorded, current).status };
}

/**
 * The loop's spend, in the snapshot's flat field names.
 *
 * The subtraction lives in `budget.ts` and nowhere else, so the numbers a person
 * reads on a status screen are the numbers a resume plan uses to decide whether
 * there is anything to resume into. An over-spend stays negative here for the same
 * reason: a snapshot that clamped it would report room where the budget module
 * reports none.
 */
function budgetOf(implementation: NonNullable<RunRecord['implementation']>) {
  const { steps, writes, commands } = loopBudgetOf(implementation);
  return {
    stepsUsed: steps.spent,
    stepsLeft: steps.left,
    writesUsed: writes.spent,
    writesLeft: writes.left,
    commandsUsed: commands.spent,
    commandsLeft: commands.left,
  };
}

function verificationOf(
  record: RunRecord,
  states: States,
): z.infer<typeof verificationSectionSchema> | null {
  const run = record.verification;
  if (!run) return null;
  const consent = record.executionConsent;
  return {
    result: run.result,
    planRevision: run.planRevision,
    planDigest: run.planDigest,
    patchIdentity: run.patchIdentity,
    baseSha: run.baseSha,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    gates: {
      total: run.gates.length,
      byResult: tally(
        run.gates.map((gate) => gate.receipt.result),
        GATE_RESULTS,
      ),
    },
    consent: consent
      ? {
          gateIds: consent.gateIds.length,
          grantedAt: consent.grantedAt,
          state: states.executionConsent,
        }
      : null,
    state: states.verification,
  };
}

function evidenceOf(
  record: RunRecord,
  state: LifecycleState,
): z.infer<typeof evidenceSectionSchema> | null {
  const evidence = record.evidence;
  if (!evidence) return null;
  const by = evidence.criteria.map((criterion) => criterion.sufficiency);
  return {
    total: by.length,
    verified: count(by, 'VERIFIED'),
    partial: count(by, 'PARTIALLY_VERIFIED'),
    unverified: count(by, 'NOT_VERIFIED'),
    failed: count(by, 'FAILED'),
    blocked: count(by, 'BLOCKED'),
    needsAHuman: count(by, 'MANUAL_REVIEW_REQUIRED'),
    contributionReady: evidence.contributionReady,
    state,
  };
}

function reviewOf(
  record: RunRecord,
  state: LifecycleState,
): z.infer<typeof reviewSectionSchema> | null {
  const review = record.review;
  if (!review) return null;
  return {
    findings: {
      total: review.findings.length,
      bySeverity: tally(
        review.findings.map((finding) => finding.severity),
        REVIEW_SEVERITIES,
      ),
    },
    routedToRepair: review.findings.some((f) => f.disposition === 'VALID_REPAIR_CANDIDATE'),
    escalatedToHuman: review.findings.some((f) => f.disposition === 'NEEDS_HUMAN_REVIEW'),
    model: review.modelId,
    attempts: review.attempts,
    reviewedPatchIdentity: review.reviewedPatchIdentity,
    currentPatchIdentity: review.currentPatchIdentity,
    reviewedAt: review.reviewedAt,
    state,
  };
}

function repairOf(record: RunRecord, states: States) {
  const plan = record.repairPlan;
  const executions = record.repairExecutions;
  if (!plan && executions.length === 0) return null;
  return {
    plan: plan
      ? {
          reviewCycle: plan.reviewCycle,
          repairCycle: plan.repairCycle,
          reviewedPatchIdentity: plan.reviewedPatchIdentity,
          criteria: plan.criteria.length,
          expectedFiles: plan.expectedFiles.length,
          expectedChecks: plan.expectedChecks.length,
          findings: plan.findings.length,
        }
      : null,
    planState: states.repairPlan,
    approvalState: states.repairApproval,
    // Each cycle as it was filed: the two patches and the guard's own word about
    // the distance between them. A repair that moved bytes and was never
    // re-verified reads as exactly that, not as work in progress.
    executions: executions.map((execution) => ({
      reviewCycle: execution.reviewCycle,
      repairCycle: execution.repairCycle,
      planDigest: execution.planDigest,
      patchBeforeIdentity: execution.patchBeforeIdentity,
      patchAfterIdentity: execution.patchAfterIdentity,
      scope: execution.scope.outcome,
      verificationRequired: execution.verificationRequired,
    })),
  };
}

function publicationOf(record: RunRecord, states: States) {
  const latest = record.publications.at(-1) ?? null;
  // The section opens at the review, because that is the first document a
  // candidate is allowed to be built from: a run that has never been reviewed has
  // nothing to propose, and `candidates: 0` says so without inventing a failure.
  if (!record.review && !latest) return null;
  return {
    candidates: record.publications.length,
    latest: latest
      ? {
          prTitle: latest.candidate.prTitle,
          targetBranch: latest.candidate.targetBranch,
          proposedBranch: latest.candidate.proposedBranch,
          patchIdentity: latest.candidate.patchIdentity,
          evidencePackIdentity: latest.candidate.evidencePackIdentity,
          closesIssue: latest.candidate.closesIssue,
          digest: publicationDigestOf(latest.candidate),
        }
      : null,
    approval: latest?.approval
      ? {
          digest: latest.approval.publicationDigest,
          action: latest.approval.action,
          approvedAt: latest.approval.approvedAt,
        }
      : null,
    approvalState: states.publicationApproval,
    state: states.candidate,
    remote: 'NOT_ATTEMPTED_BY_THIS_BUILD',
  };
}

/**
 * What stops this run right now, in the observation's own words.
 *
 * Only the states a person has to resolve by other means: a workspace that is not
 * there, cannot be read, or belongs to another history. A changed patch is not a
 * blocker — it is a warning with a command in front of it — and a run that has not
 * built a workspace yet is not blocked either, because the next stage is the thing
 * that builds one.
 */
function blockersOf(workspace: LifecycleObservation['workspace']): string[] {
  if (
    workspace.state === 'MISSING' ||
    workspace.state === 'UNREADABLE' ||
    workspace.state === 'BASE_MISMATCH'
  ) {
    return [workspace.detail];
  }
  return [];
}

function tally(values: readonly string[], keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = 0;
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function count(values: readonly string[], wanted: string): number {
  return values.filter((value) => value === wanted).length;
}

import path from 'node:path';
import {
  createBharatCodeClient,
  requireApiKey,
  type BharatCodeClient,
} from '../bharatcode/client.js';
import { loadBharatCodeConfig } from '../config/load-config.js';
import { AppError } from '../core/errors.js';
import type { RepairLimits } from '../repair/bounds.js';
import { buildRepairPlan, type RepairPlan } from '../repair/plan.js';
import {
  createRunRecord,
  parseRunRecord,
  type RunCheck,
  type RunRecord,
} from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { newestRunId } from '../state/run-selection.js';
import { describePatch } from '../verify/patch.js';
import { assembleReviewContext, type ReviewContext } from './context.js';
import { weighFindings } from './disposition.js';
import { requestReview, type ReviewAttempt } from './engine.js';
import { buildReviewDocument, type ReviewDocument } from './schema.js';

/**
 * Stage 9's wiring: one question, asked once, about the bytes on disk.
 *
 * This module is the only place in Stage 9 that touches a run record, and the
 * rule it exists to enforce is a negative one: reviewing changes nothing. It
 * reads a genuine persisted run, pins the patch it found, asks a second model to
 * describe that patch, weighs what comes back against the manifest it authored,
 * and may freeze a plan — a document that says what a *later* stage is allowed to
 * try. The workspace it reviewed is byte-identical when it returns, including in
 * the case that most needs proving: a review that found a real defect. A finding
 * is not a fix, and a stage that quietly fixed what it noticed would make the
 * receipts below it describe a diff nobody reviewed.
 *
 * Three of the record's fields are its own doing and none is a verdict. The
 * outcome says what happened to the review (`REVIEW_STALE` when the bytes moved,
 * `REVIEW_INCONCLUSIVE` when the answer made no sense), never that the
 * contribution passed. The stage therefore has no path to a word like `PASS`:
 * readiness stays where Stage 7 put it, in gate receipts and criterion statuses.
 *
 * A refused, unintelligible, unreachable or interrupted review still writes a
 * record — with no review document in it, because there is nothing to file — so
 * that a resume can see the attempt was made and what stopped it.
 */

const DIGEST = /^[0-9a-f]{64}$/;

export interface ReviewStageInput {
  readonly runId?: string;
  /** Where the primary checkout is; defaults to the run's recorded toplevel. */
  readonly repo?: string;
  readonly signal?: AbortSignal;
}

export interface ReviewStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  /** Absent means the shipped product's own client, which needs a real credential. */
  readonly client?: BharatCodeClient;
  readonly env?: NodeJS.ProcessEnv;
  /** Bounds a caller may tighten; the ceilings in src/repair/bounds.ts are not movable. */
  readonly limits?: Partial<RepairLimits>;
  /** How the patch is re-measured after the answer. A test seam, the engine's own shape. */
  readonly currentPatchIdentity?: () => Promise<string | null>;
}

export interface ReviewStageResult {
  readonly record: RunRecord;
  readonly context: ReviewContext;
  readonly attempt: ReviewAttempt;
  /** Null when no review could be filed — refused, unreachable, cancelled, unbound. */
  readonly review: ReviewDocument | null;
  /** Null unless a candidate was frozen into a work order. Freezing edits nothing. */
  readonly repairPlan: RepairPlan | null;
  readonly workspace: string;
  readonly recordFile: string | null;
  readonly saveError: string | null;
}

export async function runReviewStage(
  input: ReviewStageInput,
  deps: ReviewStageDeps,
): Promise<ReviewStageResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const now = deps.now ?? (() => new Date());

  const sourceRunId = input.runId ?? (await newestVerifiedRunId(store));
  const source = parseRunRecord(await store.load(sourceRunId));
  const contract = source.acceptanceContract;
  if (!contract) {
    throw new AppError({
      kind: 'validation',
      message: `Run '${sourceRunId}' has no Acceptance Contract, so a review would have no obligations to check the patch against.`,
      remediation: 'Run `mergesutra contract` on this run first.',
    });
  }
  const implementation = source.implementation;
  if (!implementation) {
    throw new AppError({
      kind: 'validation',
      message: `Run '${sourceRunId}' has not implemented anything yet, so there is no patch to review.`,
      remediation: 'Run `mergesutra implement` on this run first.',
    });
  }
  if (!source.verification || !source.verificationPlan) {
    throw new AppError({
      kind: 'validation',
      message: `Run '${sourceRunId}' has no verification run, so a review would be a second opinion with nothing to weigh it against.`,
      remediation:
        'Run `mergesutra verify` first; its receipts are what tell a reviewer where the gates are silent.',
    });
  }

  const primaryRoot = path.resolve(input.repo ?? source.local?.toplevel ?? cwd);
  const workspace = path.resolve(primaryRoot, implementation.workspace.relativePath);
  const baseSha = implementation.workspace.baseSha;
  const patch = await describePatch({ workspace, baseSha });

  const context = await assembleReviewContext({ record: source, workspace, patch });
  // Built here, after the run has proved it can be reviewed: "this run has nothing
  // to review" is the truer refusal on a machine that also has no credential.
  const client = deps.client ?? clientFromEnvironment(deps.env ?? process.env);
  const probe = deps.currentPatchIdentity ?? (() => measureIdentity(workspace, baseSha));
  const attempt = await requestReview(
    { context, currentPatchIdentity: probe, ...(input.signal ? { signal: input.signal } : {}) },
    { client },
  );

  const review = documentFor(sourceRunId, baseSha, context, attempt, now);
  const extra: string[] = [];
  if (review && review.findings.length === 0) {
    extra.push(
      `REVIEW-EMPTY: the reviewer filed no findings against ${review.reviewedPatchIdentity.slice(
        0,
        12,
      )}…. That is the absence of findings, not the absence of defects; a second reader that had nothing to say is not a sign-off.`,
    );
  }

  const repairPlan = review
    ? planFor(source, review, context, attempt, deps.limits, now, extra)
    : null;
  const record = createRunRecord({
    runId: sourceRunId,
    createdAt: source.createdAt,
    stage: 'review',
    outcome: outcomeFor(attempt, review, repairPlan),
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: contract,
    plan: source.plan,
    implementation,
    verificationPlan: source.verificationPlan,
    verification: source.verification,
    executionConsent: source.executionConsent,
    evidence: source.evidence,
    review,
    repairPlan,
    repairExecutions: source.repairExecutions,
    checks: describeReview(attempt, review, repairPlan),
    limitations: [...source.limitations, ...attempt.limitations, ...extra],
    nextStage: nextStageFor(attempt, review, repairPlan),
  });

  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }

  return { record, context, attempt, review, repairPlan, workspace, recordFile, saveError };
}

async function measureIdentity(workspace: string, baseSha: string): Promise<string | null> {
  const described = await describePatch({ workspace, baseSha }).catch(() => null);
  return described?.identity ?? null;
}

/**
 * The shipped product's own reviewer, built only once there is a run to ask about.
 *
 * A machine with no `BHARATCODE_API_KEY` cannot have a second opinion, and the
 * honest shape of that is a configuration refusal with exit 78 — not a record
 * that says a review came back inconclusive. The credential is read from the
 * environment here and nowhere else: it never enters a argv, a fixture, a
 * receipt or a report.
 */
function clientFromEnvironment(env: NodeJS.ProcessEnv): BharatCodeClient {
  const config = loadBharatCodeConfig(env);
  requireApiKey(config.apiKey);
  return createBharatCodeClient({ config });
}

/**
 * File the review, if there is a review to file.
 *
 * A body survives a moved patch — someone read those bytes and reported something,
 * and that account is worth keeping even when it has gone stale. What cannot be
 * filed is a body with no patch bound to it: the document's whole claim is that
 * these findings describe this diff, so both digests have to exist or nothing here
 * is storable.
 */
function documentFor(
  runId: string,
  baseSha: string,
  context: ReviewContext,
  attempt: ReviewAttempt,
  now: () => Date,
): ReviewDocument | null {
  const current = attempt.currentPatchIdentity;
  if (
    !attempt.body ||
    !DIGEST.test(attempt.reviewedPatchIdentity) ||
    current === null ||
    !DIGEST.test(current) ||
    attempt.model === null
  ) {
    return null;
  }
  return buildReviewDocument({
    runId,
    baseSha,
    reviewedPatchIdentity: attempt.reviewedPatchIdentity,
    currentPatchIdentity: current,
    modelId: attempt.model,
    reviewedAt: now().toISOString(),
    attempts: attempt.attempts,
    body: attempt.body,
    dispositions: weighFindings({
      context,
      findings: attempt.body.findings,
      binding: attempt.patchPrecondition,
      currentPatchIdentity: current,
      manifest: context.manifest,
    }),
  });
}

/**
 * Freeze a plan for the candidates, or record why it could not be frozen.
 *
 * The refusal is kept rather than swallowed: a review whose candidates outran the
 * cycle bounds is a run that needs a person, and the only honest thing to say is
 * which bound stopped it.
 */
function planFor(
  source: RunRecord,
  review: ReviewDocument,
  context: ReviewContext,
  attempt: ReviewAttempt,
  limits: Partial<RepairLimits> | undefined,
  now: () => Date,
  extra: string[],
): RepairPlan | null {
  if (attempt.status !== 'REVIEWED') return null;
  const candidates = review.findings.filter(
    (finding) => finding.disposition === 'VALID_REPAIR_CANDIDATE',
  );
  if (candidates.length === 0) return null;
  try {
    return buildRepairPlan({
      record: source,
      review,
      manifest: context.manifest,
      reviewCycle: (source.repairPlan?.reviewCycle ?? 0) + 1,
      repairCycle: (source.repairPlan?.repairCycle ?? 0) + 1,
      createdAt: now().toISOString(),
      ...(limits ? { limits } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    extra.push(
      `REVIEW-PLAN-REFUSED: ${detail} No repair plan was frozen, so nothing here authorises an edit.`,
    );
    return null;
  }
}

function outcomeFor(
  attempt: ReviewAttempt,
  review: ReviewDocument | null,
  plan: RepairPlan | null,
): RunRecord['outcome'] {
  switch (attempt.status) {
    case 'CANCELLED':
      return 'REVIEW_CANCELLED';
    case 'REFUSED':
    case 'MODEL_UNAVAILABLE':
      return 'REVIEW_INCONCLUSIVE';
    case 'STALE':
      return 'REVIEW_STALE';
    case 'REVIEWED': {
      if (review === null) return 'REVIEW_STALE';
      const candidates = review.findings.filter(
        (finding) => finding.disposition === 'VALID_REPAIR_CANDIDATE',
      ).length;
      // A candidate that could not be frozen — past the cycle bounds, or over the
      // per-cycle cap — is not a candidate that was answered. It is a decision
      // somebody owes, and the record has to point at a person for it.
      if (candidates > 0) return plan ? 'REVIEW_RECORDED' : 'REVIEW_NEEDS_HUMAN';
      return review.findings.length > 0 ? 'REVIEW_NEEDS_HUMAN' : 'REVIEW_RECORDED';
    }
  }
}

function nextStageFor(
  attempt: ReviewAttempt,
  review: ReviewDocument | null,
  plan: RepairPlan | null,
): string {
  if (plan) {
    return (
      'REPAIR — the frozen plan is the work order, executed only through the bounded loop that ' +
      'already owns the writer, and judged by re-verifying the bytes it leaves'
    );
  }
  if (attempt.status === 'STALE' || review === null) {
    return (
      'VERIFY — the receipts and the review describe bytes that are not current; re-measure this ' +
      'workspace before either is quoted again'
    );
  }
  if (review.findings.length > 0) {
    return (
      'REVIEW — a person has to weigh the findings MergeSutra could not route to a repair; nothing ' +
      'in this record is ready'
    );
  }
  return (
    'REPORT — the review is filed and nothing was routed from it; a run stays unfinished until ' +
    'a human closes it'
  );
}

/**
 * Stage checks, all of them about MergeSutra's own doing.
 *
 * Note what is not here: no gate status, no criterion status, no readiness. These
 * rows say whether a second reader was consulted and what became of what it said,
 * which is a different question from whether the patch works.
 */
function describeReview(
  attempt: ReviewAttempt,
  review: ReviewDocument | null,
  plan: RepairPlan | null,
): RunCheck[] {
  const reviewed = review
    ? `${String(review.findings.length)} finding(s) from ${review.modelId} in ${String(review.attempts)} answer(s)`
    : `no review was filed (${attempt.status.toLowerCase()})`;
  const routed = review
    ? `${String(review.findings.filter((f) => f.disposition === 'VALID_REPAIR_CANDIDATE').length)} candidate(s), ${String(
        review.findings.filter((f) => f.disposition === 'NEEDS_HUMAN_REVIEW').length,
      )} for a human`
    : 'nothing to route';
  return [
    {
      name: 'Independent review',
      status: review ? 'INFO' : 'WARN',
      detail: `${reviewed} against ${attempt.reviewedPatchIdentity.slice(0, 12)}… — ${attempt.detail}`,
    },
    {
      name: 'Patch binding',
      status: attempt.patchPrecondition === 'MATCHED' ? 'INFO' : 'WARN',
      detail:
        attempt.patchPrecondition === 'MATCHED'
          ? `the bytes on disk are the bytes the reviewer was shown (${attempt.currentPatchIdentity?.slice(0, 12)}…)`
          : `${attempt.patchPrecondition.toLowerCase()} — this account does not describe the current workspace`,
    },
    {
      name: 'Disposition and routing',
      status: 'INFO',
      detail: plan
        ? `a plan was frozen for cycle ${String(plan.repairCycle)} before any edit: ${plan.expectedFiles.join(', ') || 'no files named'}`
        : routed,
    },
  ];
}

/** The newest run whose gates actually measured something — a review needs receipts. */
async function newestVerifiedRunId(store: RunStore): Promise<string> {
  const chosen = await newestRunId(store, (record) =>
    Boolean(record.verification && record.verificationPlan),
  );
  if (chosen) return chosen;
  throw new AppError({
    kind: 'validation',
    message: 'No run in this directory has been verified yet, so there is nothing to review.',
    remediation:
      'Pass a run id explicitly, or finish `mergesutra implement` and `mergesutra verify` first.',
  });
}

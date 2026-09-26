import { ZodError } from 'zod';
import { AppError } from '../core/errors.js';
import { safeJsonParse, type BharatCodeClient } from '../bharatcode/client.js';
import { defaultRedactor } from '../security/redaction.js';
import { parseReviewBody, type ReviewBody } from './schema.js';
import { buildReviewMessages, withReviewRepairFeedback } from './prompt.js';
import type { ReviewContext } from './context.js';

/**
 * The review request — Stage 9's only model call, and the one place that decides
 * whether a review is bound to a patch.
 *
 * Two rules shape this file.
 *
 * The first is §3 of the stage's brief: the patch identity is pinned when the
 * request is built and *recomputed after it returns*. A reviewer reasons over
 * bytes for as long as the endpoint takes, and a patch that moved underneath it
 * leaves a review of a diff that no longer exists. That answer is not useless —
 * it is still a second pair of eyes on real code — so the body is kept and the
 * attempt is marked `STALE`, which is the state in which no finding may drive a
 * repair. Refusing to measure, or failing to measure, binds nothing at all, and
 * says so.
 *
 * The second is that a model does not get to end a run. The body it returns is
 * checked against `reviewBodySchema`, which has no status, no score and no
 * verdict, and an answer that carries one is refused rather than trimmed. A
 * refused answer damages nothing: this function writes no files, and the patch,
 * the receipts and the contract are not in its reach.
 *
 * Errors are sorted by who caused them. A transport failure is reported as a
 * model that could not be reached. A cancellation is reported as a cancellation.
 * A bug inside MergeSutra is rethrown, because filing it as `MODEL_UNAVAILABLE`
 * would blame someone else for our own mistake.
 */

/** Beyond this, an "answer" is a runaway generation, not a review worth parsing. */
export const MAX_REVIEW_ANSWER_CHARS = 200_000;

/** Round trips allowed after a schema refusal. One is enough to fix a shape. */
export const REVIEW_SCHEMA_REPAIRS = 1;

export const REVIEW_STATUSES = [
  'REVIEWED',
  'STALE',
  'REFUSED',
  'MODEL_UNAVAILABLE',
  'CANCELLED',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Whether the patch on disk is the patch the reviewer was shown.
 * `UNMEASURABLE` covers both "it could not be measured" and "this attempt never
 * got far enough to look".
 */
export const REVIEW_PATCH_BINDINGS = ['MATCHED', 'STALE', 'UNMEASURABLE'] as const;
export type ReviewPatchBinding = (typeof REVIEW_PATCH_BINDINGS)[number];

const TRANSPORT_KINDS = new Set([
  'network',
  'timeout',
  'rate-limit',
  'server',
  'auth',
  'not-found',
  'invalid-response',
]);

const DIGEST = /^[0-9a-f]{64}$/;

export interface ReviewAttempt {
  readonly status: ReviewStatus;
  /** The reviewer's own claims, kept even when the patch has moved. */
  readonly body: ReviewBody | null;
  /** The digest the reviewer was shown, pinned by the context assembler. */
  readonly reviewedPatchIdentity: string;
  /** Null when nothing measured it; never a guess. */
  readonly currentPatchIdentity: string | null;
  readonly patchPrecondition: ReviewPatchBinding;
  /** Answers that came back and were looked at, including the first. */
  readonly attempts: number;
  /** Copied from the response envelope: the model does not get to name itself. */
  readonly model: string | null;
  readonly detail: string;
  readonly limitations: readonly string[];
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

export interface RequestReviewInput {
  readonly context: ReviewContext;
  /** Recompute the patch identity from the workspace, after the answer returns. */
  readonly currentPatchIdentity: () => Promise<string | null>;
  readonly signal?: AbortSignal;
}

export interface RequestReviewDeps {
  readonly client: BharatCodeClient;
  readonly maxSchemaRepairs?: number;
}

export async function requestReview(
  input: RequestReviewInput,
  deps: RequestReviewDeps,
): Promise<ReviewAttempt> {
  const reviewed = input.context.reviewedPatchIdentity;
  const maxRepair = deps.maxSchemaRepairs ?? REVIEW_SCHEMA_REPAIRS;
  let messages = buildReviewMessages(input.context);
  let answers = 0;
  let model: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  const outcome = (
    status: ReviewStatus,
    body: ReviewBody | null,
    detail: string,
  ): Promise<ReviewAttempt> =>
    bind({ status, body, detail, reviewed, answers, model, promptTokens, completionTokens }, input);

  const stopped = (detail: string): ReviewAttempt => ({
    status: 'CANCELLED',
    body: null,
    reviewedPatchIdentity: reviewed,
    currentPatchIdentity: null,
    patchPrecondition: 'UNMEASURABLE',
    attempts: answers,
    model,
    detail,
    limitations: [
      `REVIEW-CANCELLED: ${detail} No reviewer was consulted about this patch, so nothing here ` +
        'was read by a second pair of eyes.',
    ],
    promptTokens,
    completionTokens,
  });

  for (let attempt = 1; attempt <= maxRepair + 1; attempt += 1) {
    if (input.signal?.aborted) {
      return stopped('The review was cancelled before the reviewer was asked.');
    }

    let answer;
    try {
      answer = await deps.client.complete({
        messages: defaultRedactor.deep(messages),
        temperature: 0,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      const kind = kindOf(error);
      if (input.signal?.aborted || kind === 'cancelled') {
        return stopped('The review was cancelled while the reviewer was answering.');
      }
      if (kind === null || !TRANSPORT_KINDS.has(kind)) throw error;
      return outcome(
        'MODEL_UNAVAILABLE',
        null,
        `The reviewer could not be reached: ${errorMessage(error)}`,
      );
    }

    answers += 1;
    model = answer.model;
    promptTokens = answer.usage?.promptTokens ?? null;
    completionTokens = answer.usage?.completionTokens ?? null;

    if (answer.text.length > MAX_REVIEW_ANSWER_CHARS) {
      return outcome(
        'REFUSED',
        null,
        `The answer was ${String(answer.text.length)} characters, over the limit of ` +
          `${String(MAX_REVIEW_ANSWER_CHARS)} a review will read. It was refused without being ` +
          'parsed, because a truncated JSON object is not a review.',
      );
    }

    let body: ReviewBody | null = null;
    let problem = 'the answer was rejected';
    try {
      body = parseReviewBody(safeJsonParse(answer.text));
    } catch (error) {
      problem = `the answer did not match the review schema: ${reasonOf(error)}`;
    }

    if (body) {
      return outcome(
        'REVIEWED',
        body,
        `The reviewer filed ${String(body.findings.length)} finding(s) against the patch it was shown.`,
      );
    }

    if (attempt > maxRepair) {
      return outcome('REFUSED', null, problem);
    }
    messages = withReviewRepairFeedback(messages, problem);
  }

  // Every branch above returns; reached only if maxSchemaRepairs is negative.
  return outcome('REFUSED', null, 'no attempt was made');
}

interface BindInput {
  readonly status: ReviewStatus;
  readonly body: ReviewBody | null;
  readonly detail: string;
  readonly reviewed: string;
  readonly answers: number;
  readonly model: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * Measure the patch again and let that decide whether the answer still describes
 * it. A review body survives a moved patch; a fresh binding does not, and the
 * status carries the difference.
 */
async function bind(
  attempt: BindInput,
  input: { currentPatchIdentity: () => Promise<string | null> },
): Promise<ReviewAttempt> {
  const current = await measureIdentity(input.currentPatchIdentity);
  const binding: ReviewPatchBinding =
    current === null ? 'UNMEASURABLE' : current === attempt.reviewed ? 'MATCHED' : 'STALE';
  const status: ReviewStatus = attempt.body && binding !== 'MATCHED' ? 'STALE' : attempt.status;

  return {
    status,
    body: attempt.body,
    reviewedPatchIdentity: attempt.reviewed,
    currentPatchIdentity: current,
    patchPrecondition: binding,
    attempts: attempt.answers,
    model: attempt.model,
    detail: attempt.detail,
    limitations: [...detailLimitations(attempt, status, binding, current)],
    promptTokens: attempt.promptTokens,
    completionTokens: attempt.completionTokens,
  };
}

function detailLimitations(
  attempt: BindInput,
  status: ReviewStatus,
  binding: ReviewPatchBinding,
  current: string | null,
): readonly string[] {
  const lines: string[] = [];

  if (binding === 'STALE' && current !== null) {
    lines.push(
      'REVIEW-STALE: the patch on disk changed while the review was requested ' +
        `(${attempt.reviewed.slice(0, 12)}… is now ${current.slice(0, 12)}…), so these findings ` +
        'describe a different patch and may not drive a repair or a verdict.',
    );
  }
  if (binding === 'UNMEASURABLE') {
    lines.push(
      'REVIEW-UNBOUND: the current patch was not measured after this request, so nothing here ' +
        'proves the findings describe the bytes now in the workspace.',
    );
  }
  if (status === 'REFUSED') {
    lines.push(
      'REVIEW-REFUSED: no independent review was recorded for this patch. The absence of findings ' +
        'below is the absence of a review, not a clean result.',
    );
  }
  if (status === 'MODEL_UNAVAILABLE') {
    lines.push(
      'REVIEW-NOT-RUN: the model did not answer, so this patch has had one reader, not two.',
    );
  }

  return lines;
}

async function measureIdentity(probe: () => Promise<string | null>): Promise<string | null> {
  const raw = await probe().catch(() => null);
  return typeof raw === 'string' && DIGEST.test(raw) ? raw.toLowerCase() : null;
}

function kindOf(error: unknown): string | null {
  return error instanceof AppError ? error.kind : null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const collapsed = message.replace(/[\r\n]+/g, ' ').trim();
  return collapsed.length <= 300 ? collapsed : `${collapsed.slice(0, 297)}...`;
}

function reasonOf(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || 'review'}: ${issue.message}`)
      .join('; ');
  }
  return defaultRedactor.text(errorMessage(error));
}

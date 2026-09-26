import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { sha256Hex } from '../security/digest.js';
import { isRepositoryRelativePath } from '../security/path-safety.js';
import { criterionIdSchema } from '../plan/schema.js';

/**
 * The review protocol — Stage 9.
 *
 * This is the second artifact in MergeSutra that a model writes, and the first
 * one that a reader might trust *because* it reads like an opinion. A plan is
 * wrong, gates catch it; a review is the thing consulted when the gates were
 * silent. So the protocol is designed around the two errors a review can make:
 * deciding its own case, and describing a patch nobody pinned for it.
 *
 * `reviewBodySchema` is what the model may say. It has no status, no score, no
 * verdict and no id of its own — a finding is a claim with an anchor, and the
 * anchors are checkable while the conclusion is not.
 *
 * `reviewDocumentSchema` is what MergeSutra stores: the same claims, plus the
 * facts the model is not able to assert for itself — which patch identity was
 * pinned when the request left, which identity is on disk now, which id each
 * finding was given, and what was decided about it.
 */

export const REVIEW_SCHEMA_VERSION = 1;

/** Four words, qualitative. A number here would be read as a measurement. */
export const REVIEW_SEVERITIES = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/**
 * Nine categories, chosen to be checkable rather than expressive: each names a
 * kind of defect a reader can go and look for. A longer list is how a reviewer
 * ends up filing `POLISH` beside a broken date parser.
 */
export const REVIEW_CATEGORIES = [
  'CORRECTNESS',
  'REQUIREMENT_GAP',
  'REGRESSION_RISK',
  'ERROR_HANDLING',
  'SCOPE',
  'TEST_GAP',
  'MAINTAINABILITY',
  'REPOSITORY_POLICY',
  'SECURITY',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/**
 * What MergeSutra does with a finding. The model is not offered this field: a
 * reviewer that could dispose of its own findings would never dispose of
 * anything, and §8 of the stage's brief is that the disposition is contested.
 */
export const REVIEW_DISPOSITIONS = [
  'VALID_REPAIR_CANDIDATE',
  'NEEDS_HUMAN_REVIEW',
  'DUPLICATE',
  'OUT_OF_SCOPE',
  'UNSUPPORTED',
  'STALE',
] as const;
export type ReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number];

/** The reviewer's own account of how sure it is. Nothing downstream reads it. */
export const REVIEW_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;

const TEXT_LIMIT = 4_000;

const trimmedText = (label: string, max = TEXT_LIMIT) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, { message: `${label} must say something.` });

export const reviewLineRangeSchema = z
  .object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.to >= range.from, {
    message: 'A line range must not run backwards.',
    path: ['to'],
  });

/**
 * A finding a reviewer may file.
 *
 * The anchor rule is the substance of it: a complaint that names neither a file
 * nor a criterion cannot be checked by anyone, so it is not a finding — it is
 * the "this may have bugs" sentence the protocol exists to refuse.
 */
export const reviewFindingBodySchema = z
  .object({
    severity: z.enum(REVIEW_SEVERITIES),
    category: z.enum(REVIEW_CATEGORIES),
    statement: trimmedText('A finding statement'),
    impact: trimmedText('A finding impact'),
    evidence: trimmedText('A finding evidence line'),
    file: z
      .string()
      .min(1)
      .refine(isRepositoryRelativePath, {
        message:
          'A finding may only name a repository-relative path inside the reviewed workspace.',
      })
      .optional(),
    lineRange: reviewLineRangeSchema.optional(),
    criterionIds: z.array(criterionIdSchema).default([]),
    proposedAction: trimmedText('A proposed action', 1_000),
    confidence: z.enum(REVIEW_CONFIDENCES).optional(),
  })
  .strict()
  .refine((finding) => finding.file !== undefined || finding.criterionIds.length > 0, {
    message:
      'A finding must name a file in the diff or an Acceptance Contract criterion it bears on.',
    path: ['file'],
  });

export const reviewBodySchema = z
  .object({
    summary: trimmedText('A review summary', 2_000),
    findings: z.array(reviewFindingBodySchema).default([]),
  })
  .strict();

export type ReviewBody = z.infer<typeof reviewBodySchema>;
export type ReviewFindingBody = z.infer<typeof reviewFindingBodySchema>;

export const reviewFindingSchema = z
  .object({
    id: z.string().regex(/^RF-\d{3}$/),
    severity: z.enum(REVIEW_SEVERITIES),
    category: z.enum(REVIEW_CATEGORIES),
    statement: z.string().min(1),
    impact: z.string().min(1),
    evidence: z.string().min(1),
    file: z.string().min(1).optional(),
    lineRange: reviewLineRangeSchema.optional(),
    criterionIds: z.array(criterionIdSchema),
    proposedAction: z.string().min(1),
    confidence: z.enum(REVIEW_CONFIDENCES).optional(),
    /** Assigned by MergeSutra after the factual checks in `disposition.ts`. */
    disposition: z.enum(REVIEW_DISPOSITIONS),
    dispositionReason: z.string().min(1),
  })
  .strict();

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

const patchIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/);

export const reviewPatchPreconditionSchema = z
  .object({
    status: z.enum(['MATCHED', 'STALE']),
    reviewedIdentity: patchIdentitySchema,
    currentIdentity: patchIdentitySchema,
    reason: z.string().min(1),
  })
  .strict();

export const reviewDocumentSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
    runId: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
    reviewedPatchIdentity: patchIdentitySchema,
    currentPatchIdentity: patchIdentitySchema,
    /** The id the endpoint actually answered with, not the one a page advertises. */
    modelId: z.string().min(1),
    reviewedAt: z.string().min(1),
    /** Validating round trips including the first, so a retried review is visible. */
    attempts: z.number().int().positive(),
    summary: z.string().min(1),
    findings: z.array(reviewFindingSchema).default([]),
    patchPrecondition: reviewPatchPreconditionSchema,
    untrusted: z.literal(true).default(true),
  })
  .strict();

export type ReviewDocument = z.infer<typeof reviewDocumentSchema>;

export interface ReviewDispositionInput {
  readonly index: number;
  readonly disposition: ReviewDisposition;
  readonly reason: string;
}

export interface ReviewDocumentInput {
  readonly runId: string;
  readonly baseSha: string;
  readonly reviewedPatchIdentity: string;
  readonly currentPatchIdentity: string;
  readonly modelId: string;
  readonly reviewedAt: string;
  readonly attempts: number;
  readonly body: ReviewBody;
  readonly dispositions: readonly ReviewDispositionInput[];
}

export function parseReviewBody(value: unknown): ReviewBody {
  return reviewBodySchema.parse(value);
}

export function parseReviewDocument(value: unknown): ReviewDocument {
  return reviewDocumentSchema.parse(value);
}

/**
 * File one review result.
 *
 * Two things happen here that the model cannot do for itself. Each finding is
 * given an id in the order it arrived — an id is a handle for a disposition, and
 * a handle a model chooses can be chosen twice — and every finding must have a
 * disposition, because a finding that was never weighed is a finding that was
 * quietly dropped.
 */
export function buildReviewDocument(input: ReviewDocumentInput): ReviewDocument {
  const reviewedPatchIdentity = parseIdentity(input.reviewedPatchIdentity, 'reviewed');
  const currentPatchIdentity = parseIdentity(input.currentPatchIdentity, 'current');
  const byIndex = new Map(input.dispositions.map((entry) => [entry.index, entry]));

  const findings = input.body.findings.map((finding, index) => {
    const weighed = byIndex.get(index);
    if (!weighed) {
      throw new AppError({
        kind: 'validation',
        message: `RF-${String(index + 1).padStart(3, '0')} has no disposition.`,
        remediation:
          'Weigh every finding before storing a review: VALID_REPAIR_CANDIDATE, NEEDS_HUMAN_REVIEW, DUPLICATE, OUT_OF_SCOPE, UNSUPPORTED or STALE.',
        details: { index },
      });
    }
    return reviewFindingSchema.parse({
      ...finding,
      id: requestId(index),
      ...weighedShape(weighed),
    });
  });

  if (byIndex.size !== findings.length) {
    throw new AppError({
      kind: 'validation',
      message: `The review recorded ${findings.length} findings and weighed ${byIndex.size}.`,
      remediation: 'Give each finding exactly one disposition.',
      details: { findings: findings.length, dispositions: byIndex.size },
    });
  }

  const stale = reviewedPatchIdentity !== currentPatchIdentity;
  return parseReviewDocument({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    runId: input.runId,
    baseSha: input.baseSha,
    reviewedPatchIdentity,
    currentPatchIdentity,
    modelId: input.modelId,
    reviewedAt: input.reviewedAt,
    attempts: input.attempts,
    summary: input.body.summary,
    findings,
    patchPrecondition: {
      status: stale ? 'STALE' : 'MATCHED',
      reviewedIdentity: reviewedPatchIdentity,
      currentIdentity: currentPatchIdentity,
      reason: stale
        ? 'The patch on disk has changed since this review was requested, so its findings describe a different diff.'
        : 'The patch on disk is the patch the reviewer was shown.',
    },
  });
}

/**
 * Enough identity to notice a restated finding without collapsing two different
 * complaints: severity, category, the file it points at, the criteria it names,
 * and the statement with its spacing removed.
 */
export function findingKey(finding: ReviewFinding): string {
  return sha256Hex(
    [
      'mergesutra-review-finding/1',
      finding.severity,
      finding.category,
      finding.file ?? '-',
      [...finding.criterionIds].sort().join(','),
      finding.statement.trim().replace(/\s+/g, ' ').toLowerCase(),
    ].join('\n'),
  );
}

function requestId(index: number): string {
  return `RF-${String(index + 1).padStart(3, '0')}`;
}

function weighedShape(weighed: ReviewDispositionInput): {
  disposition: ReviewDisposition;
  dispositionReason: string;
} {
  return {
    disposition: weighed.disposition,
    dispositionReason: trimmedText('A disposition reason', 1_000).parse(weighed.reason),
  };
}

function parseIdentity(value: string, which: string): string {
  const parsed = patchIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError({
      kind: 'validation',
      message: `A review cannot be filed against the ${which} patch: the identity is not a digest.`,
      remediation: 'Measure the patch with `describePatch` before reviewing it.',
      details: { which },
    });
  }
  return parsed.data;
}

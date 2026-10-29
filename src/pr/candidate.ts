import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { sha256Hex } from '../security/digest.js';
import { branchNameProblem, REPOSITORY_HOST_PATTERN } from './branch.js';
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from './draft.js';

/**
 * The one document a human approves — Stage 10.
 *
 * A pull request asks somebody to let code into a repository that is not ours.
 * The answer has to be about *that* page: the title a reviewer reads, the body
 * they read under it, the commit range it describes, the branch it moves between,
 * the repository it lands in, and the evidence that backs its claims. This module
 * freezes all of that into one object, and `digest.ts` names it, so a yes can be
 * pointed at later and checked.
 *
 * What is inside is decided elsewhere. The title and body come from `draft.ts`,
 * the branches from `branch.ts`, the patch identity from Stage 7's measurer, the
 * pack identity from Stage 8's renderer, the review from Stage 9 — this file's
 * only inventions are `schemaVersion` and `prBodySha256`, both of which are
 * arithmetic on bytes it was handed.
 *
 * What is deliberately absent is the thing a reader might expect most: a verdict.
 * There is no `approved`, no `shouldPublish`, no `recommendation`, no `score`, and
 * no model id, because nothing in this build is entitled to decide whether a
 * person should open a pull request. `.strict()` enforces that structurally rather
 * than by convention — a candidate carrying `approved: true`, whether it came from
 * a planner, a reviewer, a repository file or a forged record, cannot be parsed at
 * all, so no later stage can be quietly talked into reading a field it was never
 * given. The words `CONTRIBUTION_READY` and `production ready` appear nowhere.
 *
 * The three `null` inputs are refusals rather than states. A candidate over
 * unmeasured bytes would bind an approval to nothing; over an unrendered pack, to
 * evidence nobody can read; over an unverified run, to claims with no receipts;
 * over an unreviewed run, to a page whose only independent reader was the model
 * that wrote the code. Each names the stage to run instead, because this stage is
 * a consumer and does not repair what it was handed.
 */

export const CANDIDATE_SCHEMA_VERSION = 2;

/**
 * Version 1 predates the host being part of the page: it named `owner/repo` only.
 * Those documents are still readable, because a human's recorded yes points at one,
 * but nothing this build writes may omit the host again.
 */
const LEGACY_CANDIDATE_SCHEMA_VERSION = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const HOST_MESSAGE = 'must be a hostname a publication could be sent to';

export const publicationCandidateSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(LEGACY_CANDIDATE_SCHEMA_VERSION),
      z.literal(CANDIDATE_SCHEMA_VERSION),
    ]),
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
    repository: z.string().min(1),
    // Beside `repository` because owner and name are not an address: the same
    // `acme/payments` exists on github.com and on any enterprise host, and a yes
    // for one of them must not authorize a send to the other.
    repositoryHost: z.string().regex(REPOSITORY_HOST_PATTERN, HOST_MESSAGE).optional(),
    baseSha: z.string().regex(COMMIT_SHA, 'must be a full lowercase commit SHA'),
    patchIdentity: z.string().regex(SHA256, 'must be a patch identity MergeSutra measured'),
    targetBranch: z.string().min(1),
    proposedBranch: z.string().min(1),
    prTitle: z.string().min(1).max(MAX_TITLE_LENGTH),
    prBody: z.string().min(1).max(MAX_BODY_LENGTH),
    prBodySha256: z.string().regex(SHA256, 'must be the digest of the body beside it'),
    evidencePackIdentity: z.string().regex(SHA256, 'must be an evidence pack identity'),
    issueCanonical: z.string().min(1).nullable(),
    closesIssue: z.boolean(),
    reviewCycle: z.number().int().positive(),
    reviewedPatchIdentity: z
      .string()
      .regex(SHA256, 'must be the patch identity the review was written against'),
    reviewSummary: z.string().min(1),
    verificationSummary: z.string().min(1),
    // In the order the run recorded them: these are the caveats on the page, and
    // re-sorting them would rewrite a document a human has already been shown.
    knownLimitations: z.array(z.string().min(1)).readonly(),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    // The digest folds in `prBodySha256` rather than the body text, so this is the
    // one place the two can be tied together. Without it a stored page could carry
    // a rewritten body beside the old hash and keep the same approval digest.
    if (sha256Hex(candidate.prBody) !== candidate.prBodySha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prBodySha256'],
        message: 'must be the digest of the body beside it',
      });
    }
    if (candidate.schemaVersion === LEGACY_CANDIDATE_SCHEMA_VERSION) {
      // A version-1 document with a host is not an old candidate: the field did
      // not exist then. Refusing it keeps the version number meaningful, and keeps
      // a forged record from claiming its host was part of what a person approved.
      if (candidate.repositoryHost !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repositoryHost'],
          message: 'a version-1 candidate predates repository hosts and cannot carry one',
        });
      }
      return;
    }
    if (candidate.repositoryHost === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryHost'],
        message: 'a version-2 candidate must name the repository host it would publish to',
      });
    }
  });

export type PublicationCandidate = z.infer<typeof publicationCandidateSchema>;

/**
 * The repository as a page prints it and as the digest names it.
 *
 * A version-1 record never knew a host, so it is shown exactly as it always was —
 * `owner/name`. Everything this build writes is `host/owner/name`. Sharing one
 * spelling between the screen and the digest is what keeps a yes to the printed
 * page a yes to the line that was hashed.
 */
export function repositoryAddressOf(candidate: PublicationCandidate): string {
  return candidate.repositoryHost === undefined
    ? candidate.repository
    : `${candidate.repositoryHost}/${candidate.repository}`;
}

export interface CandidateInput {
  readonly runId: string;
  readonly createdAt: string;
  readonly issue: {
    readonly canonical: string;
    readonly number: number;
    /** Whether the page will say this pull request *closes* the issue. */
    readonly closes: boolean;
  } | null;
  readonly target: {
    readonly host: string;
    readonly fullName: string;
    readonly branch: string;
  };
  readonly proposedBranch: string;
  readonly baseSha: string;
  readonly patchIdentity: string | null;
  readonly draft: { readonly title: string; readonly body: string };
  readonly evidencePackIdentity: string | null;
  readonly verificationSummary: string | null;
  readonly review: {
    readonly cycle: number;
    readonly reviewedPatchIdentity: string;
    readonly summary: string;
  } | null;
  readonly limitations: readonly string[];
}

/**
 * Freeze a publication candidate, or refuse and say which stage is missing.
 *
 * The result is returned through the strict schema rather than as a literal, so a
 * field this version does not know about cannot ride along out of here — the same
 * guarantee `parsePublicationCandidate` gives on the way back in.
 */
export function candidateOf(input: CandidateInput): PublicationCandidate {
  const patchIdentity = required(
    input.patchIdentity,
    'no patch identity has been measured for this run, so an approval would bind to no bytes',
    'Run `mergesutra verify` so the current patch has an identity, and re-run this stage if it has moved since.',
  );
  const evidencePackIdentity = required(
    input.evidencePackIdentity,
    'no evidence pack has been rendered for this run, so a reviewer would be asked to approve claims with nothing to check them against',
    'Run `mergesutra report` to write the pack, and note its identity in the approval.',
  );
  const verificationSummary = required(
    input.verificationSummary,
    'this run has no verification result to state on the page',
    'Run `mergesutra verify` first; MergeSutra will not put a gate it never ran on a pull request.',
  );
  const review = required(
    input.review,
    'this run has not been independently reviewed, so the only reader of these bytes is the one that wrote them',
    'Run `mergesutra review` first, and `mergesutra repair` if it found anything to fix.',
  );

  const targetProblem = branchNameProblem(input.target.branch);
  if (targetProblem !== null) {
    throw missing(
      `the target branch '${short(input.target.branch)}' ${targetProblem}, so MergeSutra will not publish against it`,
      'Re-run intake so the target branch is a plain branch name that Git reports for this repository.',
    );
  }
  if (!REPOSITORY_HOST_PATTERN.test(input.target.host)) {
    throw missing(
      `the recorded repository host '${short(input.target.host)}' is not a hostname a publication could be sent to`,
      'Re-run intake against the repository URL, so the host is one Git and the GitHub API both reported.',
    );
  }
  const sourceProblem = branchNameProblem(input.proposedBranch);
  if (sourceProblem !== null) {
    throw missing(
      `the source branch '${short(input.proposedBranch)}' ${sourceProblem}, so it cannot appear on a pull request page`,
      'Rename the branch to a plain name yourself; MergeSutra will not silently rewrite a name a human has been shown.',
    );
  }

  return publicationCandidateSchema.parse({
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    runId: input.runId,
    repository: input.target.fullName,
    repositoryHost: input.target.host,
    baseSha: input.baseSha,
    patchIdentity,
    targetBranch: input.target.branch,
    proposedBranch: input.proposedBranch,
    prTitle: input.draft.title,
    prBody: input.draft.body,
    prBodySha256: sha256Hex(input.draft.body),
    evidencePackIdentity,
    issueCanonical: input.issue?.canonical ?? null,
    closesIssue: input.issue?.closes ?? false,
    reviewCycle: review.cycle,
    reviewedPatchIdentity: review.reviewedPatchIdentity,
    reviewSummary: review.summary,
    verificationSummary,
    knownLimitations: [...input.limitations],
    createdAt: input.createdAt,
  });
}

/**
 * Read a stored candidate back, refusing anything that is not one.
 *
 * This is the only door a candidate loaded from disk comes through, and it is
 * strict on purpose: the document is what a human's yes gets pinned to, so an
 * extra `approved`, `verdict` or `force` field is not noise to be ignored but a
 * claim about this stage that its own author never made.
 */
export function parsePublicationCandidate(value: unknown): PublicationCandidate {
  const parsed = publicationCandidateSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Cannot read a publication candidate: ${
        issue?.path.join('.') || 'document'
      }: ${issue?.message ?? 'unrecognised shape'}.`,
      remediation:
        'Build the candidate from the recorded state of this run, or re-run `mergesutra pr` to regenerate it.',
      details: { reason: issue?.message ?? 'unrecognised shape' },
    });
  }
  return parsed.data;
}

function required<T>(value: T | null, reason: string, remediation: string): T {
  if (value === null) throw missing(reason, remediation);
  return value;
}

function missing(reason: string, remediation: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Cannot build a publication candidate: ${reason}.`,
    remediation,
    details: { reason },
  });
}

/** A branch name inside prose, bounded so a hostile ref cannot fill a screen. */
function short(name: string): string {
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { decidePublication, type PublicationApproval } from './approval.js';
import { branchNameProblem } from './branch.js';
import type { PublicationCandidate } from './candidate.js';
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from './draft.js';

/**
 * The line a publication crosses — Stage 10.
 *
 * Above this module everything is words: a page, a digest, a yes. This module is
 * the seam those words pass through when a human asks for them to become a draft
 * pull request, and the boundary is drawn in three places at once:
 *
 * - **Two methods, and no third.** A publisher may publish one named branch's
 *   bytes and open one named pull request. There is no `request()`, no `endpoint`,
 *   no `command()`, no generic GitHub client, and nothing that could comment,
 *   review, merge, squash, rebase, close, release or delete — a shape with those
 *   verbs in it would let anything a human never approved be done on their yes.
 * - **A request cannot carry more than its fields.** Both inputs are validated
 *   through strict schemas on the way out, so a `force`, a refspec, an `autoMerge`,
 *   a reviewer list or a `deleteBranch` flag fails here rather than arriving at a
 *   transport that might obey it. `pushBranch` has no force parameter to set, and
 *   the GitHub transport always asks for a draft.
 * - **The approval is checked at the boundary, not assumed.** `publish` re-decides
 *   the digest against the candidate in front of it before anything is handed over,
 *   so a caller cannot reach the transport with an approval written for another
 *   page or another run. The push input also carries the patch identity the human
 *   approved, and the transport re-measures the workspace against it before it
 *   sends one byte.
 *
 * `unavailableRemote()` still exists and still refuses both methods. It is the
 * default inside `runPrStage`, so a caller that can reach the stage but has not
 * wired a transport gets a refusal rather than an ambient credential. The real
 * transport is `github-publisher.ts`, is constructed only by the `pr --publish`
 * wiring, and is exercised without a network in its own tests.
 */

export interface PushBranchInput {
  readonly directory: string;
  /** The repository the branch belongs to, as `owner/name`. */
  readonly repository: string;
  readonly branch: string;
  /** The commit the patch was measured against; the new commit's only parent. */
  readonly baseSha: string;
  /** The measured bytes a human approved. Re-checked at the remote boundary. */
  readonly patchIdentity: string;
  readonly runId: string;
}

export interface CreatePullRequestInput {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

export interface PushedBranch {
  readonly branch: string;
  /** The commit the transport created, so the branch and its content are one fact. */
  readonly commitSha: string;
}

export interface PullRequestRef {
  readonly url: string;
  readonly number: number;
  /** Always true: this product opens drafts and nothing else. */
  readonly draft: true;
}

/** The whole of what a publication remote may be asked to do. */
export interface PublicationRemote {
  pushBranch(input: PushBranchInput): Promise<PushedBranch>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
}

export interface PublishedPullRequest {
  readonly branch: string;
  readonly commitSha: string;
  readonly url: string;
  readonly number: number;
  /** Always true: the transport refuses to report anything but a draft. */
  readonly draft: true;
}

const pushBranchInputSchema = z
  .object({
    directory: z.string().min(1),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be a repository as owner/name'),
    branch: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/, 'must be the full base commit SHA'),
    patchIdentity: z.string().regex(/^[0-9a-f]{64}$/, 'must be a measured patch identity'),
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  })
  .strict();

const createPullRequestInputSchema = z
  .object({
    repository: z.string().min(1),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    body: z.string().min(1).max(MAX_BODY_LENGTH),
    head: z.string().min(1),
    base: z.string().min(1),
  })
  .strict();

/**
 * The transport for a caller that reached the stage without wiring one.
 *
 * `mergesutra pr --publish` constructs the GitHub transport and hands it in, so this
 * is what a caller gets when nothing was handed over — and it has nothing to fall
 * back to: no ambient token, no `gh` on PATH, no default host. A caller who wants a
 * different answer has to pass a transport, which is a decision somebody makes in a
 * test file or in a wiring site, not a thing that happens because a variable was unset.
 */
export function unavailableRemote(): PublicationRemote {
  const refusal = (what: string) =>
    new AppError({
      kind: 'not-implemented',
      message:
        `This invocation reached the publication stage with no remote wired, so it cannot ${what}. ` +
        'Nothing was sent, and nothing here looked for a credential.',
      remediation:
        '`mergesutra pr <run-id> --publish` is the invocation that wires the GitHub transport. ' +
        'Without it, keep the approved candidate: `mergesutra report` prints the page and ' +
        '`git push` plus a pull request opened by hand gets the same review. No MergeSutra ' +
        'setting turns a command that was not asked to publish into one that did.',
      details: { action: 'CREATE_PULL_REQUEST', remote: 'not-configured' },
    });

  return {
    async pushBranch(input: PushBranchInput): Promise<PushedBranch> {
      void input;
      throw refusal('push a branch');
    },
    async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
      void input;
      throw refusal('open a pull request');
    },
  };
}

/**
 * Hand an approved candidate to a transport — if, and only if, the yes still fits.
 *
 * The order is the only sequence that makes sense: a branch that does not exist on
 * the remote cannot be the head of a pull request. Both calls are made with fields
 * copied out of the candidate the human read, so nothing is re-decided here — the
 * title arrives as written, the target branch as resolved from Git, and the head as
 * the branch that was proposed and approved together.
 */
export async function publish(input: {
  candidate: PublicationCandidate;
  approval: PublicationApproval | null;
  directory: string;
  remote: PublicationRemote;
}): Promise<PublishedPullRequest> {
  const { candidate } = input;
  const decision = decidePublication({ candidate, approval: input.approval });
  if (!decision.allowed) {
    throw new AppError({
      kind: 'validation',
      message: `Cannot publish this candidate: ${decision.reason}`,
      remediation:
        'Re-run `mergesutra pr` to see the current page, and approve that digest if it is what you meant.',
      details: { status: decision.status },
    });
  }

  const pushed = await input.remote.pushBranch(
    parsePushBranchInput({
      directory: input.directory,
      repository: candidate.repository,
      branch: candidate.proposedBranch,
      baseSha: candidate.baseSha,
      patchIdentity: candidate.patchIdentity,
      runId: candidate.runId,
    }),
  );
  const created = await input.remote.createPullRequest(
    parseCreatePullRequestInput({
      repository: candidate.repository,
      title: candidate.prTitle,
      body: candidate.prBody,
      head: candidate.proposedBranch,
      base: candidate.targetBranch,
    }),
  );

  return {
    branch: pushed.branch,
    commitSha: pushed.commitSha,
    url: created.url,
    number: created.number,
    draft: created.draft,
  };
}

/** Validate a push request at the boundary: one branch, one directory, no verbs. */
export function parsePushBranchInput(value: unknown): PushBranchInput {
  const parsed = pushBranchInputSchema.safeParse(value);
  if (!parsed.success) {
    throw refused('a branch push', parsed.error.issues[0]?.message ?? 'unrecognised request');
  }
  const problem = branchNameProblem(parsed.data.branch);
  if (problem !== null) {
    throw refused(
      'a branch push',
      `the branch '${parsed.data.branch}' ${problem}, and a name that reaches a remote has to survive being typed near a shell`,
    );
  }
  return parsed.data;
}

/** Validate a pull request at the boundary: the page, the pair of branches, nothing else. */
export function parseCreatePullRequestInput(value: unknown): CreatePullRequestInput {
  const parsed = createPullRequestInputSchema.safeParse(value);
  if (!parsed.success) {
    throw refused('a pull request', parsed.error.issues[0]?.message ?? 'unrecognised request');
  }
  for (const field of ['head', 'base'] as const) {
    const problem = branchNameProblem(parsed.data[field]);
    if (problem !== null) {
      throw refused(
        'a pull request',
        `the ${field === 'head' ? 'source' : 'target'} branch '${parsed.data[field]}' ${problem}`,
      );
    }
  }
  return parsed.data;
}

function refused(what: string, reason: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Refusing to send ${what}: ${reason}.`,
    remediation:
      'A publication request names a branch and a page, and nothing else — no force, no refspec, no merge, no reviewer.',
    details: { reason },
  });
}

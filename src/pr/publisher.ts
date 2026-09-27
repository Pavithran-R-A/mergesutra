import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { decidePublication, type PublicationApproval } from './approval.js';
import { branchNameProblem } from './branch.js';
import type { PublicationCandidate } from './candidate.js';
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from './draft.js';

/**
 * The line MergeSutra stops at — Stage 10.
 *
 * Above this module everything is words: a page, a digest, a yes. This is where a
 * product would start growing hands, and the stage's whole claim is that it has
 * none. So the boundary is drawn in three places at once:
 *
 * - **Two methods, and no third.** A publisher may push one named branch and open
 *   one named pull request. There is no `request()`, no `endpoint`, no `command()`,
 *   no generic GitHub client, and nothing that could comment, review, merge,
 *   squash, rebase, close, release or delete — a shape with those verbs in it would
 *   let anything a human never approved be done on their yes.
 * - **A request cannot carry more than its fields.** Both inputs are validated
 *   through strict schemas on the way out, so a `force`, a refspec, an `autoMerge`,
 *   a reviewer list or a `deleteBranch` flag fails here rather than arriving at a
 *   transport that might obey it. `pushBranch` has no force parameter to set.
 * - **The approval is checked at the boundary, not assumed.** `publish` re-decides
 *   the digest against the candidate in front of it before anything is handed over,
 *   so a caller cannot reach the transport with an approval written for another
 *   page or another run.
 *
 * What actually ships is `unavailableRemote()`, and it refuses both methods. That
 * is not a stub waiting for Stage 11 to make it interesting: a real pull request
 * needs commits, and MergeSutra has never made one — the work it describes is
 * uncommitted bytes in a linked worktree, and the evidence it prints is ignored by
 * Git. Pushing would mean committing somebody's tree on their behalf, which is a
 * larger act than opening a page, and no approval in this build claims to cover it.
 *
 * The fake transport in `tests/pr/publisher.test.ts` exists to prove the seam is
 * real in both directions: it can carry a publication, and production cannot.
 */

export interface PushBranchInput {
  readonly directory: string;
  readonly branch: string;
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
}

export interface PullRequestRef {
  readonly url: string;
}

/** The whole of what a publication remote may be asked to do. */
export interface PublicationRemote {
  pushBranch(input: PushBranchInput): Promise<PushedBranch>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
}

export interface PublishedPullRequest {
  readonly branch: string;
  readonly url: string;
}

const pushBranchInputSchema = z
  .object({
    directory: z.string().min(1),
    branch: z.string().min(1),
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
 * The one transport this build ships with: a refusal with two names.
 *
 * It is the value every production call site gets, and it has nothing to fall
 * back to — no ambient token, no `gh` on PATH, no default host. A caller who wants
 * a different answer has to hand `publish` a transport, which is a decision somebody
 * makes in a test file or in a later stage's wiring, not a thing that happens
 * because a variable was unset.
 */
export function unavailableRemote(): PublicationRemote {
  const refusal = (what: string) =>
    new AppError({
      kind: 'not-implemented',
      message:
        `MergeSutra has no remote configured for publishing, so it cannot ${what}. ` +
        'This build prepares and approves a pull request; it does not open one.',
      remediation:
        'Keep the approved candidate: `mergesutra report` prints the page and ' +
        '`git push` plus a pull request opened by hand gets the same review. No ' +
        'MergeSutra setting makes this stage publish.',
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
    parsePushBranchInput({ directory: input.directory, branch: candidate.proposedBranch }),
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

  return { branch: pushed.branch, url: created.url };
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

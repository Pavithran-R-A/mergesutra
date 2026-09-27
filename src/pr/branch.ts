import { AppError } from '../core/errors.js';
import type {
  LocalSnapshotStored,
  RepositoryIdentityStored,
  RunRecord,
} from '../state/run-record.js';

/**
 * The two branch names a pull request would be about — Stage 10.
 *
 * A pull request is a move *between* two named places, so both names are part of
 * what a human approves, and both are places where a bad string does damage: a
 * ref name can be a shell argument, and a target branch can be the wrong
 * repository's `main`. So this module answers both from recorded Git facts and
 * nothing else.
 *
 * - **The target is read, never chosen.** Only the two documents earlier stages
 *   filled from Git and the GitHub API may name it — `repository.defaultBranch`
 *   and `local.defaultBranch` — and when they disagree the answer is a block, not
 *   a tie-break. No model document in a run record carries a branch name at all,
 *   which is why this function takes those two fields rather than a record: the
 *   shape of its arguments is the proof that a planner's or reviewer's text has no
 *   path into a target.
 * - **The source reuses what the run already has.** Stage 5 created a worktree on
 *   a real branch, and proposing a second, unrelated name for the same commits
 *   would be a lie about where the work lives. Only when no workspace exists is a
 *   name derived — from the run id, which is already a safe path segment.
 * - **The name is a proposal.** Nothing here creates, renames, pushes or deletes a
 *   branch, and the module issues no commands: it inspects strings.
 *
 * The safety rules are deliberately tighter than `git check-ref-format`: Git
 * accepts `fix; rm -rf /` as a branch name, and a name that has to survive being
 * typed near a shell should not. Its own alphabet rule is a list of what is
 * allowed rather than a list of what is banned, because a banned-character list is
 * one novel metacharacter away from being wrong.
 */

/** Git's own practical ceiling is far higher; this one keeps the name displayable. */
export const MAX_SOURCE_BRANCH_LENGTH = 100;

/** The prefix every MergeSutra-proposed branch carries, so its owner is obvious. */
export const SOURCE_BRANCH_PREFIX = 'mergesutra';

/** Everything outside this set is refused without further argument. */
const SAFE_BRANCH_CHARS = /^[A-Za-z0-9._/-]+$/;

/**
 * A branch name is refused if it is not a plain short ref: a `refs/` spelling
 * would be resolved against the repository's own namespaces, and an exact match
 * with the target would ask GitHub to open a pull request from a branch to itself.
 */
export interface TargetBranchFacts {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly branch: string;
  readonly baseSha: string;
}

export interface TargetBranchInput {
  readonly repository: RepositoryIdentityStored | null;
  readonly local: LocalSnapshotStored | null;
  readonly base: RunRecord['base'];
}

export interface SourceBranchInput {
  readonly runId: string;
  /** The branch Stage 5 created, when this run has a workspace at all. */
  readonly workspaceBranch: string | null;
  /** Refused as a source: a pull request from a branch to itself is not a request. */
  readonly targetBranch: string;
}

export interface SourceBranch {
  readonly name: string;
  /** True when this is the branch the work is already sitting on. */
  readonly reused: boolean;
}

/**
 * Why these bytes cannot be a branch MergeSutra will propose, or `null`.
 *
 * The reason is written for a human reading a refusal, and the caller is expected
 * to show it rather than to rewrite the name.
 */
export function branchNameProblem(name: string): string | null {
  if (name.length === 0) return 'is empty';
  if (name.length > MAX_SOURCE_BRANCH_LENGTH) {
    return `is ${name.length} characters, longer than the ${MAX_SOURCE_BRANCH_LENGTH} a proposed branch may be`;
  }
  if (name.startsWith('-')) return 'begins with a dash, so it would read as a command option';
  if (!SAFE_BRANCH_CHARS.test(name)) {
    return 'carries a character outside the safe alphabet — no spaces, no shell syntax, no punctuation Git treats specially';
  }
  if (name.includes('..')) return "contains '..'";
  if (name.startsWith('/')) return 'begins with a slash';
  if (name.endsWith('/')) return 'ends with a slash';
  if (name.includes('//')) return 'contains an empty path component';
  if (name.endsWith('.')) return 'ends with a dot';
  if (name.endsWith('.lock')) return "ends with '.lock'";
  if (name.startsWith('refs/') || name.includes('/refs/')) {
    return "carries 'refs/', so it names a full ref path rather than a branch";
  }
  return null;
}

/**
 * The branch a pull request would merge into, from Git metadata only.
 *
 * A wrong target is the one mistake in this stage a reviewer cannot catch by
 * reading the diff, so an ambiguous one is refused instead of resolved: a fork
 * whose checkout tracks `legacy` while the API says `main` is exactly the case
 * where guessing costs someone their work.
 */
export function targetOf(input: TargetBranchInput): TargetBranchFacts {
  const fromApi = input.repository?.defaultBranch.trim() ?? '';
  const fromGit = input.local?.defaultBranch.trim() ?? '';
  if (fromApi.length > 0 && fromGit.length > 0 && fromApi !== fromGit) {
    throw blocked(
      `this run recorded two different default branches — '${bound(fromApi)}' from the repository API and '${bound(fromGit)}' from the local checkout`,
      'Check which branch this repository really merges into, refresh the checkout, and re-run intake so both records agree.',
    );
  }
  const branch = fromApi.length > 0 ? fromApi : fromGit;
  if (branch.length === 0) {
    throw blocked(
      'no earlier stage recorded a default branch for this repository',
      'Run `mergesutra issue` against a clone with an origin, so the target branch is one Git actually says this repository has.',
    );
  }
  const targetProblem = branchNameProblem(branch);
  if (targetProblem !== null) {
    throw blocked(
      `the recorded default branch '${bound(branch)}' ${targetProblem}, so MergeSutra will not publish against it`,
      'Re-run intake so the target branch is a plain branch name; MergeSutra will not repair a repository reference for you.',
    );
  }

  const owner = input.repository?.owner ?? input.local?.origin?.owner ?? '';
  const repo = input.repository?.repo ?? input.local?.origin?.repo ?? '';
  const host = input.repository?.host ?? input.local?.origin?.host ?? '';
  if (owner.length === 0 || repo.length === 0 || host.length === 0) {
    throw blocked(
      'this run recorded a target branch but no repository identity to put it in',
      'Run `mergesutra issue` with a URL for the repository the pull request should open against.',
    );
  }

  const baseSha = input.base?.sha ?? '';
  if (baseSha.length === 0) {
    throw blocked(
      'this run recorded no base commit, so a pull request would have no pinned starting point',
      'Run `mergesutra issue` or `mergesutra inspect` first, so the base SHA is one MergeSutra read from the repository.',
    );
  }

  return {
    host,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    branch,
    baseSha,
  };
}

/**
 * The branch the commits already sit on, or the deterministic one for this run.
 *
 * Reusing Stage 5's branch is not a convenience — a proposal naming a different
 * branch would describe commits that do not exist anywhere, and the digest bound
 * to it would approve a fiction. When there is no workspace, the name comes from
 * the run id and nothing else, so the same run proposed twice is proposed the
 * same way. A name that cannot be made safe is refused rather than sanitised: a
 * silently rewritten branch would no longer be the one the human was shown.
 */
export function sourceBranchOf(input: SourceBranchInput): SourceBranch {
  const recorded = input.workspaceBranch?.trim() ?? '';
  const name = recorded.length > 0 ? recorded : `${SOURCE_BRANCH_PREFIX}/${input.runId}`;
  if (name === input.targetBranch) {
    throw blocked(
      `the work sits on '${bound(name)}', which is the target branch itself`,
      'Create the work on its own branch; MergeSutra will not propose a pull request from a branch to itself.',
    );
  }
  const problem = branchNameProblem(name);
  if (problem !== null) {
    throw blocked(
      recorded.length > 0
        ? `the branch this run is on ('${bound(name)}') ${problem}, so MergeSutra will not propose it`
        : `the run id cannot be turned into a branch name: it ${problem}`,
      recorded.length > 0
        ? 'Rename the workspace branch to a plain name yourself, then re-run this stage.'
        : 'Start a fresh run; a run id is meant to be a plain identifier.',
    );
  }
  return { name, reused: recorded.length > 0 };
}

function blocked(reason: string, remediation: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Cannot name a branch for a pull request: ${reason}.`,
    remediation,
  });
}

/** A name quoted back at a human: one line, bounded, because it came from a record. */
function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}...`;
}

import type { RepositoryContext } from '../github/types.js';
import { defaultRedactor } from '../security/redaction.js';
import type { RunCheck, RunRecord } from '../state/run-record.js';
import type { RunStore, RunSummary } from '../state/run-store.js';
import { readableRuns } from '../state/run-selection.js';

/**
 * Carrying the issue Stage 1 already established into the run Stage 2 writes.
 *
 * `mergesutra issue <url> --repo <clone>` records the issue and no repository
 * contract; `mergesutra inspect <clone>` records the contract and, until this
 * module existed, no issue. `mergesutra contract` reads exactly one run, so the
 * documented chain could only ever arrive with one of the two facts and the
 * advice printed beside each gap pointed at the command that had produced the
 * other. This module closes the circle where it belongs — in the record — by
 * copying an intake's issue forward when, and only when, it can prove the intake
 * was about *this* checkout at *this* commit.
 *
 * The proof is three facts, all read from data this stage already has or from the
 * intake record's own claims, plus one condition the record has to meet about
 * itself:
 *
 * 1. this clone names an `origin`, and its host/owner/repo equal the host/owner/repo
 *    the intake's issue belongs to;
 * 2. the intake pinned a base commit, and it is the commit being inspected now;
 * 3. the intake record actually holds both an issue reference and an issue document;
 * 4. if the intake also recorded a repository identity, that identity names this
 *    same clone — a record that disagrees with itself lends nothing.
 *
 * What is carried is therefore the pair Stage 1 read from GitHub: the issue and the
 * repository it belongs to, the second only filling the gap a clone leaves when Git
 * cannot resolve its remote HEAD (see `identityFromLocalSnapshot`), never overwriting
 * what Git observed here. Without that second half the documented chain reaches
 * `mergesutra pr` and stops at "no earlier stage recorded a default branch", which is
 * the mistake Stage 10 exists to refuse to guess its way past.
 *
 * Deliberately *not* part of the proof: the directory path. A person who clones
 * the same repository twice, or moves a clone, still has the same repository at
 * the same commit — and a path comparison would refuse the carry for reasons that
 * say nothing about which repository a run describes. Conversely no path is
 * written into any string this module produces; only a remote's host, owner and
 * repository name are, and those come from `parseRepositoryUrl`, which discards
 * any userinfo a remote URL may have carried.
 *
 * The walk is bounded (see `INTAKE_SCAN_BOUND`) and it never throws. Stage 2's job
 * is to report what a repository declares; a run store it cannot read is an
 * absence to state, not a reason to stop inspecting.
 */

/** The check row Stage 2 prints about this decision. */
export const CARRY_CHECK_NAME = 'Issue from intake';

/**
 * How many of the newest records one inspection may open.
 *
 * A run directory grows for as long as a person keeps a repository, and an
 * unbounded "find the newest intake" would read every file in it on every
 * `inspect`. Twenty-five is chosen so an ordinary chain (issue, inspect,
 * contract, plan, implement, verify, review, one or two retries) stays entirely
 * inside the window while a pathological directory costs a bounded number of
 * reads. When the window is what stopped a carry, the check says so instead of
 * claiming no intake ever happened.
 */
export const INTAKE_SCAN_BOUND = 25;

export interface CarryInput {
  readonly store: RunStore;
  /** What this clone's `origin` remote resolves to, or null when it names none. */
  readonly origin: RepositoryContext | null;
  /** The commit being inspected now, or null when Git could not name one. */
  readonly headSha: string | null;
}

export interface CarryResult {
  readonly check: RunCheck;
  readonly issueRef: RunRecord['issueRef'];
  readonly issue: RunRecord['issue'];
  /**
   * The repository identity the same intake read from GitHub, offered for the one
   * case it is needed: a clone whose `origin` names a repository but whose remote
   * HEAD Git cannot resolve, so Stage 2's own identity is null. What Git did
   * observe is never replaced by what another run read.
   */
  readonly repository: RunRecord['repository'];
  /**
   * Stated in the record beside a carried issue, naming the run it came from.
   * A reader of the Stage 2 record has to be able to tell a copied fact from an
   * observed one, so the carry is never silent.
   */
  readonly limitation: string | null;
  /** The same, for the carried repository identity, and only when one was read. */
  readonly repositoryLimitation: string | null;
}

const EMPTY: Pick<
  CarryResult,
  'issueRef' | 'issue' | 'repository' | 'limitation' | 'repositoryLimitation'
> = {
  issueRef: null,
  issue: null,
  repository: null,
  limitation: null,
  repositoryLimitation: null,
};

export async function carryIssueFromIntake(input: CarryInput): Promise<CarryResult> {
  const { store, origin, headSha } = input;

  if (headSha === null) {
    return refuse(
      'this checkout has no resolvable commit, so no intake run could be proved to describe it',
    );
  }
  if (origin === null) {
    return refuse(
      "this clone's origin remote is absent or unreadable, so which repository it is cannot be proved",
    );
  }

  let runs: readonly RunSummary[];
  try {
    runs = await readableRuns(store);
  } catch (error) {
    return {
      ...EMPTY,
      check: {
        name: CARRY_CHECK_NAME,
        status: 'NOT_AVAILABLE',
        detail: describeStoreFault(error),
      },
    };
  }

  if (runs.length === 0) {
    return refuse(
      'this store holds no run record; `mergesutra issue <url> --repo <path>` writes the one an inspection can carry',
    );
  }

  const scanned = runs.slice(0, INTAKE_SCAN_BOUND);
  const reasons: { base?: string; identity?: string } = {};

  for (const summary of scanned) {
    let intake: RunRecord;
    try {
      intake = await store.load(summary.runId);
    } catch (error) {
      return {
        ...EMPTY,
        check: {
          name: CARRY_CHECK_NAME,
          status: 'NOT_AVAILABLE',
          detail: describeStoreFault(error),
        },
      };
    }
    if (intake.stage !== 'intake' || !intake.issueRef || !intake.issue) continue;

    if (!sameClone(intake.issueRef, origin)) {
      reasons.identity ??= `the newest intake here is for ${intake.issueRef.canonical}, which '${namedRepository(origin)}' is not`;
      continue;
    }
    if (intake.base?.sha !== headSha) {
      reasons.base ??= `the intake run ${intake.runId} pinned base commit ${short(intake.base?.sha ?? '(none)')}, but this checkout is at commit ${short(headSha)}`;
      continue;
    }
    // The same record has to agree with itself before either half is trusted. A
    // run whose issue names this clone but whose repository field names another
    // is not describing a place a person forgot to fetch — it is a record this
    // build cannot account for, and the target branch it would lend a pull
    // request is the one wrong fact a reviewer cannot see in a diff.
    if (intake.repository && !sameClone(intake.repository, origin)) {
      return refuse(
        `the intake run ${intake.runId} does not agree with itself: its issue belongs to ${intake.issueRef.canonical}, but it also records a repository named ${intake.repository.owner}/${intake.repository.repo}, which '${namedRepository(origin)}' is not`,
      );
    }

    return {
      issueRef: intake.issueRef,
      issue: intake.issue,
      repository: intake.repository,
      limitation:
        `The issue in this record was carried from run ${intake.runId}, which read it from GitHub. ` +
        'This stage re-read no issue and did not check that it is still open.',
      repositoryLimitation: intake.repository
        ? `The repository identity in this record, including the default branch '${intake.repository.defaultBranch}' a pull request would merge into, was carried from run ${intake.runId}, which read it from GitHub. ` +
          'This stage called no API and re-read none of it.'
        : null,
      check: {
        name: CARRY_CHECK_NAME,
        status: 'PASS',
        detail: `carried from run ${intake.runId}: ${intake.issueRef.canonical} at base ${short(headSha)}`,
      },
    };
  }

  const reason = reasons.base ?? reasons.identity;
  return refuse(
    reason ??
      `no intake run among the newest ${String(scanned.length)} record(s) of ${String(runs.length)} readable here`,
  );
}

function refuse(detail: string): CarryResult {
  return { ...EMPTY, check: { name: CARRY_CHECK_NAME, status: 'SKIP', detail } };
}

/**
 * GitHub names are case-insensitive and `origin` is lower-cased by the parser
 * that made it, so neither side of this comparison is trusted for its case.
 *
 * One function serves both halves of the proof — an issue reference and a
 * repository identity are the same three fields here, and an identity claimed by
 * two code paths is an identity one of the paths can quietly stop checking.
 */
function sameClone(identity: RepositoryContext, origin: RepositoryContext): boolean {
  return (
    identity.host.toLowerCase() === origin.host.toLowerCase() &&
    identity.owner.toLowerCase() === origin.owner.toLowerCase() &&
    identity.repo.toLowerCase() === origin.repo.toLowerCase()
  );
}

function namedRepository(origin: RepositoryContext): string {
  return `${origin.owner}/${origin.repo}`;
}

function short(sha: string): string {
  return sha.slice(0, 10);
}

/**
 * The store's own words, bounded and redacted, because an error from a run file
 * may quote the bytes that broke it — and §27 forbids both printing those and
 * quietly repairing them so the stage can proceed.
 */
function describeStoreFault(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = defaultRedactor.text(message);
  const firstLine = safe.split('\n')[0] ?? '';
  return `run store could not be consulted — ${firstLine.length > 180 ? `${firstLine.slice(0, 180)}…` : firstLine}`;
}

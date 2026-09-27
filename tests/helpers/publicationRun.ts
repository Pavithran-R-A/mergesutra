import { toIssueDocument } from '../../src/github/schemas.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { writeEvidencePack } from '../../src/report/write.js';
import { recordWith } from './review.js';
import { reviewedRun, type RepairFixture } from './repairRun.js';
import { issuePayload } from '../fixtures/github-payloads.js';
import { ISSUE_URL } from './github.js';
import type { ImplementationRecord } from '../../src/implement/state.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * A run a pull request could genuinely be proposed for — Stage 10's fixture.
 *
 * `reviewedRun` already supplies the parts Stage 10 reads as facts: a real Git
 * workspace, two measured verification rounds, a review pinned to those bytes.
 * Three things have to be added for a publication proposal, and none of them is a
 * shortcut, because each is a document or a value Stage 10 refuses to invent:
 *
 * - **The evidence pack, on disk.** Stage 10 binds an approval to the pack a
 *   reviewer can open, so the fixture has to have one. It is written from the same
 *   record the store holds, by Stage 8's real renderer, so the identity the stage
 *   reads back is the identity a person reading `report.md` would compute.
 * - **A branch of its own.** `stubImplementation` says `main` because Stage 7 never
 *   reads the field, and Stage 5's real worktree is on `mergesutra/<run id>`. Left
 *   at `main` the run would be refused for proposing a pull request into itself, so
 *   the fixture states the branch a real run has — and a test that wants the
 *   refusal says so explicitly.
 * - **The issue it came from.** Stage 1's intake is what normally records an issue;
 *   this fixture's chain starts from a repository. The page has to carry that
 *   identity, so it is attached through the real record constructor and the real
 *   issue document schema rather than hand-written.
 */
export interface PublicationFixture extends RepairFixture {
  readonly packIdentity: string;
  readonly packDir: string;
}

/** The issue `proposedRun` attaches: the same one the CLI fixtures use. */
export const FIXTURE_ISSUE = {
  host: 'github.com',
  owner: 'projectbharat',
  repo: 'datekit',
  number: 123,
  canonical: 'projectbharat/datekit#123',
  url: ISSUE_URL,
};

export const FIXTURE_ISSUE_DOCUMENT = toIssueDocument(issuePayload);

export async function proposedRun(
  tempDirs: string[],
  options: {
    readonly movePatchAfterPlan?: boolean;
    /**
     * Leave the review with a HIGH finding still routed to a repair.
     *
     * Off by default, and that default is a fact about Stage 10 rather than a
     * convenience: a candidate may only be proposed once nothing at BLOCKER or HIGH
     * is left waiting for a repair cycle, so the ordinary case for this fixture is
     * the reviewed-and-answered run. A test that wants the refusal asks for it.
     */
    readonly findings?: boolean;
    /** Leave the workspace on `main`, so the run cannot propose a pull request. */
    readonly workOnTargetBranch?: boolean;
    /**
     * Mark one criterion something the gate evidence does not carry.
     *
     * The fixture's scripted gates pass every criterion, which entitles the page to
     * close the issue; a test about *not* closing it has to change the record rather
     * than argue from a record that says the opposite. The row is edited before the
     * pack is rendered, so the page and the evidence a reviewer can open agree.
     */
    readonly criterionNeedsAHuman?: boolean;
  } = {},
): Promise<PublicationFixture> {
  const reviewed = await reviewedRun(tempDirs, {
    movePatchAfterPlan: options.movePatchAfterPlan,
    findings: options.findings ?? false,
  });
  const record = recordWith(reviewed.record, {
    issueRef: FIXTURE_ISSUE,
    issue: FIXTURE_ISSUE_DOCUMENT,
    ...(options.workOnTargetBranch ? {} : { implementation: onItsOwnBranch(reviewed.record) }),
    ...(options.criterionNeedsAHuman && reviewed.record.evidence
      ? {
          evidence: {
            ...reviewed.record.evidence,
            criteria: reviewed.record.evidence.criteria.map((criterion, index) =>
              index === 0
                ? {
                    ...criterion,
                    status: 'PENDING' as const,
                    sufficiency: 'MANUAL_REVIEW_REQUIRED' as const,
                  }
                : criterion,
            ),
          },
        }
      : {}),
  });
  await reviewed.store.save(record);

  const pack = buildEvidencePack(record);
  const where = await writeEvidencePack(reviewed.runsRoot, pack);

  return { ...reviewed, record, packIdentity: pack.identity, packDir: where.dir };
}

/** What Stage 5's worktree really is called, and on which base it sits. */
export function onItsOwnBranch(record: RunRecord): ImplementationRecord {
  const implementation = record.implementation;
  if (!implementation) {
    throw new Error('the fixture run has no implementation record to place on a branch');
  }
  return {
    ...implementation,
    workspace: { ...implementation.workspace, branch: `mergesutra/${record.runId}` },
  };
}

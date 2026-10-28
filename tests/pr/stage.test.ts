import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../src/core/errors.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { runPrStage } from '../../src/pr/stage.js';
import type {
  CreatePullRequestInput,
  PublicationRemote,
  PushBranchInput,
} from '../../src/pr/publisher.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { readPackIdentity, writeEvidencePack } from '../../src/report/write.js';
import { sha256Hex } from '../../src/security/digest.js';
import { describePatch } from '../../src/verify/patch.js';
import { recordWith } from '../helpers/review.js';
import { onItsOwnBranch, proposedRun, FIXTURE_ISSUE } from '../helpers/publicationRun.js';
import { cleanUp, errorFrom, hasGit, implementedRun } from '../helpers/verifyRun.js';
import type { PublicationRecord } from '../../src/pr/record.js';
import type { RunCheck } from '../../src/state/run-record.js';

/**
 * Stage 10's transition: recorded evidence becomes a page, and a page becomes a
 * filing — never a publication.
 *
 * Everything the stage assembles already exists somewhere: the title is the issue's,
 * the file list is Git's, the gate rows are Stage 7's receipts, the review is Stage
 * 9's, the caveats belong to whichever stage earned them. So the failures worth
 * testing here are not arithmetic mistakes but orderings — proposing a page over
 * bytes that have moved, letting the act of recording an approval expire that
 * approval, handing a stored yes to a different page, or reporting a remote outcome
 * the build has no hands to cause. Each is asserted against a real Git workspace, a
 * real renderer and real receipts.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/**
 * Same reason as Stage 9R's suite: each fixture builds a real repository and drives
 * Stages 7 and 9 through it, which on this filesystem is tens of seconds of honest
 * work rather than a hang. The budget is raised for the file; no assertion in it is
 * softened, and a stage that truly hung would still fail.
 */
vi.setConfig({ testTimeout: 120_000 });

/** The clock a publication runs on — later than every document it reads. */
const PR_NOW = new Date('2026-09-25T12:00:00.000Z');

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function scratchRunsRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-pr-pack-'));
  tempDirs.push(dir);
  return dir;
}

function rowsOf(checks: readonly RunCheck[]): string {
  return checks.map((row) => `${row.name}: ${row.detail}`).join('\n');
}

function filed(entries: readonly PublicationRecord[]): { candidate: unknown; approval: unknown }[] {
  return entries.map((entry) => ({ candidate: entry.candidate, approval: entry.approval }));
}

const PUBLISHED_URL = 'https://github.com/projectbharat/datekit/pull/7';
const PUSHED_SHA = 'd'.repeat(40);

/**
 * A transport that answers in memory, so *when* the stage asks and *what* it hands
 * over can be judged without a network. What the real transport sends — blobs, a
 * tree, a ref, a draft body — is asserted field by field in its own suite; this fake
 * exists to prove the stage's side of the boundary.
 */
function fakeRemote(options: { pushFails?: boolean; pullFails?: boolean } = {}): {
  remote: PublicationRemote;
  pushes: PushBranchInput[];
  pulls: CreatePullRequestInput[];
} {
  const pushes: PushBranchInput[] = [];
  const pulls: CreatePullRequestInput[] = [];
  const remote: PublicationRemote = {
    async pushBranch(input) {
      pushes.push(input);
      if (options.pushFails === true) {
        throw new AppError({ kind: 'validation', message: 'scripted push failure' });
      }
      return { branch: input.branch, commitSha: PUSHED_SHA };
    },
    async createPullRequest(input) {
      pulls.push(input);
      if (options.pullFails === true) {
        throw new AppError({ kind: 'invalid-response', message: 'scripted pull failure' });
      }
      return { url: PUBLISHED_URL, number: 7, draft: true };
    },
  };
  return { remote, pushes, pulls };
}

describe.skipIf(!AVAILABLE)('runPrStage', () => {
  it('blocks a run that has never been verified or reviewed, and says which stage is missing', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    await prepared.store.save(recordWith(source, { implementation: onItsOwnBranch(source) }));
    const runsRoot = await scratchRunsRoot();

    const result = await runPrStage(
      { runId: source.runId },
      { store: prepared.store, runsRoot, now: () => PR_NOW },
    );

    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(result.candidate).toBeNull();
    expect(result.published).toBe(false);
    expect(result.readiness.blocking.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        'verification-current',
        'verification-passed',
        'review-current',
        'pack-current',
        'human-approved',
      ]),
    );
    // A consumer says where to go instead of going there itself.
    const rows = rowsOf(result.checks);
    expect(rows).toMatch(/mergesutra verify/);
    expect(rows).toMatch(/mergesutra review/);
    expect(rows).toMatch(/mergesutra report/);
    expect(rows).toMatch(/no gate was re-run|not re-run|will not re-run/i);

    const saved = await prepared.store.load(source.runId);
    expect(saved.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(filed(saved.publications)).toEqual([]);
  });

  it('refuses to propose a page whose verification and review describe bytes that have moved', async () => {
    const fixture = await proposedRun(tempDirs, { movePatchAfterPlan: true });
    const moved = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    expect(moved.identity).not.toBe(fixture.identityA);

    const result = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(result.readiness.blocking.map((row) => row.id)).toEqual(
      expect.arrayContaining(['verification-current', 'review-current', 'pack-current']),
    );
    expect(result.candidate).toBeNull();
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(filed((await fixture.store.load(fixture.record.runId)).publications)).toEqual([]);
  });

  it('assembles the page from the record alone, with every field traceable to a document', async () => {
    const fixture = await proposedRun(tempDirs);

    const result = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    const candidate = result.candidate;
    if (!candidate) throw new Error('the run was proposed and filed no candidate');
    expect(candidate).toMatchObject({
      schemaVersion: 1,
      runId: fixture.record.runId,
      repository: 'projectbharat/datekit',
      baseSha: fixture.base,
      patchIdentity: fixture.identityA,
      targetBranch: 'main',
      proposedBranch: `mergesutra/${fixture.record.runId}`,
      evidencePackIdentity: fixture.packIdentity,
      issueCanonical: FIXTURE_ISSUE.canonical,
      reviewCycle: 1,
      reviewedPatchIdentity: fixture.identityA,
      createdAt: PR_NOW.toISOString(),
    });
    expect(candidate.prBodySha256).toBe(sha256Hex(candidate.prBody));
    expect(candidate.verificationSummary).toMatch(/PASS/);
    expect(candidate.prTitle).toBe('Parser accepts invalid empty dates');
    expect(candidate.prBody).toContain('## Summary');
    expect(candidate.prBody).toContain('## Independent Review');
    expect(candidate.prBody).toContain('src/parse.ts');
    // Every criterion in this record is verified on exactly these bytes and the issue
    // lives in the target repository, so the page is allowed to close it.
    expect(candidate.closesIssue).toBe(true);
    expect(candidate.prBody).toContain('Fixes #123');
    expect(candidate.prBody).not.toContain('Related to #123');
    // The review summary is Stage 9's sentence, not a paraphrase of it.
    expect(candidate.reviewSummary).toBe(fixture.record.review?.summary);

    expect(result.digest).toBe(publicationDigestOf(candidate));
    expect(result.outcome).toBe('PR_CANDIDATE_RECORDED');
    // The stage read the workspace; it did not move it.
    const stillThere = await describePatch({
      workspace: fixture.workspace,
      baseSha: fixture.base,
    });
    expect(stillThere.identity).toBe(fixture.identityA);
  });

  it('links the issue without closing it while a criterion still waits on a person', async () => {
    const fixture = await proposedRun(tempDirs, { criterionNeedsAHuman: true });

    const result = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    const candidate = result.candidate;
    if (!candidate) throw new Error('the run was proposed and filed no candidate');
    expect(candidate.closesIssue).toBe(false);
    expect(candidate.prBody).toContain('Related to #123');
    expect(candidate.prBody).not.toMatch(/Fixes #/);
    // A criterion a person still owes is a limitation on the page, not a reason to
    // hold the proposal back: the eight readiness facts are about evidence, not merit.
    expect(result.outcome).toBe('PR_CANDIDATE_RECORDED');
  });

  it('files the proposal with no approval and prints the exact words that would approve it', async () => {
    const fixture = await proposedRun(tempDirs);

    const result = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(result.decision?.status).toBe('ABSENT');
    expect(result.decision?.reason).toContain(
      `mergesutra pr ${fixture.record.runId} --approve ${result.digest}`,
    );
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_CANDIDATE_RECORDED');
    expect(filed(saved.publications)).toEqual([{ candidate: result.candidate, approval: null }]);
  });

  it('records a digest-matched approval as a local fact, and files no remote outcome', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    const approved = await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(approved.outcome).toBe('PR_APPROVED_LOCAL');
    expect(approved.decision?.status).toBe('MATCHED');
    expect(approved.published).toBe(false);
    expect(approved).not.toHaveProperty('prUrl');
    expect(approved).not.toHaveProperty('pullRequestUrl');
    expect(approved).not.toHaveProperty('url');

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_APPROVED_LOCAL');
    // The yes belongs to the proposal already on file, so the page is not filed twice.
    expect(filed(saved.publications)).toEqual([
      {
        candidate: shown.candidate,
        approval: {
          schemaVersion: 1,
          runId: fixture.record.runId,
          publicationDigest: shown.digest,
          approvedAt: PR_NOW.toISOString(),
          action: 'CREATE_PULL_REQUEST',
        },
      },
    ]);
    // A publication entry holds no address for a pull request that does not exist.
    // (The page inside it quotes the issue's URL, which is an input, not an outcome,
    // and `CREATE_PULL_REQUEST` is the name of what was agreed to, not of a result.)
    expect(JSON.stringify(saved.publications)).not.toMatch(
      /"url"|prUrl|html_url|pullRequestUrl|github\.com\/[^"]*\/pull\//i,
    );
  });

  it('does not ask a supplied transport when --publish is absent, however complete the approval', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const fake = fakeRemote();

    const approved = await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote: fake.remote },
    );

    expect(approved.outcome).toBe('PR_APPROVED_LOCAL');
    expect(approved.publishRequested).toBe(false);
    expect(approved.publication).toBeNull();
    expect(fake.pushes).toEqual([]);
    expect(fake.pulls).toEqual([]);
    // The page this row is refusing to send is a page whose send is still ahead of the
    // reader, so it names the send. Four cases below assert that a *sent* or refused
    // page does not; without this control they would also pass on a build that had
    // stopped naming the flag anywhere.
    expect(rowsOf(approved.checks)).toMatch(/`mergesutra pr \S+ --publish`/);
    expect(approved.record.nextStage).toMatch(/`mergesutra pr \S+ --publish`/);
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(shown.digest);
    expect(saved.publications[0]?.result).toBeNull();
  });

  it('asks a transport for a draft only when publishing was requested and the page matched', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const candidate = shown.candidate;
    if (!candidate) throw new Error('the run was proposed and filed no candidate');
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const fake = fakeRemote();

    const published = await runPrStage(
      { runId: fixture.record.runId, publish: true },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote: fake.remote },
    );

    // The transport receives the measured directory and the page's own fields — not
    // a re-lookup, a re-rendered body or a branch resolved a second time.
    expect(fake.pushes).toEqual([
      {
        directory: fixture.workspace,
        repository: 'projectbharat/datekit',
        branch: candidate.proposedBranch,
        baseSha: fixture.base,
        patchIdentity: fixture.identityA,
        runId: fixture.record.runId,
      },
    ]);
    expect(fake.pulls).toEqual([
      {
        repository: 'projectbharat/datekit',
        title: candidate.prTitle,
        body: candidate.prBody,
        head: candidate.proposedBranch,
        base: candidate.targetBranch,
      },
    ]);
    expect(published.outcome).toBe('PR_DRAFT_OPENED');
    expect(published.published).toBe(true);
    expect(published.publicationFailure).toBeNull();
    expect(published.publication).toEqual({
      branch: candidate.proposedBranch,
      commitSha: PUSHED_SHA,
      url: PUBLISHED_URL,
      number: 7,
      draft: true,
    });
    // The page and its digest did not move because a remote answered.
    expect(published.candidate).toEqual(candidate);
    expect(published.digest).toBe(shown.digest);
    const rows = rowsOf(published.checks);
    expect(rows).toMatch(/draft pull request #7/);
    expect(rows).toMatch(/merging, reviewing and closing are human acts/i);
    // The draft is now a remote fact this run owns, so no row may still offer the send
    // that just happened — a second `--publish` would ask for a duplicate branch.
    expect(rows).not.toMatch(/--publish|to ask GitHub for a draft pull request/i);
    // A draft GitHub reported is not a send that is "settled": what the page becomes
    // next is decided in GitHub, and the only thing this row can promise is its own
    // refusal to offer a second send.
    expect(rows).toMatch(/this row offers no second send/i);
    expect(rows).not.toMatch(/the send is settled|nothing further is offered/i);
    expect(published.record.nextStage).toMatch(/DRAFT_PULL_REQUEST_OPENED/);
    expect(published.record.nextStage).toMatch(/Nothing was merged/);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_DRAFT_OPENED');
    expect(saved.publications).toHaveLength(1);
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(shown.digest);
    expect(saved.publications[0]?.result).toEqual({
      url: PUBLISHED_URL,
      number: 7,
      draft: true,
      publishedAt: PR_NOW.toISOString(),
    });
    // The result vocabulary has no room for a merge.
    expect(Object.keys(saved.publications[0]?.result ?? {}).sort()).toEqual([
      'draft',
      'number',
      'publishedAt',
      'url',
    ]);
  });

  it('reports the draft already on file on a later read, and never asks for a second one', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '', publish: true },
      {
        store: fixture.store,
        runsRoot: fixture.runsRoot,
        now: () => PR_NOW,
        remote: fakeRemote().remote,
      },
    );
    const opened = (await fixture.store.load(fixture.record.runId)).publications[0]?.result;
    expect(opened).not.toBeNull();

    // A later reading of the same run, with no flags. The draft is a fact the run
    // owns, so the screen and the record may not fall back to "no remote change".
    const reread = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(reread.outcome).toBe('PR_DRAFT_OPENED');
    expect(reread.published).toBe(false);
    expect(reread.publication).toBeNull();
    expect(reread.recordedPublication).toEqual(opened);
    expect(rowsOf(reread.checks)).toMatch(/already records draft pull request #7/);
    expect(rowsOf(reread.checks)).not.toMatch(
      /No branch was pushed and no pull request was opened/,
    );
    expect(reread.record.nextStage).toMatch(/This command sent nothing/);
    expect((await fixture.store.load(fixture.record.runId)).publications[0]?.result).toEqual(
      opened,
    );

    // Asking again does not request a duplicate branch or a second pull request.
    const second = fakeRemote();
    const again = await runPrStage(
      { runId: fixture.record.runId, publish: true },
      {
        store: fixture.store,
        runsRoot: fixture.runsRoot,
        now: () => PR_NOW,
        remote: second.remote,
      },
    );

    expect(second.pushes).toEqual([]);
    expect(second.pulls).toEqual([]);
    expect(again.outcome).toBe('PR_DRAFT_OPENED');
    expect(again.publication).toBeNull();
    expect(again.recordedPublication).toEqual(opened);
    expect((await fixture.store.load(fixture.record.runId)).publications[0]?.result).toEqual(
      opened,
    );
  });

  it('does not ask a transport when --publish is given but no approval covers the page', async () => {
    const fixture = await proposedRun(tempDirs);
    const fake = fakeRemote();

    const result = await runPrStage(
      { runId: fixture.record.runId, publish: true },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote: fake.remote },
    );

    expect(fake.pushes).toEqual([]);
    expect(fake.pulls).toEqual([]);
    expect(result.publishRequested).toBe(true);
    expect(result.publication).toBeNull();
    expect(result.outcome).toBe('PR_CANDIDATE_RECORDED');
    expect(rowsOf(result.checks)).toMatch(/publishing was requested, but no human approval/i);
    expect(result.record.nextStage).toMatch(/NEEDS_HUMAN_APPROVAL/);
    expect(filed((await fixture.store.load(fixture.record.runId)).publications)).toEqual([
      { candidate: result.candidate, approval: null },
    ]);
  });

  it('reports a failed push as a changed remote, keeps the yes and files no result', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const fake = fakeRemote({ pushFails: true });

    const failed = await runPrStage(
      { runId: fixture.record.runId, publish: true },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote: fake.remote },
    );

    expect(failed.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(failed.published).toBe(false);
    expect(failed.publication).toBeNull();
    expect(failed.publicationFailure).toMatch(/scripted push failure/);
    // A partial write is possible, so the row may not say nothing happened.
    expect(rowsOf(failed.checks)).toMatch(/remote may have changed/i);
    // The transport supplied no remediation, so the stage must not invent a retry
    // for a failure whose write may already have landed.
    expect(rowsOf(failed.checks)).not.toMatch(
      /before retrying|retry only|try again|then retry|retry if/i,
    );
    // And it must not offer the send that just failed as though it were the next step.
    expect(rowsOf(failed.checks)).not.toMatch(/--publish|to ask GitHub for a draft pull request/i);
    expect(failed.record.nextStage).toMatch(/PUBLICATION_FAILED/);
    expect(failed.record.nextStage).not.toMatch(
      /before retrying|retry only|try again|then retry|retry if/i,
    );
    expect(fake.pulls).toEqual([]);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(shown.digest);
    expect(saved.publications[0]?.result).toBeNull();
  });

  it("carries a read-back refusal's do-not-retry remediation instead of advising a retry", async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const remote: PublicationRemote = {
      async pushBranch() {
        throw new AppError({
          kind: 'invalid-response',
          retryable: false,
          message:
            "GitHub accepted the request to create branch 'mergesutra/x' at commit " +
            `${'d'.repeat(40)}, but MergeSutra could not verify what it stored: ` +
            'the tree listing was truncated.',
          remediation:
            'Do not retry this command; inspect the branch and any pull request on GitHub, and ' +
            'decide what it should carry. MergeSutra will not move, force or delete a branch it created.',
        });
      },
      async createPullRequest() {
        throw new Error('a read-back refusal must not reach the pull request');
      },
    };

    const failed = await runPrStage(
      { runId: fixture.record.runId, publish: true },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote },
    );

    expect(failed.outcome).toBe('PR_PUBLICATION_BLOCKED');
    const rows = rowsOf(failed.checks);
    expect(rows).toMatch(/do not retry this command/i);
    expect(rows).not.toMatch(/before retrying|retry only|try again|then retry|retry if/i);
    expect(rows).not.toMatch(/--publish|to ask GitHub for a draft pull request/i);
    expect(failed.record.nextStage).toMatch(/do not retry this command/i);
    expect(failed.record.nextStage).not.toMatch(
      /before retrying|retry only|try again|then retry|retry if/i,
    );
  });

  it('does not report a pushed branch as nothing when only the pull request failed', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const fake = fakeRemote({ pullFails: true });

    const failed = await runPrStage(
      { runId: fixture.record.runId, publish: true },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote: fake.remote },
    );

    // The branch was created before the pull request failed, so the failure is not
    // "nothing happened" — it is exactly the state a person has to inspect.
    expect(fake.pushes).toHaveLength(1);
    expect(fake.pulls).toHaveLength(1);
    expect(failed.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(failed.publicationFailure).toMatch(/scripted pull failure/);
    expect(rowsOf(failed.checks)).toMatch(/inspect the branch and any pull request/i);
    expect(rowsOf(failed.checks)).not.toMatch(/--publish|to ask GitHub for a draft pull request/i);
    // The row declines to offer a send; it may not claim the stage ships no command that
    // asks the remote at all, because `mergesutra pr <run-id> --publish` is one, and a
    // person who reads that claim would stop looking for the answer that is in GitHub.
    expect(rowsOf(failed.checks)).toMatch(/this row offers no next command/i);
    expect(rowsOf(failed.checks)).not.toMatch(/no command that asks the remote/i);
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.publications[0]?.result).toBeNull();
    expect(saved.publications[0]?.approval).not.toBeNull();
  });

  it('does not turn a programming error into a publication failure screen', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    const remote: PublicationRemote = {
      async pushBranch() {
        throw new TypeError('a bug, not a refusal');
      },
      async createPullRequest() {
        throw new TypeError('a bug, not a refusal');
      },
    };

    await expect(
      runPrStage(
        { runId: fixture.record.runId, publish: true },
        { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW, remote },
      ),
    ).rejects.toThrow(/a bug, not a refusal/);
    // The approval was filed before the attempt; the bug did not overwrite it.
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_APPROVED_LOCAL');
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(shown.digest);
    expect(saved.publications[0]?.result).toBeNull();
  });

  it('keeps the pack it bound the approval to, rather than re-rendering it', async () => {
    const fixture = await proposedRun(tempDirs);
    const before = await readFile(path.join(fixture.packDir, 'report.md'), 'utf8');

    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(await readFile(path.join(fixture.packDir, 'report.md'), 'utf8')).toBe(before);
    expect(await readPackIdentity(fixture.runsRoot, fixture.record.runId)).toBe(
      fixture.packIdentity,
    );
  });

  it('honours the approval already on file without being told the digest again', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    // A later reading of the same run, with no flag: neither the proposal nor the
    // approval may go stale because Stage 10 filed them.
    const again = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => new Date() },
    );

    expect(again.candidate).toEqual(shown.candidate);
    expect(again.digest).toBe(shown.digest);
    expect(again.decision?.status).toBe('MATCHED');
    expect(again.outcome).toBe('PR_APPROVED_LOCAL');
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.publications).toHaveLength(1);
    // The time on the yes is the one the human gave, not this run's clock.
    expect(saved.publications[0]?.approval?.approvedAt).toBe(PR_NOW.toISOString());
  });

  it('refuses an approval that names another page, and files no yes on top of it', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    if (!shown.candidate) throw new Error('the run was proposed and filed no candidate');
    const other = publicationDigestOf({
      ...shown.candidate,
      prTitle: 'A title nobody was shown',
    });

    const fake = fakeRemote();
    const stale = await runPrStage(
      { runId: fixture.record.runId, approve: other, publish: true },
      {
        store: fixture.store,
        runsRoot: fixture.runsRoot,
        now: () => PR_NOW,
        remote: fake.remote,
      },
    );

    expect(stale.decision?.status).toBe('STALE');
    expect(fake.pushes).toEqual([]);
    expect(fake.pulls).toEqual([]);
    expect(stale.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(rowsOf(stale.checks)).toMatch(/different candidate/i);
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(filed(saved.publications)).toEqual([{ candidate: shown.candidate, approval: null }]);
  });

  it('files a second proposal when the evidence a reviewer can open has changed', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: first.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    // Somebody re-renders the pack with one more caveat on it. The page now points
    // at evidence that is not the evidence the human agreed to.
    const current = await fixture.store.load(fixture.record.runId);
    const changed = recordWith(current, {
      limitations: [...current.limitations, 'one more caveat for the reviewer'],
    });
    await fixture.store.save(changed);
    await writeEvidencePack(fixture.runsRoot, buildEvidencePack(changed));

    const again = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(again.candidate?.evidencePackIdentity).not.toBe(fixture.packIdentity);
    expect(again.digest).not.toBe(first.digest);
    expect(again.decision?.status).toBe('ABSENT');
    expect(again.outcome).toBe('PR_CANDIDATE_RECORDED');
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.publications).toHaveLength(2);
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(first.digest);
    expect(saved.publications[1]?.approval).toBeNull();
  });

  it('blocks while a finding is still waiting for a repair cycle, and points at that stage', async () => {
    const fixture = await proposedRun(tempDirs, { findings: true });

    const result = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(result.readiness.blocking.map((row) => row.id)).toContain('no-repair-candidate-left');
    expect(result.candidate).toBeNull();
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
    // The page is not the place to answer a review; the cycle that edits is.
    expect(rowsOf(result.checks)).toMatch(/mergesutra repair/);
    expect(filed((await fixture.store.load(fixture.record.runId)).publications)).toEqual([]);
  });

  it('blocks a run whose work sits on the branch it would merge into', async () => {
    const fixture = await proposedRun(tempDirs, { workOnTargetBranch: true });

    const result = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
    );

    expect(result.candidate).toBeNull();
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(rowsOf(result.checks)).toMatch(/branch/i);
    expect(filed((await fixture.store.load(fixture.record.runId)).publications)).toEqual([]);
  });

  it('refuses a run id that has no record, rather than inventing a page', async () => {
    const fixture = await proposedRun(tempDirs);
    const runsRoot = await scratchRunsRoot();

    const error = await errorFrom(() =>
      runPrStage(
        { runId: 'run-20260925T000000Z-nope000' },
        { store: fixture.store, runsRoot, now: () => PR_NOW },
      ),
    );

    expect(error.kind).toBe('not-found');
    expect(error.message).toMatch(/no run record/i);
  });

  it('reports a workspace that cannot be measured as the refusal it is, not as an empty patch', async () => {
    const fixture = await proposedRun(tempDirs);
    const gone = path.join(tmpdir(), 'mergesutra-pr-workspace-is-gone');

    const error = await errorFrom(() =>
      runPrStage(
        { runId: fixture.record.runId, repo: gone },
        { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
      ),
    );

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/patch|workspace/i);
    expect(filed((await fixture.store.load(fixture.record.runId)).publications)).toEqual([]);
  });
});

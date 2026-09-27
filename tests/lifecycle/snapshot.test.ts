import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildStatusSnapshot,
  NEXT_ACTION_REQUIREMENTS,
  STATUS_SCHEMA_VERSION,
  statusSnapshotSchema,
  type SafeNextAction,
} from '../../src/lifecycle/snapshot.js';
import { observeRun } from '../../src/lifecycle/observe.js';
import { runPrStage } from '../../src/pr/stage.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { writeEvidencePack } from '../../src/report/write.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { describePatch } from '../../src/verify/patch.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';
import { put } from '../helpers/verifyRun.js';
import { recordWith } from '../helpers/review.js';
import { REPAIRED, reviewedRun } from '../helpers/repairRun.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { cycleFor } from '../helpers/repair.js';
import { hasGit } from '../helpers/git.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * The snapshot: one document that holds what a run recorded and what is on this
 * machine, without ever letting one stand in for the other.
 *
 * This is the object every Stage 11 screen and plan is rendered from, so the
 * failures worth testing here are the ones a reader would be misled by: a stale
 * `PASS` printed without its staleness, a review that found nothing printed as
 * though nothing were wrong, a repair that changed bytes printed as "in progress",
 * a candidate printed next to an approval in a way that reads as a published pull
 * request, or an old absolute path quietly rewritten with the one just looked at.
 *
 * Nothing here renders text or decides what to run next — those are the commands'
 * — so the sections are asserted as data, against real Git workspaces and real
 * stage documents.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function snapshotOf(
  record: RunRecord,
  runsRoot: string,
  extra: { repo?: string; nextActions?: readonly SafeNextAction[] } = {},
) {
  const observation = await observeRun({
    record,
    runsRoot,
    cwd: record.local?.toplevel ?? runsRoot,
    repo: extra.repo,
  });
  return buildStatusSnapshot({
    record,
    observation,
    observedAt: NOW.toISOString(),
    nextActions: extra.nextActions ?? [],
  });
}

describe.skipIf(!AVAILABLE)('what a snapshot separates', () => {
  it('carries the recorded stage words and the observed facts as two different things', async () => {
    const fixture = await reviewedRun(tempDirs);

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);

    expect(snapshot.schemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(snapshot.runId).toBe(fixture.record.runId);
    expect(snapshot.observedAt).toBe(NOW.toISOString());
    expect(snapshot.recorded).toEqual({
      stage: fixture.record.stage,
      outcome: fixture.record.outcome,
      nextStage: fixture.record.nextStage,
      createdAt: fixture.record.createdAt,
      mergeSutraVersion: fixture.record.mergeSutraVersion,
    });
    expect(snapshot.workspace.recordedBaseSha).toBe(fixture.base);
    expect(snapshot.workspace.observedHead).toBe(fixture.base);
    // The record still says what it said before the snapshot was taken.
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved).toEqual(fixture.record);
  });

  it('keeps a moved path as an observation beside the path it moved from', async () => {
    const fixture = await reviewedRun(tempDirs);
    const elsewhere = path.join(path.dirname(fixture.workspace), 'a-newer-clone');

    const snapshot = await snapshotOf(
      recordWith(fixture.record, {
        local: { ...fixture.record.local!, toplevel: elsewhere, requestedPath: elsewhere },
      }),
      fixture.runsRoot,
    );

    expect(snapshot.workspace.path).toBe(elsewhere);
    expect(snapshot.workspace.observedHead).toBeNull();
    expect(snapshot.workspace.state).toBe('MISSING');
    expect(snapshot.recorded.stage).toBe('review');
  });

  it('names nothing as published, pushed, created or ready', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const record = await fixture.store.load(fixture.record.runId);

    const snapshot = await snapshotOf(record, fixture.runsRoot);
    const rendered = JSON.stringify(snapshot);

    expect(snapshot.publication?.remote).toBe('NOT_ATTEMPTED_BY_THIS_BUILD');
    expect(rendered).not.toMatch(/prUrl|pullRequestUrl|"published"|"pushed"|"ready"/i);
    expect(rendered).not.toMatch(/\/pull\/\d/);
  });

  it('refuses a document that carries a field this build does not define', async () => {
    const fixture = await reviewedRun(tempDirs);
    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);
    const { publication, ...rest } = snapshot;

    expect(statusSnapshotSchema.safeParse({ ...rest, verdict: 'GOOD' }).success).toBe(false);
    expect(statusSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(publication?.candidates).toBe(0);
  });
});

describe.skipIf(!AVAILABLE)('each section says what its stage may claim', () => {
  it('reports a contract by what it holds, and never by whether the work is good', async () => {
    const fixture = await reviewedRun(tempDirs);
    const contract = fixture.record.acceptanceContract;
    if (!contract) throw new Error('the fixture run derived no contract');

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);

    expect(snapshot.contract).toEqual({
      version: contract.version,
      criteria: contract.criteria.length,
      limitations: contract.limitations.length,
      untrusted: true,
    });
    expect(snapshot.plan).toEqual(expect.objectContaining({ model: expect.any(String) }));
  });

  it('prints a verification result and its staleness as two fields', async () => {
    const current = await reviewedRun(tempDirs);
    const moved = await reviewedRun(tempDirs, { movePatchAfterPlan: true });

    const stillHere = await snapshotOf(current.record, current.runsRoot);
    const expired = await snapshotOf(moved.record, moved.runsRoot);

    expect(stillHere.verification).toEqual(
      expect.objectContaining({
        result: 'PASS',
        planRevision: current.record.verification?.planRevision,
        patchIdentity: current.identityA,
        state: 'CURRENT',
      }),
    );
    // §10: the pass is not erased and the expiry is not hidden beside it.
    expect(expired.verification?.result).toBe('PASS');
    expect(expired.verification?.state).toBe('STALE');
    // The receipt still names the bytes it was gathered against — this run's own,
    // not the other fixture's, which is what makes the expiry a comparison rather
    // than a guess.
    expect(expired.verification?.patchIdentity).toBe(moved.identityA);
  });

  it('counts the evidence a criterion earned instead of summing it into a score', async () => {
    const fixture = await reviewedRun(tempDirs);
    const evidence = fixture.record.evidence;
    if (!evidence) throw new Error('the fixture run gathered no evidence');

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);

    expect(snapshot.evidence).toEqual({
      total: evidence.criteria.length,
      verified: evidence.criteria.filter((c) => c.sufficiency === 'VERIFIED').length,
      partial: evidence.criteria.filter((c) => c.sufficiency === 'PARTIALLY_VERIFIED').length,
      unverified: evidence.criteria.filter((c) => c.sufficiency === 'NOT_VERIFIED').length,
      failed: evidence.criteria.filter((c) => c.sufficiency === 'FAILED').length,
      blocked: evidence.criteria.filter((c) => c.sufficiency === 'BLOCKED').length,
      needsAHuman: evidence.criteria.filter((c) => c.sufficiency === 'MANUAL_REVIEW_REQUIRED')
        .length,
      contributionReady: false,
      state: 'CURRENT',
    });
  });

  it('records that a review found nothing without recording that it found no defect', async () => {
    const fixture = await reviewedRun(tempDirs, { findings: false });

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);
    const rendered = JSON.stringify(snapshot.review);

    expect(snapshot.review).toEqual(
      expect.objectContaining({
        findings: expect.objectContaining({ total: 0 }),
        routedToRepair: false,
        reviewedPatchIdentity: fixture.identityA,
        state: 'CURRENT',
      }),
    );
    expect(rendered).not.toMatch(/no defects|is clean|looks good|approved/i);
  });

  it('says a finding is waiting for a repair without saying the repair was agreed', async () => {
    const fixture = await reviewedRun(tempDirs);

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);

    // The reviewer's prose is deliberately absent from this section; a status page
    // that quoted it would put a model's words next to a tool's counts where a
    // reader cannot tell them apart. What the review may say about *routing* is
    // MergeSutra's own disposition, and that is what the resume plan acts on.
    expect(snapshot.review).toEqual(
      expect.objectContaining({
        findings: { total: 1, bySeverity: { BLOCKER: 0, HIGH: 1, MEDIUM: 0, LOW: 0 } },
        routedToRepair: true,
        escalatedToHuman: false,
      }),
    );
  });

  it('shows a repair as two patches and a scope, never as a phase of work', async () => {
    const fixture = await reviewedRun(tempDirs);
    const before = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    await put(fixture.workspace, 'src/parse.ts', REPAIRED);
    const after = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const execution = cycleFor({
      plan: fixture.plan,
      patch: before,
      patchAfter: after,
      implementation: fixture.record.implementation!,
      createdAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });

    const snapshot = await snapshotOf(
      recordWith(fixture.record, {
        repairExecutions: [...fixture.record.repairExecutions, execution],
      }),
      fixture.runsRoot,
    );
    const rendered = JSON.stringify(snapshot.repair);

    expect(snapshot.repair?.executions).toEqual([
      {
        reviewCycle: execution.reviewCycle,
        repairCycle: execution.repairCycle,
        planDigest: execution.planDigest,
        patchBeforeIdentity: before.identity,
        patchAfterIdentity: after.identity,
        scope: execution.scope.outcome,
        verificationRequired: true,
      },
    ]);
    expect(snapshot.repair?.plan).not.toBeNull();
    expect(snapshot.repair?.planState).toBe('STALE');
    expect(snapshot.patch).toEqual({
      recorded: after.identity,
      current: after.identity,
      status: 'CURRENT',
    });
    expect(rendered).not.toMatch(/in progress|underway|incomplete/i);
  });

  it('keeps a proposed page, a human’s yes and a remote publication three apart', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const unapproved = await snapshotOf(
      await fixture.store.load(fixture.record.runId),
      fixture.runsRoot,
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const approved = await snapshotOf(
      await fixture.store.load(fixture.record.runId),
      fixture.runsRoot,
    );
    const candidate = (await fixture.store.load(fixture.record.runId)).publications.at(
      -1,
    )?.candidate;
    if (!candidate) throw new Error('Stage 10 filed no candidate');

    expect(unapproved.publication).toEqual(
      expect.objectContaining({
        candidates: 1,
        approval: null,
        approvalState: 'ABSENT',
        state: 'CURRENT',
      }),
    );
    expect(unapproved.publication?.latest).toEqual({
      prTitle: candidate.prTitle,
      targetBranch: candidate.targetBranch,
      proposedBranch: candidate.proposedBranch,
      patchIdentity: candidate.patchIdentity,
      evidencePackIdentity: candidate.evidencePackIdentity,
      closesIssue: candidate.closesIssue,
      digest: publicationDigestOf(candidate),
    });
    expect(approved.publication?.approvalState).toBe('CURRENT');
    expect(approved.publication?.approval?.action).toBe('CREATE_PULL_REQUEST');
    expect(approved.publication?.remote).toBe('NOT_ATTEMPTED_BY_THIS_BUILD');
  });

  it('reports the pack on disk as regenerable evidence, not as a stage result', async () => {
    const reviewed = await reviewedRun(tempDirs);
    const packaged = await proposedRun(tempDirs);

    const nothing = await snapshotOf(reviewed.record, reviewed.runsRoot);
    const written = await snapshotOf(packaged.record, packaged.runsRoot);

    expect(nothing.report).toEqual({ packOnDisk: null, state: 'ABSENT', regenerable: true });
    expect(written.report).toEqual({
      packOnDisk: packaged.packIdentity,
      state: 'ABSENT',
      regenerable: true,
    });
  });

  it('says which loop bounds are already spent, beside the ones it was given', async () => {
    const fixture = await reviewedRun(tempDirs);
    const implementation = fixture.record.implementation!;

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);

    expect(snapshot.implementation).toEqual(
      expect.objectContaining({
        status: implementation.status,
        termination: implementation.termination.kind,
        model: implementation.model,
        steps: implementation.summary.steps,
        verified: false,
        untrusted: true,
        budget: {
          stepsUsed: implementation.summary.steps,
          stepsLeft: implementation.limits.maxSteps - implementation.summary.steps,
          writesUsed: implementation.summary.writes,
          writesLeft: implementation.limits.maxWrites - implementation.summary.writes,
          commandsUsed: implementation.summary.commands,
          commandsLeft: implementation.limits.maxCommands - implementation.summary.commands,
        },
      }),
    );
  });
});

describe.skipIf(!AVAILABLE)('the parts a reader acts on', () => {
  it('blocks on the facts no command can clear by being run', async () => {
    const fixture = await reviewedRun(tempDirs);
    const gone = path.join(path.dirname(fixture.workspace), 'deleted-by-somebody');

    const blocked = await snapshotOf(
      recordWith(fixture.record, {
        local: { ...fixture.record.local!, toplevel: gone, requestedPath: gone },
      }),
      fixture.runsRoot,
    );
    const fine = await snapshotOf(fixture.record, fixture.runsRoot);

    expect(blocked.blockers).toEqual([blocked.workspace.detail]);
    expect(blocked.workspace.state).toBe('MISSING');
    expect(fine.blockers).toEqual([]);
  });

  it('warns in the graph’s own words about everything that expired', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const measured = await describePatch({
      workspace: fixture.workspace,
      baseSha: fixture.base,
    });

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);

    expect(snapshot.patch).toEqual({
      recorded: fixture.identityA,
      current: measured.identity,
      status: 'STALE',
    });
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    for (const row of snapshot.warnings) {
      expect(row.state).not.toBe('CURRENT');
      expect(row.reason).toContain(fixture.identityA.slice(0, 12));
    }
  });

  it('hands back the next actions it was given, in the order they were derived', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const actions: SafeNextAction[] = [
      { command: 'verify', reason: 'the patch moved', requires: ['EXECUTION_CONSENT'] },
      { command: 'report', reason: 'the pack can be re-rendered', requires: ['LOCAL_ONLY'] },
    ];

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot, {
      nextActions: actions,
    });

    expect(snapshot.safeNextActions).toEqual(actions);
    expect([...NEXT_ACTION_REQUIREMENTS].sort()).toEqual(
      ['EXECUTION_CONSENT', 'HUMAN_APPROVAL', 'LOCAL_ONLY', 'MODEL', 'REPOSITORY_COMMAND'].sort(),
    );
  });

  it('describes an early run as a run that has not reached anything', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const record = recordWith(prepared.record, {
      plan: undefined,
    });
    const runsRoot = await scratch('mergesutra-snapshot-runs-');

    const snapshot = await snapshotOf(record, runsRoot);

    expect(snapshot.workspace.state).toBe('NOT_CREATED');
    expect(snapshot.implementation).toBeNull();
    expect(snapshot.verification).toBeNull();
    expect(snapshot.review).toBeNull();
    expect(snapshot.repair).toBeNull();
    expect(snapshot.publication).toBeNull();
    expect(snapshot.patch).toEqual({ recorded: null, current: null, status: 'ABSENT' });
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
    for (const row of snapshot.lifecycle.rows) {
      expect(row.state, row.artifact).toBe('ABSENT');
    }
  });

  it('round-trips through JSON without gaining or losing a claim', async () => {
    const fixture = await reviewedRun(tempDirs);
    const runsRoot = await scratch('mergesutra-snapshot-runs-');
    await writeEvidencePack(fixture.runsRoot, buildEvidencePack(fixture.record));

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);
    const revived = statusSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));

    expect(revived).toEqual(snapshot);
    expect(revived.report.packOnDisk).not.toBeNull();
    expect(runsRoot).not.toBe(fixture.runsRoot);
  });
});

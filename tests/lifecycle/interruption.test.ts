import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { runRepairStage } from '../../src/repair/stage.js';
import { runReportStage } from '../../src/cli/report.js';
import { formatStatus } from '../../src/cli/status.js';
import { createRenderer } from '../../src/cli/render.js';
import { runReviewStage } from '../../src/review/stage.js';
import { runStatusStage } from '../../src/lifecycle/status.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import { runPrStage } from '../../src/pr/stage.js';
import { describePatch } from '../../src/verify/patch.js';
import {
  digestOfWorkspaceFile,
  digestOf,
  implementHarness,
  writeAction,
  WORKSPACE_FILES,
} from '../helpers/implement.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { REPAIRED, repairedAnswers, parserOf, reviewedRun } from '../helpers/repairRun.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { cleanUp, hasGit, implementedRun, NOW } from '../helpers/verifyRun.js';
import type { LifecycleArtifact } from '../../src/lifecycle/staleness.js';
import type { StatusSnapshot } from '../../src/lifecycle/snapshot.js';
import type { Runner } from '../../src/core/runner.js';
import type { RunRecord } from '../../src/state/run-record.js';
import type { RunStore } from '../../src/state/run-store.js';

/**
 * §51: a run interrupted at every place it can be interrupted, and what a person is
 * told about it afterwards.
 *
 * Stage 11 exists for the moment after a crash, so its real test is not "does
 * `status` print a snapshot" — Stage 11's own files prove that — but whether the
 * snapshot is *true* for a workspace stopped mid-transition. §51 names the places a
 * run can be stopped, because they are where the stages have hands: before a byte is
 * written, after one is, partway through a gate round, on the way to a reviewer,
 * after a repair's edit, after an edit whose record was never filed, during the
 * re-verification, during a pack write, while a page is assembled, and while an
 * approval is saved.
 *
 * Each case runs the real stage with a real dependency taken away underneath it — a
 * model that stops answering, a gate process that dies, a disk that will not accept
 * the file — and then asks the shipped status service, over the bytes that are
 * actually there. Two sentences have to hold, and each case ends by stating them in
 * whatever words the state allows: the snapshot agrees with the workspace, and
 * nothing that was green *before* the interruption is offered as though it still were.
 * Where a case can also compare the stored record before and after the reading, it
 * does, because "reading tells the truth" is only worth anything if reading is also
 * harmless.
 *
 * The second sentence is the one worth the file. A stale verification is not merely
 * out of date; it is a green receipt about bytes that no longer exist, and every
 * shortcut this product could take — "the gates passed, so propose the page" — starts
 * by reading one as current.
 *
 * The last case is not one of §51's ten but the boundary they all lead to: a run
 * whose workspace is simply gone. It belongs here because §35 forbids recovery from
 * answering that with a rebuild, so the only honest thing left is to say nothing is
 * safe to run.
 *
 * Every repository here is real Git on a real filesystem, because a simulated patch
 * identity would make "the digests disagree" a fixture accident rather than a finding.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

// Building these runs costs two or three real Git processes per case, and Stage 9R's
// fixture runs Stage 7 twice on top of that. The budget is raised for cost, not for
// contention: no assertion below is widened, and a stage that truly hung would still
// fail. Compare `tests/repair/stage.test.ts`, which raises it for the same reason.
vi.setConfig({ testTimeout: 150_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

/** Where a run lives, in the three coordinates the status service asks for. */
interface Where {
  readonly store: RunStore;
  readonly cwd: string;
  readonly runsRoot: string;
  readonly record: RunRecord;
}

/** The screen a person would be shown, taken through the shipped service. */
async function truth(where: Where, extra: { run?: Runner } = {}): Promise<StatusSnapshot> {
  const { snapshot } = await runStatusStage(
    { runId: where.record.runId },
    {
      store: where.store,
      cwd: where.cwd,
      runsRoot: where.runsRoot,
      now: () => new Date('2026-09-26T09:00:00.000Z'),
      ...(extra.run ? { run: extra.run } : {}),
    },
  );
  return snapshot;
}

/** The graph's row for one artifact, keyed off the closed vocabulary the snapshot holds. */
function stateOf(snapshot: StatusSnapshot, artifact: LifecycleArtifact): string | undefined {
  return snapshot.lifecycle.states[artifact];
}

function offered(snapshot: StatusSnapshot): string[] {
  return snapshot.safeNextActions.map((action) => action.command);
}

/**
 * What is on disk for this run, serialised.
 *
 * Compared before and after a status read, because "reading tells the truth" is only
 * worth anything if reading is also harmless.
 */
async function stored(where: Where): Promise<string> {
  return JSON.stringify(await where.store.load(where.record.runId));
}

async function fileOf(dir: string, relative: string): Promise<string> {
  return readFile(path.join(dir, relative), 'utf8');
}

/** A gate runner that answers every command until the named one, then dies. */
function gateRunnerThatDies(at: number): {
  readonly calls: string[];
  readonly runFor: () => Runner;
} {
  const calls: string[] = [];
  return {
    calls,
    runFor: () => async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (calls.length === at) throw new Error('the gate process died halfway through');
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

describe.skipIf(!AVAILABLE)('an interrupted run, read back', () => {
  it('stopped before the first write is reported as having written nothing', async () => {
    // The loop asks the model for a turn, gets a write action, and the writer is what
    // would touch the workspace. Killing the model before the first answer means the
    // stage has *started* and achieved nothing — which is a different thing from a run
    // that never began, and the record has to say which.
    const harness = await implementHarness(tempDirs, []);

    const result = await harness.implement();

    const where: Where = {
      store: harness.store,
      cwd: harness.root,
      runsRoot: harness.root,
      record: harness.record,
    };
    // The bytes the fixture planted, unchanged: the loop died on its first question.
    expect(await fileOf(harness.workspacePath, 'src/parse.ts')).toBe(
      WORKSPACE_FILES['src/parse.ts'],
    );
    expect(result.implementation.summary.writes).toBe(0);
    expect(result.implementation.status).not.toBe('COMPLETED_BY_MODEL');

    const snapshot = await truth(where, { run: harness.deps.run });
    // What the loop managed to say about itself: one step spent, no write, and the
    // termination is the model's silence rather than a verdict on the issue.
    expect(snapshot.implementation?.termination).toBe('MODEL_UNAVAILABLE');
    expect(snapshot.implementation?.writes).toBe(0);
    expect(snapshot.implementation?.budget.stepsUsed).toBe(1);
    expect(stateOf(snapshot, 'verification')).toBe('ABSENT');
    expect(stateOf(snapshot, 'evidence')).toBe('ABSENT');
    // This harness scripts git rather than running it, so the observer cannot vouch
    // for the recorded base and the screen carries a blocker — and a blocked run is
    // offered nothing at all, which is the honest shape for an interruption whose
    // workspace cannot be identified. The real-git versions of both halves of that
    // claim are the repair cases below, where the bytes move in a live worktree.
    expect(snapshot.blockers.length).toBeGreaterThan(0);
    expect(offered(snapshot)).toEqual([]);
  });

  it('stopped after the first write keeps the bytes and spends the step', async () => {
    // This is the case a rollback tempts: there is a changed file on disk and no
    // completed loop. Recovery's answer is that the bytes stay — they are the run's
    // work, and Stage 11 owns no authority to discard them — while the *counters* say
    // how much of the budget the interruption used.
    const harness = await implementHarness(tempDirs, [
      writeAction(
        'src/parse.ts',
        'export const parseDate = (i: string) => new Date(i);\n',
        [],
        digestOfWorkspaceFile('src/parse.ts'),
      ),
    ]);

    const result = await harness.implement();

    expect(await fileOf(harness.workspacePath, 'src/parse.ts')).toContain('export const parseDate');
    expect(result.implementation.summary.writes).toBeGreaterThan(0);

    const where: Where = {
      store: harness.store,
      cwd: harness.root,
      runsRoot: harness.root,
      record: harness.record,
    };
    const snapshot = await truth(where, { run: harness.deps.run });
    expect(snapshot.implementation).not.toBeNull();
    expect(snapshot.implementation?.writes).toBe(result.implementation.summary.writes);
    // A step spent is a step spent: the budget the status screen reports already
    // carries the interruption's cost, so a resumed loop inherits it rather than
    // getting the whole allowance back.
    expect(snapshot.implementation?.budget.stepsUsed).toBeGreaterThan(0);
    expect(offered(snapshot)).not.toContain('pr');
  });

  it('stops in the middle of a gate round at the gate that died, not at the ones that passed', async () => {
    // The first command really ran and really returned. If a round cut off in the
    // second could be read as a verification, the run would be green on the strength
    // of part of a plan — which is the "older green evidence" §51 forbids, and it is
    // forbidden here rather than at a boundary a person has to notice.
    const fixture = await implementedRun(tempDirs);
    const learning = await runVerifyStage(
      { runId: fixture.source.runId },
      { store: fixture.prepared.store, cwd: fixture.repoDir, now: () => new Date() },
    );
    const repoGateIds = learning.plan.gates
      .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
      .map((gate) => gate.id);
    expect(repoGateIds.length).toBeGreaterThan(1);

    const dying = gateRunnerThatDies(2);
    const stage = await runVerifyStage(
      { runId: fixture.source.runId, allow: repoGateIds },
      {
        store: fixture.prepared.store,
        cwd: fixture.repoDir,
        now: () => new Date(),
        runFor: dying.runFor,
      },
    );

    // A process that dies is a receipt, not a shorter list. The engine was asked for
    // six gates and reports on six, so the one that never came back is visible by
    // name — and `exitCode: null` with `termination: NOT_EXECUTED` is the engine's
    // own way of refusing to record a status for a command that returned none.
    const measured = stage.run.gates.filter((gate) => gate.receipt.result === 'PASS');
    expect(dying.calls).toHaveLength(stage.run.gates.length);
    expect(measured).toHaveLength(stage.run.gates.length - 1);
    const [died] = stage.run.gates.filter((gate) => gate.receipt.result !== 'PASS');
    expect(died?.receipt.termination).toBe('NOT_EXECUTED');
    expect(died?.receipt.exitCode).toBeNull();
    expect(died?.receipt.stderrSummary).toContain('died halfway through');
    // The round's verdict is the honest aggregate: not the pass the first commands
    // earned, and not a failure either, because nothing was shown to be wrong.
    expect(stage.run.result).toBe('INCONCLUSIVE');
    expect(stage.record.outcome).toBe('VERIFICATION_INCONCLUSIVE');

    const where: Where = {
      store: fixture.prepared.store,
      cwd: fixture.repoDir,
      runsRoot: fixture.prepared.root,
      record: stage.record,
    };
    const snapshot = await truth(where);
    expect(snapshot.verification?.result).toBe('INCONCLUSIVE');
    expect(snapshot.evidence?.verified).toBeLessThan(snapshot.evidence?.total ?? 1);
    expect(snapshot.evidence?.contributionReady).toBe(false);
    expect(offered(snapshot)).not.toContain('pr');
    // The row beside that verdict says CURRENT, and it should: the round *is* about
    // these bytes — it simply did not reach a verdict on them. Staleness and failure
    // are measured separately on purpose, because "the receipts are about the wrong
    // code" and "the receipts are about this code but incomplete" call for different
    // actions from a person. What the screen must not do is let the current row stand
    // alone: the contribution it could support is the one the next line denies.
    expect(stateOf(snapshot, 'verification')).toBe('CURRENT');
  });

  it('stopped on the way to a reviewer leaves the patch and the receipts it was reviewing', async () => {
    // A review that never got an answer must not become a review with a verdict, and
    // must not disturb the verification the reviewer was reading. The bytes are the
    // same bytes; the review is simply absent.
    const fixture = await implementedRun(tempDirs);
    const learning = await runVerifyStage(
      { runId: fixture.source.runId },
      { store: fixture.prepared.store, cwd: fixture.repoDir, now: () => new Date() },
    );
    const repoGateIds = learning.plan.gates
      .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
      .map((gate) => gate.id);
    const verified = await runVerifyStage(
      { runId: fixture.source.runId, allow: repoGateIds },
      { store: fixture.prepared.store, cwd: fixture.repoDir, now: () => new Date() },
    );

    const before = await stored({
      store: fixture.prepared.store,
      cwd: fixture.repoDir,
      runsRoot: fixture.prepared.root,
      record: fixture.source,
    });
    const error = await expect(
      runReviewStage(
        { runId: fixture.source.runId },
        {
          store: fixture.prepared.store,
          cwd: fixture.repoDir,
          now: () => new Date(),
          client: scriptedClient([]),
        },
      ),
    ).rejects.toThrow(/ran out of answers/);
    expect(error).toBeDefined();

    const where: Where = {
      store: fixture.prepared.store,
      cwd: fixture.repoDir,
      runsRoot: fixture.prepared.root,
      record: verified.record,
    };
    const snapshot = await truth(where);
    expect(stateOf(snapshot, 'review')).toBe('ABSENT');
    expect(snapshot.review).toBeNull();
    // The verification is about these bytes and still stands — the interruption was
    // in the next stage, not in this one. That is the difference between an honest
    // stale graph and a blunt one that marks everything after a failure unknown.
    expect(stateOf(snapshot, 'verification')).toBe('CURRENT');
    expect(offered(snapshot)).toContain('review');
    expect(offered(snapshot)).not.toContain('pr');
    // And the failed request filed nothing at all: the record is the one verify left.
    expect(await stored(where)).toBe(before);
  });

  it('stopped with a repair edit landed keeps the edit and re-measures it', async () => {
    // §22 calls this the dangerous case, and the danger has two halves. The tempting
    // recovery is to put the workspace back — `git checkout -- .`, "clean slate" —
    // which would destroy the only artifact the interrupted cycle produced. The
    // tempting report is the opposite: keep the green receipts that describe the
    // bytes before the edit and let them carry a page. Neither happens: the bytes
    // stay, and the round the stage runs is against those bytes.
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);
    const client = scriptedClient([
      writeAction('src/parse.ts', REPAIRED, [...fixture.criteria], digestOf(current)),
    ]);

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client,
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    // The model was asked for a second turn and never gave one, so the loop ends
    // without a finish claim — and the cycle is still recorded, because what carries
    // a repair is the measurement that follows it, not the model's say-so.
    expect(result.executed).toBe(true);
    const execution = result.execution;
    expect(execution?.patchBeforeIdentity).toBe(fixture.identityA);
    expect(execution?.patchAfterIdentity).not.toBe(fixture.identityA);
    expect(execution?.patchChanged).toBe(true);
    expect(execution?.verificationRequired).toBe(true);
    expect(execution?.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');

    const moved = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const where: Where = {
      store: fixture.store,
      cwd: fixture.workspace,
      runsRoot: fixture.runsRoot,
      record: result.record,
    };
    const snapshot = await truth(where);
    // Every receipt the run now claims belongs to the repaired bytes, so the older
    // green round cannot be read as current — it is not even in the record any more.
    expect(snapshot.verification?.patchIdentity).toBe(moved.identity);
    expect(stateOf(snapshot, 'verification')).toBe('CURRENT');
    // And the review is what expired: it was written about the patch before the edit,
    // so the screen sends the run back to a reviewer rather than forwards to a page.
    expect(stateOf(snapshot, 'review')).toBe('STALE');
    expect(offered(snapshot)).toContain('review');
    expect(offered(snapshot)).not.toContain('pr');
  });

  it('stopped between a repair’s edit and its record still reports the moved patch', async () => {
    // Stage 9R's scope guard is the stage's own account of what a cycle touched. This
    // case loses that account: the edit reaches the workspace, the re-verification
    // runs, and the write of the record fails, so nothing on disk says the patch
    // moved. Recovery has to notice anyway — and it can, because it asks Git rather
    // than the stages. The verification in the record is about bytes that no longer
    // exist, and saying so is the whole job.
    const fixture = await reviewedRun(tempDirs);
    const where = whereOf(fixture.store, fixture.workspace, fixture.runsRoot, fixture.record);
    const before = await stored(where);
    const client = scriptedClient(
      repairedAnswers(await parserOf(fixture.workspace), fixture.criteria),
    );

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: storeThatCannotSave(fixture.store),
        client,
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    // The stage says what it could not do, in the fields a caller reads, rather than
    // pretending the filing happened: no record file, and no pack either, since a
    // page rendered from a record that was never written would be the one document
    // that disagreed with the disk.
    expect(result.executed).toBe(true);
    expect(result.recordFile).toBeNull();
    expect(result.packDir).toBeNull();
    expect(result.packError).toMatch(/the disk went away/);
    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);

    // Nothing was filed: no execution, no re-verification, no scope verdict — the
    // stored record is byte for byte the one the review left.
    expect(await stored(where)).toBe(before);
    const unharmed = await fixture.store.load(fixture.record.runId);
    expect(unharmed.repairExecutions).toEqual([]);

    const snapshot = await truth(where);
    expect(snapshot.repair?.executions).toEqual([]);
    expect(stateOf(snapshot, 'verification')).toBe('STALE');
    expect(stateOf(snapshot, 'review')).toBe('STALE');
    expect(offered(snapshot)).not.toContain('pr');
    expect(offered(snapshot)).toContain('verify');
  });

  it('stopped in the repair’s own re-verification leaves the edit waiting for gates', async () => {
    // A repair that could not be measured is not a repair that passed. The gates are
    // processes, and processes die; what must not die is the fact that the patch
    // moved, which is why the cycle's edit and the incomplete round are both filed.
    const fixture = await reviewedRun(tempDirs);
    const client = scriptedClient(
      repairedAnswers(await parserOf(fixture.workspace), fixture.criteria),
    );
    const dying = gateRunnerThatDies(1);

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client,
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: dying.runFor,
      },
    );

    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    expect(dying.calls.length).toBeGreaterThan(0);
    expect(result.record.verification?.result).not.toBe('PASSED');

    const where: Where = {
      store: fixture.store,
      cwd: fixture.workspace,
      runsRoot: fixture.runsRoot,
      record: result.record,
    };
    const snapshot = await truth(where);
    expect(snapshot.verification?.result).toBe('INCONCLUSIVE');
    expect(snapshot.evidence?.verified).toBeLessThan(snapshot.evidence?.total ?? 1);
    expect(offered(snapshot)).not.toContain('pr');
    // `verify` is *not* re-offered, and that is the router reading the right field:
    // the round is about these bytes, so it is not stale, and Stage 11's verbs are
    // gated on the graph's rows rather than on a mood. What makes the screen honest
    // is the line printed above the suggestions — the round's verdict and how many
    // gates carried it — so the claim that a reader is told is checked on the
    // rendered page rather than argued from a field.
    expect(offered(snapshot)).not.toContain('verify');
    expect(offered(snapshot)).toEqual(['review']);
    const page = formatStatus(snapshot, createRenderer({ color: false }));
    expect(page).toContain('INCONCLUSIVE');
    expect(page).toContain('1 INCONCLUSIVE');
  });

  it('stopped on the way to a pack leaves the evidence and asks for the pack again', async () => {
    // Stage 8 is the least dangerous interruption in the list, and the snapshot is
    // where that shows: the pack is rendered from the record, so losing the write
    // loses a command rather than work — but only if the screen says `pack missing`
    // instead of quietly reporting the identity the record once carried.
    const fixture = await reviewedRun(tempDirs);
    const blocked = path.join(fixture.runsRoot, '.mergesutra');
    await writeFile(blocked, 'a file standing where a directory has to go\n');
    const before = await stored(
      whereOf(fixture.store, fixture.workspace, fixture.runsRoot, fixture.record),
    );

    await expect(
      runReportStage(
        { runId: fixture.record.runId },
        { store: fixture.store, cwd: fixture.runsRoot },
      ),
    ).rejects.toThrow(/ENOTDIR|not a directory/);

    const where: Where = {
      store: fixture.store,
      cwd: fixture.workspace,
      runsRoot: fixture.runsRoot,
      record: fixture.record,
    };
    const snapshot = await truth(where);
    expect(snapshot.report?.packOnDisk).toBeNull();
    expect(stateOf(snapshot, 'pack')).toBe('ABSENT');
    expect(snapshot.report?.regenerable).toBe(true);
    expect(offered(snapshot)).toContain('report');
    expect(offered(snapshot)).not.toContain('pr');
    // The failure is the filesystem's, not the run's: Stage 8 files nothing until the
    // pack exists, so the record still says what the round that earned it said.
    expect(await stored(where)).toBe(before);
  });

  it('stopped with half a pack on disk proposes no page', async () => {
    // The pack is written file by file, so a crash can leave two of the three. A
    // reviewer who opens that directory gets a page that does not name every command
    // that ran, and a page assembled from it would bind an approval to evidence
    // nobody can read in full — so `readPackIdentity` answers `null`, which is the
    // engine's way of saying "there is no pack here" rather than "a smaller pack".
    const fixture = await proposedRun(tempDirs);
    await rm(path.join(fixture.packDir, 'commands.jsonl'));

    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );

    expect(shown.candidate).toBeNull();
    expect(shown.digest).toBeNull();
    expect(shown.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(shown.readiness.blocking.map((row) => row.id)).toContain('pack-current');

    const where: Where = {
      store: fixture.store,
      cwd: fixture.workspace,
      runsRoot: fixture.runsRoot,
      record: shown.record,
    };
    const snapshot = await truth(where);
    expect(snapshot.report?.packOnDisk).toBeNull();
    expect(offered(snapshot)).not.toContain('pr');
  });

  it('stopped while saving a publication approval does not have that approval', async () => {
    // This is the case with the highest cost if it is got wrong: a person typed the
    // digest, the stage matched it, and the write of the record died. The screen for
    // that moment can say the page is assembled and it can say the approval is
    // wanted — what it cannot do is leave the impression that the yes was kept,
    // because the next reader of the record would then act on a permission nobody
    // granted.
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    if (!shown.digest) throw new Error('the fixture run produced no page to approve');
    const before = await stored(
      whereOf(fixture.store, fixture.workspace, fixture.runsRoot, fixture.record),
    );

    const approved = await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest },
      {
        store: storeThatCannotSave(fixture.store),
        runsRoot: fixture.runsRoot,
        now: () => NOW,
      },
    );

    // The stage did recognise the yes, and did fail to file it — both on the screen.
    expect(approved.decision?.allowed).toBe(true);
    expect(approved.recordFile).toBeNull();
    expect(approved.checks.map((check) => check.detail).join(' ')).toMatch(/not filed/i);
    // Nothing reached disk: the on-disk record is the one the first call left.
    expect(
      await stored(whereOf(fixture.store, fixture.workspace, fixture.runsRoot, fixture.record)),
    ).toBe(before);

    const where: Where = {
      store: fixture.store,
      cwd: fixture.workspace,
      runsRoot: fixture.runsRoot,
      record: await fixture.store.load(fixture.record.runId),
    };
    const snapshot = await truth(where);
    expect(snapshot.publication?.approval).toBeNull();
    expect(stateOf(snapshot, 'publicationApproval')).toBe('ABSENT');
    // So the same action is still what is outstanding — with the same digest, and
    // still labelled as needing a human.
    const actions = snapshot.safeNextActions.filter((action) => action.command === 'pr');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.requires).toEqual(['HUMAN_APPROVAL']);
  });

  it('stopped by losing its workspace is offered nothing, however current its record reads', async () => {
    // The last of §51's points is the one a screen is most tempted to fudge, because
    // the record here is in perfect order: gates passed on a patch, a reviewer read
    // it, a pack was rendered, a page was assembled. Only the directory is gone. And
    // every one of those claims is about bytes nobody can now check — so the honest
    // answer is not the tidy one, and the run is offered no command at all until a
    // person says where the work lives.
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    if (!shown.digest) throw new Error('the fixture run produced no page to lose');
    const before = await stored(
      whereOf(fixture.store, fixture.workspace, fixture.runsRoot, fixture.record),
    );
    // Nothing in this build rebuilds a workspace, and nothing in it should: §35
    // forbids recovery reaching for `worktree add` or a fresh checkout. So the
    // directory simply goes, the way a killed process on a removed mount would.
    await rm(fixture.workspace, { recursive: true, force: true });

    const where = whereOf(
      fixture.store,
      fixture.workspace,
      fixture.runsRoot,
      await fixture.store.load(fixture.record.runId),
    );
    const snapshot = await truth(where);
    expect(snapshot.workspace.state).toBe('MISSING');
    expect(snapshot.blockers.join(' ')).toMatch(/workspace|directory/i);
    // The record on disk still claims a passed round on a patch it can name, and the
    // screen answers `UNMEASURABLE` — not `CURRENT` because a document says so, and
    // not `STALE` either, because staleness would be a claim about a comparison this
    // machine cannot make. Nothing is then offered, and that is the double guard
    // holding: the rows are unmeasurable, and a blocker suppresses the list whatever
    // the rows say.
    expect(stateOf(snapshot, 'verification')).toBe('UNMEASURABLE');
    expect(offered(snapshot)).toEqual([]);
    expect(await stored(where)).toBe(before);
  });
});

/** The three coordinates a record is read at, named once so a case cannot mix roots. */
function whereOf(store: RunStore, cwd: string, runsRoot: string, record: RunRecord): Where {
  return { store, cwd, runsRoot, record };
}

/**
 * A store that reads fine and cannot write.
 *
 * The interruption has to land after the stage's work and inside its filing, and a
 * real crash at that instant is not reproducible on a schedule. What is reproducible
 * is the state it leaves: the workspace edited, the record not written. So the seam
 * is the store, and only its `save` — `load` still answers from disk, which is what
 * makes the assertions below claims about persistence rather than about a stub.
 */
function storeThatCannotSave(store: RunStore): RunStore {
  return {
    ...store,
    async save(): Promise<string> {
      throw new Error('the disk went away mid-write');
    },
  };
}

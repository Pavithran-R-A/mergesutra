import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { runRepairStage } from '../../src/repair/stage.js';
import { scopeDigest } from '../../src/verify/consent.js';
import { describePatch } from '../../src/verify/patch.js';
import { recordWith } from '../helpers/review.js';
import { frozenPlan } from '../helpers/repair.js';
import {
  GRANTED_AT,
  parserOf,
  REPAIRED,
  repairedAnswers,
  reviewedRun,
} from '../helpers/repairRun.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { checkAction, digestOf, finishAction, writeAction } from '../helpers/implement.js';
import { consentFor, planOf, plannedGate, SUCCEEDED } from '../helpers/verification.js';
import { cleanUp, errorFrom, hasGit, implementedRun, put, NOW } from '../helpers/verifyRun.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * Stage 9R's transition: an approved plan turns into an edit, and the edit turns
 * into a re-measurement of everything the run used to claim.
 *
 * This is the only module in `src/repair` with hands, and it has none of its own —
 * it calls Stage 6's loop, Stage 7's round and Stage 8's renderer. What it owns is
 * the *order*, which is where every shortcut this product could take lives: start
 * the loop before the yes arrives, verify the old bytes and call them current, keep
 * the green receipts that describe a patch that has gone, freeze a second cycle off
 * the first cycle's model answer. So most of what is below is about what did *not*
 * happen — no file written without a digest-matched approval, no gate round skipped
 * after a patch moved, no model asked again because a gate failed.
 *
 * Everything measured here comes from a real Git workspace: the patch identity in a
 * repair execution is the digest of bytes git reported, the cycle's edit is a file
 * read back off disk, and the re-verification's receipts come from processes that
 * were really started. Stage 7 runs twice in the fixture, because the second round
 * is the one a human consented to and a hand-written consent would let "the yes
 * still covers this round" pass without anyone deriving the digest the way the
 * product does. Only the model is scripted, for the standing reason.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/**
 * Every fixture below builds a real repository and puts Stage 7 through it twice,
 * then the cycle itself runs Stage 6's loop, a third round and a pack — all against
 * Git processes on a Windows filesystem, where the suite's 30-second budget is
 * routinely reached by honest work rather than by a hang (the slowest test here
 * measures ~44s when it passes). The budget is raised for this file so that
 * contention and cost cannot be reported as a broken transition; not one assertion
 * in the file is softened, and a stage that truly hung would still fail at 90s.
 */
vi.setConfig({ testTimeout: 90_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function claimText(record: RunRecord): string {
  return (record.evidence?.claims ?? []).map((claim) => `${claim.source}: ${claim.text}`).join(' ');
}

describe.skipIf(!AVAILABLE)('runRepairStage', () => {
  it('refuses a run that has no frozen plan, before asking a model anything', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const client = scriptedClient([]);

    const error = await errorFrom(() =>
      runRepairStage(
        { runId: source.runId, approvePlan: 'a'.repeat(64) },
        { store: prepared.store, client, now: () => NOW },
      ),
    );

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/no repair plan|nothing to repair/i);
    expect(error.remediation).toMatch(/review/i);
    expect(client.calls).toHaveLength(0);
  });

  it('shows the plan and touches nothing until a human approves its digest', async () => {
    const fixture = await reviewedRun(tempDirs);
    const client = scriptedClient([]);
    const before = fixture.gateCalls.length;

    const result = await runRepairStage(
      { runId: fixture.record.runId },
      { store: fixture.store, client, now: () => NOW },
    );

    expect(result.executed).toBe(false);
    expect(result.decision.status).toBe('ABSENT');
    expect(result.decision.reason).toContain(
      `mergesutra repair ${fixture.record.runId} --approve-plan ${repairPlanDigest(fixture.plan)}`,
    );
    expect(client.calls).toHaveLength(0);
    expect(fixture.gateCalls).toHaveLength(before);
    expect(result.record.repairExecutions).toEqual([]);
    // Nothing reached disk for anybody else to read, in the store or in the pack.
    await expect(
      readFile(path.join(fixture.runsRoot, fixture.record.runId, 'report.md'), 'utf8'),
    ).rejects.toThrow();
    expect((await fixture.store.load(fixture.record.runId)).repairExecutions).toEqual([]);
    const stillThere = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    expect(stillThere.identity).toBe(fixture.identityA);
  });

  it('will not spend a yes given to some other plan, and says which digest it needs', async () => {
    const fixture = await reviewedRun(tempDirs);
    const elsewhere = frozenPlan({
      runId: fixture.record.runId,
      criteria: fixture.criteria,
      patchIdentity: fixture.identityA,
      expectedChecks: fixture.repoGateIds,
      expectedFiles: ['test/parse.test.ts'],
      createdAt: NOW.toISOString(),
    });

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(elsewhere) },
      { store: fixture.store, client: scriptedClient([]), now: () => NOW },
    );

    expect(result.executed).toBe(false);
    expect(result.decision.status).toBe('STALE');
    expect(result.decision.expectedDigest).toBe(repairPlanDigest(fixture.plan));
    expect(result.decision.givenDigest).toBe(repairPlanDigest(elsewhere));
    expect(await parserOf(fixture.workspace)).toContain('if (!i) throw new Error("empty");');
  });

  it('refuses to execute a plan frozen against bytes that are gone, without editing them', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const client = scriptedClient([]);

    const error = await errorFrom(() =>
      runRepairStage(
        { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
        { store: fixture.store, client, now: () => NOW },
      ),
    );

    expect(error.message).toMatch(/moved|no longer|frozen against/i);
    // Refused before a model is asked: a plan about absent bytes has nothing to do.
    expect(client.calls).toHaveLength(0);
    expect(await readFile(path.join(fixture.workspace, 'notes.md'), 'utf8')).toMatch(
      /a person wrote/,
    );
  });

  it('runs the cycle through Stage 6’s loop and files what it did', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);
    const client = scriptedClient(repairedAnswers(current, fixture.criteria));

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

    expect(result.executed).toBe(true);
    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    const execution = result.execution;
    expect(execution).not.toBeNull();
    expect(execution?.planDigest).toBe(repairPlanDigest(fixture.plan));
    expect(execution?.patchBeforeIdentity).toBe(fixture.identityA);
    expect(execution?.patchChanged).toBe(true);
    expect(execution?.verificationRequired).toBe(true);
    expect(execution?.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');
    // The measured digest of the bytes on disk, not a digest of what was intended.
    const nowPatch = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    expect(execution?.patchAfterIdentity).toBe(nowPatch.identity);
    // Stage 6's record stays where it was; the cycle's loop record is filed inside
    // the execution, so one cannot be mistaken for the other.
    expect(result.record.implementation).toEqual(fixture.record.implementation);
    expect(result.record.repairExecutions).toHaveLength(1);
    expect(result.record.repairExecutions[0]?.implementation.finishClaim?.summary).toMatch(
      /Rewrote the guard/,
    );
  });

  it('re-verifies the bytes it left, through the same round `verify` runs', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);
    const before = fixture.gateCalls.length;
    const previous = fixture.record.verificationPlan;
    if (!previous) throw new Error('the fixture must have verified');

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client: scriptedClient(repairedAnswers(current, fixture.criteria)),
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    const round = result.round;
    expect(round).not.toBeNull();
    expect(fixture.gateCalls.length).toBeGreaterThan(before);
    expect(round?.plan.revision).toBe(previous.revision + 1);
    expect(round?.plan.patchIdentity).not.toBe(previous.patchIdentity);
    expect(result.record.verificationPlan?.patchIdentity).toBe(round?.plan.patchIdentity);
    expect(result.record.verification?.patchPrecondition.status).toBe('MATCHED');
    expect(result.record.outcome).toBe('REPAIR_APPLIED');
  });

  it('reuses the yes the human already gave, because the gates are the same commands', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client: scriptedClient(repairedAnswers(current, fixture.criteria)),
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    // No `--allow` was typed for this round, and no repository gate was left unexecuted.
    expect(result.record.executionConsent).toEqual(fixture.record.executionConsent);
    // The timestamp is the discriminating part: a consent this command minted for
    // itself would carry the hour the repair ran, not the human's earlier yes.
    expect(result.record.executionConsent?.grantedAt).toBe(GRANTED_AT);
    for (const id of fixture.repoGateIds) {
      const gate = result.round?.run.gates.find((entry) => entry.gateId === id);
      expect(gate?.receipt.termination).not.toBe('NOT_EXECUTED');
    }
    expect(result.round?.run.result).not.toBe('BLOCKED');
  });

  it('stops where a yes is missing and names the consent it needs, rather than repairing again', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);
    // A consent that was never about these commands: the same shape, another digest.
    const elsewhere = planOf([plannedGate({ id: 'VG-900', argv: ['npm', 'run', 'elsewhere'] })]);
    const stored = recordWith(fixture.record, {
      executionConsent: consentFor(elsewhere, ['VG-900']),
    });
    await fixture.store.save(stored);
    const client = scriptedClient(repairedAnswers(current, fixture.criteria));
    const before = fixture.gateCalls.length;

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

    expect(result.round?.run.result).toBe('BLOCKED');
    expect(scopeDigest(result.round?.plan ?? elsewhere)).not.toBe(
      stored.executionConsent?.planDigest,
    );
    expect(result.record.outcome).toBe('REPAIR_NEEDS_HUMAN');
    // No stranger's command ran. MergeSutra wrote the `diff --check` gate itself, so
    // that one process is not the thing this consent exists to bound; every gate
    // that came from the repository's own files is left unstarted.
    const started = fixture.gateCalls.slice(before);
    expect(started.filter((line) => line !== 'git diff --check')).toEqual([]);
    // One cycle only: a blocked verification is not a licence to edit again.
    expect(client.calls).toHaveLength(2);
    expect(result.record.repairExecutions).toHaveLength(1);
    const told = [...result.record.limitations, result.record.nextStage].join(' ');
    expect(told).toMatch(/--allow/);
    expect(told).toMatch(/consent/i);
    // And the edit it did make is kept, not reverted.
    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
  });

  it('does not repair again because the gates failed', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);
    const client = scriptedClient(repairedAnswers(current, fixture.criteria));

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client,
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        // Every repository command fails, including the ones before the edit.
        runFor: () => async () => ({ code: 1, stdout: 'failing\n', stderr: '' }),
      },
    );

    expect(result.round?.run.result).toBe('FAIL');
    expect(result.record.outcome).toBe('REPAIR_NEEDS_HUMAN');
    expect(result.record.repairExecutions).toHaveLength(1);
    // The model was asked the two turns it was scripted for and no more.
    expect(client.calls).toHaveLength(2);
    // §18: a criterion is only as green as a receipt says, whatever was claimed.
    for (const entry of result.record.evidence?.criteria ?? []) {
      expect(entry.status).not.toBe('PASS');
    }
    expect(claimText(result.record)).toMatch(/Rewrote the guard/);
  });

  it('routes a repaired, re-verified run to a second review of the new bytes', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client: scriptedClient(repairedAnswers(current, fixture.criteria)),
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    expect(result.record.nextStage).toMatch(/REVIEW/);
    expect(result.record.nextStage).toMatch(/again|second|new|cycle 2/i);
    // The old review is carried as the record that a review happened, never
    // re-labelled as a reading of the bytes that exist now.
    expect(result.record.review).toEqual(fixture.record.review);
    expect(result.record.review?.reviewedPatchIdentity).toBe(fixture.identityA);
    expect(result.record.review?.reviewedPatchIdentity).not.toBe(
      result.record.verificationPlan?.patchIdentity,
    );
  });

  it('files a cycle a plan-brief refusal left no trace of, and does not re-verify it', async () => {
    const fixture = await reviewedRun(tempDirs);
    const before = fixture.gateCalls.length;
    const client = scriptedClient([
      writeAction('src/scratch.ts', 'export const touched = 1;\n', [...fixture.criteria]),
      finishAction('Added the file the finding asked for.', [...fixture.criteria]),
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

    expect(result.execution?.scope.outcome).toBe('REPAIR_LEFT_NO_TRACE');
    expect(result.execution?.patchChanged).toBe(false);
    // Prevention, not detection, is what stopped it: the write never reached disk.
    await expect(
      readFile(path.join(fixture.workspace, 'src/scratch.ts'), 'utf8'),
    ).rejects.toThrow();
    expect(result.round).toBeNull();
    expect(fixture.gateCalls).toHaveLength(before);
    expect(result.record.outcome).toBe('REPAIR_NEEDS_HUMAN');
    // Nothing moved, so the receipts still describe the workspace, and the record
    // must not claim that they stopped describing it.
    expect(result.record.verification).toEqual(fixture.record.verification);
    expect(result.record.limitations.join(' ')).not.toMatch(/stale/i);
  });

  /**
   * The one way a cycle can still reach outside its plan: a command.
   *
   * A `WRITE_FILE` to a file the brief does not name is refused before the writer
   * is asked, which the test above covers. A process is a different matter — the
   * tool policy lets `node scripts/scaffold.mjs` start because running the
   * repository's own generator is what a verification stage exists to do, and it
   * has no idea which files that generator will write. So this is the case the
   * scope guard was built for: prevention stopped what it could see, and here the
   * two patch measurements disagree with the plan.
   *
   * What a guard cannot do is decide. The unplanned file stays exactly where the
   * command put it, the repair's own edit is not reverted, and the gates are not
   * run over bytes nobody approved — re-verifying them would turn an unapproved
   * edit into evidence for it.
   */
  it('files what a command wrote outside the plan, and touches neither it nor the edit', async () => {
    const fixture = await reviewedRun(tempDirs, {
      // Seeded before the patch is measured, so it is part of the reviewed patch
      // and of the bytes the plan was frozen against — and still not a file the
      // plan names, which is the whole question.
      seedFiles: {
        'scripts/scaffold.mjs':
          "import { writeFileSync } from 'node:fs';\n" +
          "writeFileSync('src/generated.ts', 'export const scaffold = 1;\\n');\n",
      },
    });
    const current = await parserOf(fixture.workspace);
    const roundsBefore = fixture.gateCalls.length;
    const client = scriptedClient([
      writeAction('src/parse.ts', REPAIRED, [...fixture.criteria], digestOf(current)),
      checkAction(['node', 'scripts/scaffold.mjs'], 'run the repository’s generator'),
      finishAction('Rewrote the guard and regenerated the scaffolding.', [...fixture.criteria]),
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

    // The command really ran, in the real workspace, and really wrote the file.
    expect(await readFile(path.join(fixture.workspace, 'src/generated.ts'), 'utf8')).toContain(
      'export const scaffold = 1;',
    );
    expect(result.execution?.scope.outcome).toBe('OUTSIDE_PLANNED_SCOPE');
    expect(result.execution?.scope.unexpectedFiles).toEqual(['src/generated.ts']);
    expect(
      result.execution?.scope.files.find((file) => file.path === 'src/generated.ts'),
    ).toMatchObject({ delta: 'ADDED_BY_REPAIR', classification: 'UNEXPECTED' });
    // The planned half of the cycle is still a fact about this patch.
    expect(result.execution?.patchChanged).toBe(true);
    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);

    // §10 in the only direction it can go here: no round over unapproved bytes.
    expect(result.round).toBeNull();
    expect(fixture.gateCalls).toHaveLength(roundsBefore);
    expect(result.record.verification).toEqual(fixture.record.verification);
    expect(result.record.outcome).toBe('REPAIR_NEEDS_HUMAN');
    // One cycle, whatever the guard found — §17.
    expect(client.calls).toHaveLength(3);
    expect(result.record.repairExecutions).toHaveLength(1);

    const told = [result.record.nextStage, ...result.record.limitations].join(' ');
    expect(told).toMatch(/NEEDS_HUMAN_REVIEW/);
    expect(told).toMatch(/src\/generated\.ts/);
    // §13: it says so in as many words, and the workspace agrees.
    expect(told).toMatch(/not reverted|nothing was reverted|Nothing was reverted/i);
    await expect(
      readFile(path.join(fixture.workspace, 'scripts/scaffold.mjs'), 'utf8'),
    ).resolves.toContain('writeFileSync');

    const scopeRow = result.record.checks.find((check) => check.name === 'Repair scope');
    expect(scopeRow?.status).toBe('WARN');
    expect(scopeRow?.detail).toMatch(/src\/generated\.ts/);
    expect(scopeRow?.detail).toMatch(/did not name|outside/i);
    const noRoundRow = result.record.checks.find((check) => check.name === 'Re-verification');
    expect(noRoundRow?.status).toBe('WARN');
    expect(noRoundRow?.detail).toMatch(/not run/);
  });

  it('regenerates the pack the cycle made stale, in the run’s own directory', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client: scriptedClient(repairedAnswers(current, fixture.criteria)),
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    expect(result.recordFile).not.toBeNull();
    expect(result.packError).toBeNull();
    const pack = await readFile(
      path.join(fixture.runsRoot, fixture.record.runId, 'report.md'),
      'utf8',
    );
    expect(result.packDir).toContain(fixture.record.runId);
    expect(pack).toContain(result.execution?.patchAfterIdentity ?? '');
    expect(pack).toContain('## Repair cycles');
    // The rows above the cycle line were re-measured, so the line has to say so.
    const cycleLine = pack.split('\n').find((line) => line.includes('Repair cycle 1')) ?? '';
    expect(cycleLine).toContain(result.round?.plan.patchIdentity ?? '');
    expect(cycleLine).not.toMatch(/stale/i);
  });

  it('stops asking for a third review when the budget has only two in it', async () => {
    const fixture = await reviewedRun(tempDirs, { reviewCycle: 2 });
    const current = await parserOf(fixture.workspace);

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client: scriptedClient(repairedAnswers(current, fixture.criteria)),
        now: () => NOW,
        runsRoot: fixture.runsRoot,
        runFor: fixture.runFor,
      },
    );

    // A spent review budget does not un-move the bytes: the re-verification is
    // still owed, and it is still the only thing that can call them measured.
    expect(result.round).not.toBeNull();
    expect(result.record.outcome).toBe('REPAIR_APPLIED');
    expect(result.record.nextStage).toMatch(/NEEDS_HUMAN_REVIEW|a person|human/i);
    expect(result.record.nextStage).not.toMatch(/again|cycle 2|second review/i);
  });

  it('keeps the record and says so when the pack cannot be written', async () => {
    const fixture = await reviewedRun(tempDirs);
    const current = await parserOf(fixture.workspace);
    const runsRoot = path.join(fixture.runsRoot, 'not-a-directory');
    // A file where a directory has to be, so the pack write fails on purpose.
    await put(fixture.runsRoot, 'not-a-directory', 'not a directory at all\n');

    const result = await runRepairStage(
      { runId: fixture.record.runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: fixture.store,
        client: scriptedClient(repairedAnswers(current, fixture.criteria)),
        now: () => NOW,
        runsRoot,
        runFor: fixture.runFor,
      },
    );

    expect(result.record.repairExecutions).toHaveLength(1);
    expect(result.recordFile).not.toBeNull();
    expect(result.packDir).toBeNull();
    expect(result.packError).not.toBeNull();
    expect(result.checks.map((check) => check.name)).toContain('Evidence pack');
  });

  describe('a cycle someone interrupts', () => {
    /**
     * Cancellation, §26, at the three points a person can actually press Ctrl+C.
     *
     * An interrupt is not a verdict. It says nothing about whether the finding was
     * right or the edit good, and a record that read it that way would be the one
     * lie a cancelled run can tell. So each row below holds to three things: the
     * disk is left as the interrupt found it — no rollback, because reverting a
     * person's workspace is not MergeSutra's to do — the cycle is filed as the fact
     * that it ran and stopped, and no gate result, receipt or route toward a pull
     * request survives a round that did not finish.
     *
     * What differs between them is where the stopping lands, and that is the part
     * worth pinning: before the model is asked anything, after the edit is on disk
     * but before the gates are, and after some gates have already produced
     * receipts. The last is the dangerous one, because half a round looks like a
     * round to anything that only checks whether one ran.
     */
    it('stops before asking the model anything, and files a cycle that edited nothing', async () => {
      const fixture = await reviewedRun(tempDirs);
      const controller = new AbortController();
      controller.abort();
      const client = scriptedClient(repairedAnswers('unused', fixture.criteria));
      const roundsBefore = fixture.gateCalls.length;

      const result = await runRepairStage(
        {
          runId: fixture.record.runId,
          approvePlan: repairPlanDigest(fixture.plan),
          signal: controller.signal,
        },
        {
          store: fixture.store,
          client,
          now: () => NOW,
          runsRoot: fixture.runsRoot,
          runFor: fixture.runFor,
        },
      );

      expect(client.calls).toHaveLength(0);
      expect(await parserOf(fixture.workspace)).not.toBe(REPAIRED);
      expect(result.execution?.implementation.status).toBe('CANCELLED');
      expect(result.execution?.patchChanged).toBe(false);
      expect(result.execution?.scope.outcome).toBe('REPAIR_LEFT_NO_TRACE');
      // Nothing moved, so no round is owed — and none is invented.
      expect(result.round).toBeNull();
      expect(fixture.gateCalls).toHaveLength(roundsBefore);
      expect(result.record.outcome).toBe('REPAIR_BLOCKED');
      // The receipts still describe these bytes, so the record keeps them.
      expect(result.record.verification).toEqual(fixture.record.verification);
      expect(result.record.limitations.join(' ')).not.toMatch(/stale/i);
      expect(result.record.nextStage).toMatch(/NEEDS_HUMAN_REVIEW/);
    });

    it('keeps an edit that landed and runs no gate when the interrupt arrives first', async () => {
      const fixture = await reviewedRun(tempDirs);
      const current = await parserOf(fixture.workspace);
      const roundsBefore = fixture.gateCalls.length;
      const controller = new AbortController();
      const client = scriptedClient(repairedAnswers(current, fixture.criteria));
      const asked = client.complete.bind(client);
      let turn = 0;
      client.complete = async (request) => {
        turn += 1;
        // The person stops the run while its final turn is outstanding.
        if (turn === 2) controller.abort();
        return asked(request);
      };

      const result = await runRepairStage(
        {
          runId: fixture.record.runId,
          approvePlan: repairPlanDigest(fixture.plan),
          signal: controller.signal,
        },
        {
          store: fixture.store,
          client,
          now: () => NOW,
          runsRoot: fixture.runsRoot,
          runFor: fixture.runFor,
        },
      );

      // Cancellation is not a rollback: the file the cycle wrote stays written.
      expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
      expect(result.execution?.patchChanged).toBe(true);
      expect(result.execution?.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');
      // The round is owed, so one is filed — and it names itself as cancelled
      // rather than quietly reporting the gates it never started.
      expect(result.round).not.toBeNull();
      expect(result.round?.run.result).toBe('CANCELLED');
      expect(fixture.gateCalls).toHaveLength(roundsBefore);
      expect(result.record.outcome).toBe('REPAIR_NEEDS_HUMAN');
      expect(result.record.nextStage).toMatch(/VERIFY/);
      expect(result.record.nextStage).toMatch(/CANCELLED/);
    });

    it('files a half-run round as cancelled and keeps no verdict out of it', async () => {
      const fixture = await reviewedRun(tempDirs);
      const current = await parserOf(fixture.workspace);
      const controller = new AbortController();
      const started: string[] = [];
      const runFor = () => async () => {
        started.push('gate');
        // Stopped partway: the first gate answered, the rest were never started.
        controller.abort();
        return SUCCEEDED;
      };

      const result = await runRepairStage(
        {
          runId: fixture.record.runId,
          approvePlan: repairPlanDigest(fixture.plan),
          signal: controller.signal,
        },
        {
          store: fixture.store,
          client: scriptedClient(repairedAnswers(current, fixture.criteria)),
          now: () => NOW,
          runsRoot: fixture.runsRoot,
          runFor,
        },
      );

      expect(started.length).toBe(1);
      expect(result.round?.run.result).toBe('CANCELLED');
      expect(result.record.outcome).toBe('REPAIR_NEEDS_HUMAN');
      expect(result.record.nextStage).toMatch(/CANCELLED/);

      // Half a round is not a verification, and the record says so at the top: the
      // verdict is the cancellation, and nothing is contribution-ready.
      const evidence = result.record.evidence;
      expect(evidence?.verification).toBe('CANCELLED');
      expect(evidence?.contributionReady).toBe(false);

      // What the cancellation leaves is not equality between the criteria. The one
      // gate that was reached really ran and really passed, so its criterion keeps a
      // PASS built on that receipt — evidence from receipts is the whole rule, and
      // pretending a command that ran said nothing would be its own lie. Every
      // criterion the stop arrived at first is INCONCLUSIVE, and says why.
      const rows = evidence?.criteria ?? [];
      expect(rows.filter((row) => row.status === 'PASS')).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'INCONCLUSIVE')).toHaveLength(3);
      expect(JSON.stringify(rows)).toContain('cancelled before the gate was reached');

      // The cycle's own row carries the warning a reader acts on.
      const row = result.checks.find((check) => check.name === 'Re-verification');
      expect(row?.status).toBe('WARN');
      expect(row?.detail).toMatch(/verdict CANCELLED/);
      expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    });
  });
});

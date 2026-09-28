import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { parseRepairPlan } from '../../src/repair/plan.js';
import { createFileRunStore } from '../../src/state/run-store.js';
import type { RepairStageDeps } from '../../src/repair/stage.js';
import { describePatch } from '../../src/verify/patch.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { finishAction } from '../helpers/implement.js';
import { recordWith } from '../helpers/review.js';
import { reviewedRun, type RepairFixture } from '../helpers/repairRun.js';
import { cleanUp, hasGit, NOW } from '../helpers/verifyRun.js';

/**
 * What bounds a repair when a person starts the command over (§14, S12-19).
 *
 * Stage 9R hands every entry a fresh loop budget (`resolveRepairLimits()` at
 * `src/repair/stage.ts:213`), so the thing that keeps a run from editing itself
 * to death across restarts is the *cycle count* — and a count is only a bound if
 * it survives the process that computed it. Within one call the stage never
 * loops (`src/repair/stage.ts:57`), and the review side refuses to freeze a plan
 * past the ceiling; neither of those says anything about the second time a human
 * types `mergesutra repair` with the same digest.
 *
 * So this file drives the command twice over one run, reading the record back
 * from a real file store between the entries — bytes on a disk, not an object
 * kept alive in memory — and asks the two questions §14 poses: can an approved
 * plan be spent more than once, and can a fresh process be talked into a cycle
 * the record has already used up? A scripted answer that writes nothing is what
 * makes the first question audible: a cycle that left no trace keeps the patch at
 * the identity the plan was frozen against, so every staleness guard still calls
 * that plan current. The third case asks where that refusal stops, because a run
 * that could only ever be repaired once would not be a repair cycle at all.
 */

vi.setConfig({ testTimeout: 180_000 });

const AVAILABLE = await hasGit();
const made: string[] = [];

afterEach(async () => {
  await cleanUp(made);
  made.length = 0;
});

/**
 * A reviewed run whose record lives on disk, beside — not inside — the repository.
 *
 * `reviewedRun` builds its record in a memory store whose `load` hands back the
 * very object that was saved. That is the one shape this test must not use: an
 * entry could see the previous entry's work without anything ever being filed, and
 * "the record carried the count" would be unproven. Every entry below therefore
 * goes through `createFileRunStore`, which serialises on save and re-parses on
 * load, which is what a restarted process does.
 */
async function aRunOnDisk(): Promise<{
  fixture: RepairFixture;
  store: ReturnType<typeof createFileRunStore>;
}> {
  const fixture = await reviewedRun(made);
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-restart-store-'));
  made.push(root);
  const store = createFileRunStore(root);
  await store.save(fixture.record);
  return { fixture, store };
}

function depsFor(
  fixture: RepairFixture,
  store: ReturnType<typeof createFileRunStore>,
  client: RepairStageDeps['client'],
): Partial<RepairStageDeps> {
  return {
    store,
    client,
    now: () => NOW,
    runsRoot: fixture.runsRoot,
    runFor: fixture.runFor,
    cwd: fixture.workspace,
  };
}

/** The command exactly as a person types it: the run, the workspace, the digest they read. */
async function typeRepair(
  fixture: RepairFixture,
  deps: Partial<RepairStageDeps>,
  digest: string,
): Promise<{ code: number; text: string; error: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    [
      'node',
      'mergesutra',
      'repair',
      fixture.record.runId,
      '--repo',
      fixture.workspace,
      '--approve-plan',
      digest,
    ],
    { write: (line) => out.push(line), writeErr: (line) => err.push(line), env: {}, repair: deps },
  );
  return { code, text: out.join('\n'), error: err.join('\n') };
}

/** One cycle that answers without writing, so the patch stays where the plan found it. */
const NO_TRACE = (criteria: readonly string[]) => [
  finishAction('Read it over; nothing here is what the finding asked to change.', criteria),
];

describe.skipIf(!AVAILABLE)('a repair entered again', () => {
  it('spends an approved plan once, and refuses to spend it a second time', async () => {
    const { fixture, store } = await aRunOnDisk();
    const client = scriptedClient(NO_TRACE(fixture.criteria));
    const digest = repairPlanDigest(fixture.plan);

    const first = await typeRepair(fixture, depsFor(fixture, store, client), digest);
    expect(first.code).toBe(EXIT.INCONCLUSIVE);
    expect(client.calls).toHaveLength(1);
    const afterFirst = await store.load(fixture.record.runId);
    expect(afterFirst.repairExecutions).toHaveLength(1);
    // The cycle left no trace, which is why every later guard still calls this plan current.
    expect(afterFirst.repairExecutions[0]?.patchChanged).toBe(false);
    expect(
      (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })).identity,
    ).toBe(fixture.identityA);

    // The same human, in a new process, typing the same yes at the same command.
    const second = await typeRepair(fixture, depsFor(fixture, store, client), digest);
    expect(second.error + second.text).toMatch(/already|spent|carried out|one cycle/i);
    // Refused before a model was asked: a plan that has been carried out has no work left.
    expect(client.calls).toHaveLength(1);
    const afterSecond = await store.load(fixture.record.runId);
    expect(afterSecond.repairExecutions).toHaveLength(1);
    expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst));
    // And the screen must not invite the very yes it is about to refuse.
    expect(second.error + second.text).not.toMatch(/--approve-plan/);
    expect(second.code).not.toBe(EXIT.OK);
    expect(
      (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })).identity,
    ).toBe(fixture.identityA);
  });

  it('refuses a plan re-worded over a cycle this run has already spent, under a fresh digest', async () => {
    // The digest is the scope, and a scope can be re-worded. What a bound has to sit on
    // is the cycle, not on a document a person can rewrite in the persisted record: this
    // plan keeps the cycles, the files, the criteria and the gates of the one that was
    // spent, and differs only in the sentence describing the ask — which is enough to
    // move its digest, because the ask is part of what a human says yes to.
    const { fixture, store } = await aRunOnDisk();
    const client = scriptedClient(NO_TRACE(fixture.criteria));
    const first = await typeRepair(
      fixture,
      depsFor(fixture, store, client),
      repairPlanDigest(fixture.plan),
    );
    expect(first.code).toBe(EXIT.INCONCLUSIVE);

    const reworded = parseRepairPlan({
      ...fixture.plan,
      findings: fixture.plan.findings.map((finding, index) =>
        index === 0
          ? {
              ...finding,
              intendedChange: 'Give the parser the branch the criterion asks for, later.',
            }
          : finding,
      ),
    });
    expect(repairPlanDigest(reworded)).not.toBe(repairPlanDigest(fixture.plan));
    expect(reworded.reviewCycle).toBe(fixture.plan.reviewCycle);
    expect(reworded.repairCycle).toBe(fixture.plan.repairCycle);
    await store.save(recordWith(await store.load(fixture.record.runId), { repairPlan: reworded }));

    const again = await typeRepair(
      fixture,
      depsFor(fixture, store, client),
      repairPlanDigest(reworded),
    );
    expect(again.error + again.text).toMatch(/already|spent|carried out|one cycle/i);
    expect(client.calls).toHaveLength(1);
    expect((await store.load(fixture.record.runId)).repairExecutions).toHaveLength(1);
    expect(again.code).not.toBe(EXIT.OK);
  });

  it('refuses a filed cycle and nothing else: a pair the record has not filed still runs', async () => {
    // Where the line is drawn matters as much as the refusal, because the product's
    // whole point is that a run may be repaired more than once. What is refused above
    // is a cycle this run has *filed*; a plan whose cycle pair has moved on is a
    // different ask, and the only thing that authorises it is the digest a human typed
    // for it. Stage 9's review freezes both halves together, so this pair can only
    // have been written by a hand into the persisted record — which is precisely the
    // source §0 names as hostile, and precisely what a bound must not silently swallow.
    const { fixture, store } = await aRunOnDisk();
    const client = scriptedClient([...NO_TRACE(fixture.criteria), ...NO_TRACE(fixture.criteria)]);

    const first = await typeRepair(
      fixture,
      depsFor(fixture, store, client),
      repairPlanDigest(fixture.plan),
    );
    expect(first.code).toBe(EXIT.INCONCLUSIVE);

    const nextRepair = parseRepairPlan({ ...fixture.plan, repairCycle: 2 });
    await store.save(
      recordWith(await store.load(fixture.record.runId), { repairPlan: nextRepair }),
    );

    const second = await typeRepair(
      fixture,
      depsFor(fixture, store, client),
      repairPlanDigest(nextRepair),
    );
    // It ran. A refusal throws before a credential is resolved and leaves the command on
    // EXIT.ERROR, so an inconclusive cycle here is the cycle itself, not a soft no.
    expect(second.code).toBe(EXIT.INCONCLUSIVE);
    expect(client.calls).toHaveLength(2);
    const after = await store.load(fixture.record.runId);
    expect(
      after.repairExecutions.map((execution) => [execution.reviewCycle, execution.repairCycle]),
    ).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(
      (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })).identity,
    ).toBe(fixture.identityA);
  });
});

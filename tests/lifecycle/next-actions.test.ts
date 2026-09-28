import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { defaultRunner, type Runner } from '../../src/core/runner.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { parseRepairPlan } from '../../src/repair/plan.js';
import { nextActionsFor } from '../../src/lifecycle/next-actions.js';
import { runPrStage } from '../../src/pr/stage.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { writeEvidencePack } from '../../src/report/write.js';
import { cycleFor } from '../helpers/repair.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';
import { snapshotOf } from '../helpers/snapshot.js';
import { recordWith } from '../helpers/review.js';
import { reviewedRun } from '../helpers/repairRun.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { hasGit } from '../helpers/git.js';
import { describePatch } from '../../src/verify/patch.js';

/**
 * What a run may be told to do next, derived from what is actually true.
 *
 * These are routing options, not advice: each one is a command that exists, and the
 * rule for offering it is that its preconditions hold *now* — not that the run's
 * stage counter points at it. The failures worth testing are the ones that cost a
 * person time or trust: a `review` offered over receipts that describe gone bytes
 * (it would spend a model call to produce a stale document), a `pr` offered while a
 * HIGH finding waits for a repair, a `repair` offered against a plan frozen for a
 * patch that no longer exists or for a cycle this run has already carried out, a
 * suggestion worded as though somebody had already said yes, or any command
 * suggested at all when the workspace is missing and every one of them would fail
 * for the same reason.
 *
 * The other half of the contract is what is *never* offered: no cleanup, no reset,
 * no re-run of a loop whose budget belongs to `resume`, and nothing that reads as
 * publication. Those are asserted as absence, because a suggestion is the one place
 * a status screen can turn into an action.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function commandsFor(record: Awaited<ReturnType<typeof reviewedRun>>['record'], runsRoot: string) {
  return snapshotOf(record, runsRoot).then((snapshot) => nextActionsFor(snapshot));
}

function commands(actions: Awaited<ReturnType<typeof nextActionsFor>>): string[] {
  return actions.map((action) => action.command);
}

describe.skipIf(!AVAILABLE)('what a run is offered', () => {
  it('offers the stage a run with a contract has not reached', async () => {
    const prepared = await contractBackedRun(tempDirs);

    const actions = await commandsFor(prepared.record, prepared.root);

    expect(commands(actions)).toEqual(['plan']);
    expect(actions[0]?.requires).toEqual(['MODEL']);
    // The planner spends a BharatCode call, and the suggestion has to say so.
    expect(actions[0]?.reason).toMatch(/model/i);
  });

  it('offers a review only over receipts that still describe the files', async () => {
    const current = await reviewedRun(tempDirs);
    const moved = await reviewedRun(tempDirs, { movePatchAfterPlan: true });

    const fresh = await commandsFor(current.record, current.runsRoot);
    const expired = await commandsFor(moved.record, moved.runsRoot);

    // The review is current and its finding waits for a repair, so a second review
    // is not suggested over the top of it.
    expect(commands(fresh)).not.toContain('review');
    // §13: with the verification expired there is nothing a review could be true about.
    expect(commands(expired)).toEqual(['verify', 'report']);
    expect(expired.find((action) => action.command === 'verify')?.requires).toEqual([
      'EXECUTION_CONSENT',
      'REPOSITORY_COMMAND',
    ]);
  });

  it('routes a finding waiting for a repair to the repair, and never to the page', async () => {
    const fixture = await reviewedRun(tempDirs);
    // With a pack on disk, every precondition Stage 10 checks except the finding is
    // met — so if the page is still not offered, it is the finding that refused it.
    await writeEvidencePack(fixture.runsRoot, buildEvidencePack(fixture.record));

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot);
    const actions = nextActionsFor(snapshot);

    // The one Stage 10 precondition this run *does* meet, so the refusal below is
    // the finding's doing and not a missing page.
    expect(snapshot.report.packOnDisk).toEqual(expect.any(String));
    expect(snapshot.review?.routedToRepair).toBe(true);
    // And with the page already rendered, the repair is the only thing left to offer.
    expect(commands(actions)).toEqual(['repair']);
    const repair = actions.find((action) => action.command === 'repair');
    expect(repair?.requires).toEqual(['MODEL', 'HUMAN_APPROVAL']);
    // §13: an approval is a thing a human has not done yet, so the suggestion names
    // it as outstanding rather than as a step already cleared.
    expect(repair?.reason).toMatch(/not been approved|approval/i);
  });

  it('does not offer a repair against a plan frozen for bytes that are gone', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });

    const actions = await commandsFor(fixture.record, fixture.runsRoot);

    expect(commands(actions)).not.toContain('repair');
  });

  it('does not offer a repair whose approved cycle this run has already spent', async () => {
    const fixture = await reviewedRun(tempDirs);
    const patch = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const spent = cycleFor({
      plan: fixture.plan,
      patch,
      implementation: fixture.record.implementation!,
      createdAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    // A person re-words the sentence the plan carries, in the record on disk. That
    // sentence is inside the digest, so the approval the record names no longer
    // matches the plan it is quoted against — and the screen reads that as a yes
    // still owed. It is not: it is the same cycle that has already been carried out,
    // wearing a new approval.
    const reworded = parseRepairPlan({
      ...fixture.plan,
      findings: fixture.plan.findings.map((finding) => ({
        ...finding,
        intendedChange: 'Give the parser the branch the criterion asks for, later.',
      })),
    });
    expect(repairPlanDigest(reworded)).not.toBe(repairPlanDigest(fixture.plan));

    const snapshot = await snapshotOf(
      recordWith(fixture.record, { repairPlan: reworded, repairExecutions: [spent] }),
      fixture.runsRoot,
    );

    // The refusal has to be reachable for the offer to be the bug: an approval that
    // does not match the plan on record is exactly what makes this screen speak.
    expect(snapshot.lifecycle.states.repairApproval).toBe('STALE');
    expect(nextActionsFor(snapshot).map((action) => action.command)).toEqual(['report']);
  });

  it('still offers a repair frozen for a cycle this run has not spent', async () => {
    const fixture = await reviewedRun(tempDirs);
    const patch = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const spent = cycleFor({
      plan: fixture.plan,
      patch,
      implementation: fixture.record.implementation!,
      createdAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    // The same approval state as the refusal above — a plan whose digest no filed
    // execution names — and the opposite verdict, because what separates them is the
    // cycle pair. A later review can freeze a later cycle, and that cycle is still
    // owed its decision.
    const nextCycle = parseRepairPlan({
      ...fixture.plan,
      reviewCycle: 2,
      repairCycle: 2,
    });

    const snapshot = await snapshotOf(
      recordWith(fixture.record, { repairPlan: nextCycle, repairExecutions: [spent] }),
      fixture.runsRoot,
    );

    expect(snapshot.lifecycle.states.repairApproval).toBe('STALE');
    expect(snapshot.repair?.plan).toMatchObject({ reviewCycle: 2, repairCycle: 2 });
    expect(nextActionsFor(snapshot).map((action) => action.command)).toContain('repair');
  });

  it('binds a spent cycle to the whole pair, not to its review half', async () => {
    const fixture = await reviewedRun(tempDirs);
    const patch = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const spent = cycleFor({
      plan: fixture.plan,
      patch,
      implementation: fixture.record.implementation!,
      createdAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    // Stage 9's review freezes both halves of a cycle together, so a record whose
    // repair half moved on alone can only have been rewritten by a hand. It is worth
    // naming because it draws the guard's exact line: what is refused is a cycle this
    // run has *filed*, and a person who writes a cycle the run has not filed is
    // making a new decision that `mergesutra repair` will run under its own approval.
    const otherRepair = parseRepairPlan({ ...fixture.plan, repairCycle: 2 });

    const snapshot = await snapshotOf(
      recordWith(fixture.record, { repairPlan: otherRepair, repairExecutions: [spent] }),
      fixture.runsRoot,
    );

    expect(snapshot.repair?.plan).toMatchObject({ reviewCycle: 1, repairCycle: 2 });
    expect(nextActionsFor(snapshot).map((action) => action.command)).toContain('repair');
  });

  it('offers the page only once the patch is what the receipts say it is', async () => {
    const fixture = await proposedRun(tempDirs);
    const unreviewed = nextActionsFor(
      await snapshotOf(recordWith(fixture.record, { review: null }), fixture.runsRoot),
    );
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const proposed = await commandsFor(
      await fixture.store.load(fixture.record.runId),
      fixture.runsRoot,
    );

    // With the review withdrawn there is nothing to propose from, and the run is
    // sent back to the reviewer instead of forwards to the page.
    expect(commands(unreviewed)).not.toContain('pr');
    expect(commands(unreviewed)).toContain('review');
    expect(commands(proposed)).toEqual(['pr']);
    expect(proposed[0]?.requires).toEqual(['HUMAN_APPROVAL']);
    // It names the digest a person has to agree to, so the suggestion cannot be
    // read as agreement with some other page.
    expect(proposed[0]?.reason).toContain(shown.digest?.slice(0, 12));
  });

  it('offers nothing further once a human has approved the exact page', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );

    const actions = await commandsFor(
      await fixture.store.load(fixture.record.runId),
      fixture.runsRoot,
    );

    // §26: this build has no publisher, so an approved candidate is the end of the
    // road and the screen says so instead of inventing a step.
    expect(actions).toEqual([]);
  });

  it('sends a run with nothing left to fix to the page, once', async () => {
    const fixture = await reviewedRun(tempDirs, { findings: false });

    const before = await commandsFor(fixture.record, fixture.runsRoot);
    await writeEvidencePack(fixture.runsRoot, buildEvidencePack(fixture.record));
    const withPage = await commandsFor(fixture.record, fixture.runsRoot);

    // Stage 10 assembles a candidate from the pack on disk, so until `report` has
    // run there is no page for a person to approve — and no reason to send them to
    // a command that would refuse them.
    expect(commands(before)).toEqual(['report']);
    expect(commands(before)).not.toContain('pr');
    expect(commands(withPage)).toEqual(['pr']);
  });

  it('offers nothing at all when the workspace cannot be acted on', async () => {
    const fixture = await reviewedRun(tempDirs);
    const gone = path.join(path.dirname(fixture.workspace), 'deleted-by-somebody');

    const actions = await commandsFor(
      recordWith(fixture.record, {
        local: { ...fixture.record.local!, toplevel: gone, requestedPath: gone },
      }),
      fixture.runsRoot,
    );

    expect(actions).toEqual([]);
  });

  it('offers only the local work when the bytes here cannot be measured', async () => {
    const fixture = await reviewedRun(tempDirs);
    // The workspace is present and on its base; Git simply will not describe its
    // diff. That is not a blocker a human has to clear, and it is not a patch any
    // stage could quote, so the one thing left to offer is rendering.
    const refusesDiff: Runner = async (file, args) =>
      args.includes('diff')
        ? { code: 1, stdout: '', stderr: 'git says no\n', signal: null }
        : await defaultRunner(file, args);

    const snapshot = await snapshotOf(fixture.record, fixture.runsRoot, { run: refusesDiff });
    const actions = nextActionsFor(snapshot);

    expect(snapshot.workspace.state).toBe('PRESENT');
    expect(snapshot.blockers).toEqual([]);
    expect(commands(actions)).toEqual(['report']);
  });
});

describe.skipIf(!AVAILABLE)('what a run is never offered', () => {
  it('names only commands this build has, and never a way to undo work', async () => {
    const runs = [
      await reviewedRun(tempDirs),
      await reviewedRun(tempDirs, { movePatchAfterPlan: true }),
      await proposedRun(tempDirs),
    ];

    for (const fixture of runs) {
      const actions = await commandsFor(fixture.record, fixture.runsRoot);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(['plan', 'implement', 'verify', 'review', 'repair', 'report', 'pr']).toContain(
          action.command,
        );
        expect(action.requires.length).toBeGreaterThan(0);
      }
      // A suggestion is the one place a status screen becomes an action, so the
      // destructive verbs are excluded by name rather than by omission.
      const rendered = JSON.stringify(actions).toLowerCase();
      expect(rendered).not.toMatch(/reset|clean|checkout|stash|revert|delete|remove|force/);
    }
  });

  it('never suggests re-running a loop whose budget another command owns', async () => {
    const fixture = await reviewedRun(tempDirs);

    const actions = await commandsFor(fixture.record, fixture.runsRoot);

    // §19: entering a loop again needs cumulative accounting that only `resume` does.
    expect(commands(actions)).not.toContain('implement');
  });
});

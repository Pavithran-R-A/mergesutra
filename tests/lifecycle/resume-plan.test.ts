import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { runPrStage } from '../../src/pr/stage.js';
import { buildResumePlan, RESUME_ACTIONS } from '../../src/lifecycle/resume-plan.js';
import { nextActionsFor } from '../../src/lifecycle/next-actions.js';
import { runStatusStage } from '../../src/lifecycle/status.js';
import { recordWith } from '../helpers/review.js';
import { reviewedRun } from '../helpers/repairRun.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { put } from '../helpers/verifyRun.js';
import { plannedRun } from '../helpers/implement.js';
import { contractBackedRun, cleanUp, NOW } from '../helpers/plan.js';
import { hasGit } from '../helpers/git.js';
import type { ImplementationRecord } from '../../src/implement/state.js';
import type { MemoryRunStore } from '../helpers/github.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * The plan `resume` would carry out, built from a status snapshot alone.
 *
 * §15 asks for a strict, deterministic object that exists *before* anything
 * happens, and the failures this guards against are all of one kind: a recovery
 * tool deciding what to do by guessing. Each test below takes a run built by the
 * real stages, reads it the way `mergesutra status` reads it — through
 * `runStatusStage`, so the composition under test is the one a person gets — and
 * asks what the plan says. Two answers make this file worth having:
 *
 * - **Where a human's decision is what is missing.** A repair cycle, a publication
 *   approval, a gate consent: resume may name the boundary and stop at it (§17),
 *   and the plan carries a field that says so rather than a reason that hints. It
 *   must never carry a flag that reads as a decision already taken, and never a
 *   word about publishing — there is no publisher in this build (§26).
 * - **What a stopped loop owes.** A loop that ended early is not a finished one
 *   (§19): the plan re-enters it instead of routing to verification of the
 *   half-finished patch, and it reports the bound already spent rather than
 *   implying a fresh one.
 *
 * The digest is the other half of the design, and the only thing that lets a
 * preview mean something an action can be taken on later: bytes moving after the
 * preview has to change it, and a re-read of unchanged bytes must not (§34).
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

/**
 * The snapshot the status command builds, then the plan built from it.
 *
 * Going through `runStatusStage` rather than the raw snapshot helper is the point:
 * the stage is the only place a snapshot gets its next actions, so a plan derived
 * from an unsuggested snapshot would be a plan with a hole in it that no screen
 * shows. The middle assertion proves the composition is a fixed point, which is
 * what the digest test relies on two cases later.
 */
async function planFor(
  record: RunRecord,
  where: { store: MemoryRunStore; runsRoot: string },
  options: { observedAt?: Date } = {},
) {
  await where.store.save(record);
  const { snapshot } = await runStatusStage(
    { runId: record.runId },
    {
      store: where.store,
      runsRoot: where.runsRoot,
      cwd: record.local?.toplevel ?? where.runsRoot,
      now: () => options.observedAt ?? NOW,
    },
  );
  expect(snapshot.safeNextActions).toEqual(nextActionsFor(snapshot));
  return { snapshot, plan: buildResumePlan(snapshot) };
}

/** The same loop record, stopped by something other than the model finishing. */
function stoppedAs(
  record: RunRecord,
  over: Partial<Pick<ImplementationRecord, 'status' | 'termination' | 'summary'>>,
): RunRecord {
  const implementation = record.implementation;
  if (!implementation) throw new Error('the fixture run has no loop record to stop early');
  return recordWith(record, { implementation: { ...implementation, ...over } });
}

/** A loop interrupted at 3 of 12 steps, with its whole write and command budget left. */
function stoppedEarly(record: RunRecord) {
  return stoppedAs(record, {
    status: 'CANCELLED',
    termination: { kind: 'DEADLINE', detail: 'the human interrupted the loop' },
  });
}

/**
 * The same document with every object's keys written in the opposite order.
 *
 * Only the serialisation order changes, never a fact, so this is the input that
 * tells a digest over the run apart from a digest over the bytes of one particular
 * rendering of it.
 */
function reordered<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => reordered(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([key, item]) => [key, reordered(item)])) as unknown as T;
  }
  return value;
}

describe.skipIf(!AVAILABLE)('what a resume would plan', () => {
  it('plans the stage a run with a contract has not reached', async () => {
    const prepared = await contractBackedRun(tempDirs);

    const { plan } = await planFor(prepared.record, {
      store: prepared.store,
      runsRoot: prepared.root,
    });

    expect(plan.action).toBe('CREATE_PLAN');
    expect(plan.stage).toBe('plan');
    expect(plan.command).toBe('plan');
    // §18: the plan says before anything happens that this transition spends a
    // model request, and therefore needs the credential configured.
    expect(plan.requiresModel).toBe(true);
    expect(plan.requiresCredential).toBe(true);
    expect(plan.mutatesWorkspace).toBe(false);
    expect(plan.requiresExecutionConsent).toBe(false);
  });

  it('plans the implementation loop for a run that has a plan and no loop yet', async () => {
    const run = await plannedRun(tempDirs);

    const { plan } = await planFor(run.record, {
      store: run.prepared.store,
      runsRoot: run.prepared.root,
    });

    expect(plan.action).toBe('RUN_IMPLEMENTATION_LOOP');
    expect(plan.command).toBe('implement');
    expect(plan.mutatesWorkspace).toBe(true);
    expect(plan.requiresModel).toBe(true);
    expect(plan.requiresExecutionConsent).toBe(false);
  });

  it('re-enters a loop that stopped early instead of verifying its unfinished patch', async () => {
    const fixture = await reviewedRun(tempDirs);

    const { plan } = await planFor(stoppedEarly(fixture.record), {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    // §19: the loop is what was interrupted, so the loop is what continues. Routing
    // to `verify` over a patch the run's own record calls unfinished would be the
    // tool inventing a completed loop.
    expect(RESUME_ACTIONS).toContain(plan.action);
    expect(plan.action).toBe('CONTINUE_IMPLEMENTATION');
    expect(plan.command).toBe('implement');
    expect(plan.mutatesWorkspace).toBe(true);
    expect(plan.requiresModel).toBe(true);
    // The spent bound is reported, not quietly reset.
    expect(plan.reason).toMatch(/3 of 12 steps/);
    expect(plan.reason).not.toMatch(/fresh|restart|from scratch/);
  });

  it('plans no loop when its bound is what stopped it, and promises no new bound', async () => {
    const fixture = await reviewedRun(tempDirs);
    const implementation = fixture.record.implementation!;

    const exhausted = await planFor(
      stoppedAs(fixture.record, {
        status: 'CANCELLED',
        termination: { kind: 'MAX_STEPS', detail: 'the step bound was reached' },
        summary: { ...implementation.summary, steps: implementation.limits.maxSteps },
      }),
      { store: fixture.store, runsRoot: fixture.runsRoot },
    );

    expect(exhausted.plan.action).toBe('AWAIT_HUMAN');
    expect(exhausted.plan.command).toBeNull();
    expect(exhausted.plan.mutatesWorkspace).toBe(false);
    expect(exhausted.plan.requiresModel).toBe(false);
    expect(exhausted.plan.reason).toMatch(/bound|budget/i);
    // §19: a resumed loop must not read as though another twelve steps were granted.
    expect(exhausted.plan.reason).not.toMatch(/fresh|another 12|increase|reset/i);
  });

  it('sends a loop that stopped by asking for a human to a human', async () => {
    const fixture = await reviewedRun(tempDirs);

    const { plan } = await planFor(
      stoppedAs(fixture.record, {
        status: 'NEEDS_HUMAN_REVIEW',
        termination: { kind: 'MODEL_BLOCKED', detail: 'the loop said it needs a person' },
      }),
      { store: fixture.store, runsRoot: fixture.runsRoot },
    );

    // The loop's own word is the reason, and re-entering it would spend a model
    // request to ask the same question again.
    expect(plan.action).toBe('AWAIT_HUMAN');
    expect(plan.requiresModel).toBe(false);
    expect(plan.command).toBeNull();
  });

  it('plans a fresh verification of the bytes here, with no model call first', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });

    const { snapshot, plan } = await planFor(fixture.record, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    // §20 with §23: the receipts describe patch A and the workspace holds patch B,
    // so the one authoritative thing to do is measure B — without asking BharatCode.
    expect(plan.action).toBe('VERIFY_CURRENT_PATCH');
    expect(plan.command).toBe('verify');
    expect(plan.requiresModel).toBe(false);
    expect(plan.requiresCredential).toBe(false);
    expect(plan.mutatesWorkspace).toBe(true);
    expect(plan.currentPatchIdentity).toBe(snapshot.patch.current);
    expect(plan.currentPatchIdentity).not.toBe(fixture.record.verification!.patchIdentity);
    // §17: the gates are the repository's own, so consent is what is outstanding.
    expect(plan.requiresExecutionConsent).toBe(true);
  });

  it('plans a review over receipts that still describe the files', async () => {
    const fixture = await reviewedRun(tempDirs, { findings: false });

    const { plan } = await planFor(recordWith(fixture.record, { review: null }), {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    expect(plan.action).toBe('REVIEW_CURRENT_PATCH');
    expect(plan.command).toBe('review');
    expect(plan.requiresModel).toBe(true);
    // A reviewer reads the diff; nothing in this transition writes to the workspace.
    expect(plan.mutatesWorkspace).toBe(false);
    expect(plan.requiresExecutionConsent).toBe(false);
  });

  it('stops at the repair approval a human has not given', async () => {
    const fixture = await reviewedRun(tempDirs);

    const { plan } = await planFor(fixture.record, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    // §17: the finding routes to a repair and the approval is the reader's, so the
    // plan names the boundary it stops at instead of planning the cycle.
    expect(plan.action).toBe('REPAIR_PLAN_APPROVAL_REQUIRED');
    expect(plan.command).toBe('repair');
    expect(plan.stage).toBe('repair');
    expect(plan.requiresRepairApproval).toBe(true);
    expect(plan.requiresPublicationApproval).toBe(false);
    expect(plan.reason).toMatch(/has not approved|not been approved/i);
    expect(plan.reason).not.toMatch(/already approved|approval granted/);
  });

  it('plans the page rebuild when the pack a candidate points at is gone', async () => {
    const fixture = await proposedRun(tempDirs);
    await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const proposed = await fixture.store.load(fixture.record.runId);
    await rm(path.join(fixture.packDir, 'report.md'), { force: true });

    const { plan } = await planFor(proposed, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    // §32: the pack is regenerable, so losing it costs a local command and no work
    // — and a page that is not on disk is not something to send a person to approve.
    expect(plan.action).toBe('REGENERATE_EVIDENCE_PACK');
    expect(plan.command).toBe('report');
    expect(plan.requiresModel).toBe(false);
    expect(plan.requiresPublicationApproval).toBe(false);
    expect(plan.mutatesWorkspace).toBe(false);
  });

  it('plans a candidate once everything it is built from is current', async () => {
    const fixture = await proposedRun(tempDirs);

    const { plan } = await planFor(fixture.record, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    expect(plan.action).toBe('BUILD_PUBLICATION_CANDIDATE');
    expect(plan.command).toBe('pr');
    expect(plan.requiresPublicationApproval).toBe(false);
    expect(plan.requiresModel).toBe(false);
    expect(plan.mutatesWorkspace).toBe(false);
  });

  it('stops at the publication approval rather than planning a publication', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const proposed = await fixture.store.load(fixture.record.runId);

    const { plan } = await planFor(proposed, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    // §26: the page exists and no decision names it, so this is where resume ends —
    // naming the digest a person has to agree to, and promising nothing past it.
    expect(plan.action).toBe('PUBLICATION_APPROVAL_REQUIRED');
    expect(plan.command).toBe('pr');
    expect(plan.requiresPublicationApproval).toBe(true);
    expect(plan.requiresRepairApproval).toBe(false);
    expect(plan.reason).toContain(shown.digest?.slice(0, 12));
    expect(plan.reason.toLowerCase()).not.toMatch(/publish|push|opened|created|remote|merged/);
  });

  it('plans nothing further once a human has approved the exact page', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const approved = await fixture.store.load(fixture.record.runId);

    const { plan } = await planFor(approved, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    expect(plan.action).toBe('NOTHING_TO_RESUME');
    expect(plan.stage).toBeNull();
    expect(plan.command).toBeNull();
    expect(plan.requiresModel).toBe(false);
    expect(plan.requiresPublicationApproval).toBe(false);
    expect(plan.mutatesWorkspace).toBe(false);
    // This build has no publisher, so an approved page is the end of the road and
    // the plan says so instead of inventing the next step (§26).
    expect(JSON.stringify(plan)).not.toMatch(/publish|push|merged|remote|opened/i);
  });

  it('plans no command when the workspace cannot be acted on, and names no way around it', async () => {
    const fixture = await reviewedRun(tempDirs);
    const gone = path.join(path.dirname(fixture.workspace), 'deleted-by-somebody');

    const { snapshot, plan } = await planFor(
      recordWith(fixture.record, {
        local: { ...fixture.record.local!, toplevel: gone, requestedPath: gone },
      }),
      { store: fixture.store, runsRoot: fixture.runsRoot },
    );

    expect(snapshot.blockers.length).toBeGreaterThan(0);
    expect(plan.action).toBe('RECOVERY_BLOCKED');
    expect(plan.command).toBeNull();
    expect(plan.currentPatchIdentity).toBeNull();
    for (const flag of [
      'requiresModel',
      'requiresCredential',
      'requiresExecutionConsent',
      'requiresRepairApproval',
      'requiresPublicationApproval',
      'mutatesWorkspace',
    ] as const) {
      expect(plan[flag]).toBe(false);
    }
    // §29 with §35: the answer is a fact about the directory that is not there, and
    // never an instruction to rebuild it — rebuilding it is what would destroy the
    // evidence the run is made of.
    expect(plan.reason).toMatch(/workspace/i);
    expect(plan.reason).not.toMatch(/git (reset|clean|checkout|stash|revert|clone)|--hard|rm -rf/);
  });

  it('plans the contract for a run that never got one', async () => {
    const prepared = await contractBackedRun(tempDirs);

    const { plan } = await planFor(recordWith(prepared.record, { acceptanceContract: null }), {
      store: prepared.store,
      runsRoot: prepared.root,
    });

    expect(plan.action).toBe('DERIVE_ACCEPTANCE_CONTRACT');
    expect(plan.stage).toBe('contract');
    expect(plan.command).toBe('contract');
    expect(plan.requiresModel).toBe(false);
    expect(plan.mutatesWorkspace).toBe(false);
  });
});

describe.skipIf(!AVAILABLE)('the state a plan is bound to', () => {
  it('is a digest over the facts, and not over the time they were read', async () => {
    const fixture = await reviewedRun(tempDirs);
    const where = { store: fixture.store, runsRoot: fixture.runsRoot };

    const first = await planFor(stoppedEarly(fixture.record), where);
    const again = await planFor(stoppedEarly(fixture.record), where);
    const later = await planFor(stoppedEarly(fixture.record), where, {
      observedAt: new Date(NOW.getTime() + 3_600_000),
    });

    expect(first.plan.observedStateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.plan.observedStateDigest).toBe(again.plan.observedStateDigest);
    // A re-read of unchanged bytes cannot invalidate a preview; only the bytes can.
    expect(later.plan.observedStateDigest).toBe(first.plan.observedStateDigest);
    expect(later.plan.schemaVersion).toBe(1);
    expect(later.plan.runId).toBe(fixture.record.runId);

    // The same run with the patch moved is a different state, so the earlier plan
    // cannot be executed against it (§34: no preview of X, then action on Y).
    await put(fixture.workspace, 'notes.md', 'somebody wrote here\n');
    const moved = await planFor(stoppedEarly(fixture.record), where);
    expect(moved.plan.observedStateDigest).not.toBe(first.plan.observedStateDigest);
  });

  it('does not move when the same facts are written in another order', async () => {
    const fixture = await reviewedRun(tempDirs);

    const { snapshot, plan } = await planFor(fixture.record, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    // The digest is over facts, not over how a document happened to be serialised.
    // A preview that expired because a field was written in a different order would
    // be one nobody could rely on, and no re-read of a run changes its state that way.
    expect(buildResumePlan(reordered(snapshot)).observedStateDigest).toBe(plan.observedStateDigest);
  });

  it('carries exactly the fields a plan is made of, and no verdict of its own', async () => {
    const fixture = await reviewedRun(tempDirs);

    const { plan } = await planFor(fixture.record, {
      store: fixture.store,
      runsRoot: fixture.runsRoot,
    });

    expect(Object.keys(plan).sort()).toEqual(
      [
        'action',
        'command',
        'currentPatchIdentity',
        'mutatesWorkspace',
        'observedStateDigest',
        'reason',
        'requiresCredential',
        'requiresExecutionConsent',
        'requiresModel',
        'requiresPublicationApproval',
        'requiresRepairApproval',
        'runId',
        'schemaVersion',
        'stage',
      ].sort(),
    );
    // The two cost flags agree, because the only credential this build consumes is
    // the model's — a plan that could claim otherwise would be a plan that misreports
    // what a run is missing.
    expect(plan.requiresCredential).toBe(plan.requiresModel);
    // Nothing here judges the run: no readiness, no score, no outcome word.
    expect(JSON.stringify(plan)).not.toMatch(
      /CONTRIBUTION_READY|ready|success|passed|health|score/i,
    );
  });
});

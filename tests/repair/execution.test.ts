import { describe, expect, it } from 'vitest';
import {
  IMPL_SCHEMA_VERSION,
  implementationRecordSchema,
  type ImplementationRecord,
} from '../../src/implement/state.js';
import type { AppError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/security/digest.js';
import { approveRepairPlan, type RepairApproval } from '../../src/repair/consent.js';
import {
  REPAIR_EXECUTION_SCHEMA_VERSION,
  buildRepairExecution,
  parseRepairExecution,
  type RepairExecution,
  type RepairExecutionInput,
} from '../../src/repair/execution.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import {
  REPAIR_PLAN_SCHEMA_VERSION,
  parseRepairPlan,
  type RepairPlan,
} from '../../src/repair/plan.js';
import { classifyRepairScope, routeRepairScope } from '../../src/repair/scope.js';
import { patchDescriptionSchema, type PatchDescription } from '../../src/verify/patch.js';

/**
 * What one repair cycle actually did — Stage 9R's execution record.
 *
 * A plan says what was meant and an approval says a human allowed it, but neither
 * of them survives contact with the workspace: after a cycle there are two patches
 * where there was one, a loop that wrote or refused things, and a set of receipts
 * that now describe bytes nobody is looking at any more. This document is the one
 * place those facts are held together, because separately they are each readable
 * and jointly misleading — a green verification and a repair that followed it say
 * nothing at all about which came first.
 *
 * The properties these tests defend are the ones that make the document worth
 * writing at all. It cannot be built without an approval whose digest matches the
 * plan being executed, so "the record says it ran" carries the same consent as
 * "a human approved this scope" rather than a looser one. It records the patch
 * before and after by identity, so a reader can tell A from B after the workspace
 * has moved on, and it says plainly when the old evidence may no longer be quoted
 * — including when the repair is being sent to a human, because a stale green
 * state does not become green again by being escalated. And it is a closed shape:
 * there is no field for a verdict, no field for a criterion the repair called
 * finished, no field for reasoning the model produced, and no field a later stage
 * could widen. What a repair achieved is decided by re-running the gates, which is
 * a different document.
 *
 * Everything here is arithmetic over documents that already exist — a plan, an
 * approval, two measurements of one patch, a loop's own account — and no test in
 * this file touches a filesystem or a model, because the module does not either.
 */

const BASE = 'b'.repeat(40);
const RUN_ID = 'run-20260926t090000z-repair1';
const NOW = '2026-09-26T09:30:00.000Z';

/** A patch measured from disk carries a digest of its own bytes; this is one. */
function measured(
  files: readonly [string, string, 'ADDED' | 'MODIFIED' | 'DELETED'][],
  baseSha: string = BASE,
): { description: PatchDescription; identity: string } {
  const facts = files.map(([filePath, content, change]) => ({
    path: filePath,
    tracked: change !== 'ADDED',
    change,
    contentSha256: change === 'DELETED' ? null : sha256Hex(content),
  }));
  const identity = sha256Hex(JSON.stringify(facts));
  return {
    description: patchDescriptionSchema.parse({
      schemaVersion: 1,
      baseSha,
      identity,
      files: facts,
    }),
    identity,
  };
}

/** The contribution under review: the file a finding names, and one it does not. */
function patchA() {
  return measured([
    ['src/parse.ts', 'export const PARSED = 1;\n', 'MODIFIED'],
    ['README.md', 'old readme\n', 'DELETED'],
  ]);
}

/** The same patch with the finding's file actually fixed. */
function patchB() {
  return measured([
    ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
    ['README.md', 'old readme\n', 'DELETED'],
  ]);
}

function planFor(reviewedPatchIdentity: string, over: Partial<RepairPlan> = {}): RepairPlan {
  return parseRepairPlan({
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: RUN_ID,
    reviewCycle: 1,
    repairCycle: 1,
    reviewedPatchIdentity,
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: ['AC-1'],
        intendedChange: 'Handle the leap-year case the criterion names.',
        expectedFiles: ['src/parse.ts'],
        expectedChecks: ['VG-001'],
      },
    ],
    criteria: ['AC-1'],
    expectedFiles: ['src/parse.ts'],
    expectedChecks: ['VG-001'],
    createdAt: '2026-09-26T09:00:00.000Z',
    ...over,
  });
}

/** The loop's own account of the cycle, in the shape Stage 6 writes it. */
function loopRecord(over: { runId?: string } = {}): ImplementationRecord {
  const runId = over.runId ?? RUN_ID;
  return implementationRecordSchema.parse({
    schemaVersion: IMPL_SCHEMA_VERSION,
    runId,
    status: 'COMPLETED_BY_MODEL',
    termination: { kind: 'FINISH', detail: 'The model asked to stop.' },
    model: 'scripted-cycle-model',
    workspace: {
      relativePath: '.mergesutra/worktrees/repair',
      branch: 'mergesutra/repair',
      baseSha: BASE,
      reused: true,
      primaryDirty: false,
    },
    contract: { runId, version: 1, criterionIds: ['AC-1'] },
    limits: { maxSteps: 8, maxWrites: 4, maxCommands: 3, maxRepeatedFailures: 2 },
    actions: [
      {
        step: 1,
        action: 'WRITE_FILE',
        target: 'src/parse.ts',
        criterionIds: ['AC-1'],
        outcome: 'APPLIED',
        detail: 'Wrote 26 bytes.',
        exitCode: null,
        risk: 'WRITE',
        at: NOW,
      },
    ],
    changes: [
      {
        relativePath: 'src/parse.ts',
        bytes: 26,
        created: false,
        contentSha256: sha256Hex('export const PARSED = 2;\n'),
        criterionIds: ['AC-1'],
        step: 1,
      },
    ],
    summary: {
      steps: 2,
      modelRequests: 2,
      writes: 1,
      commands: 0,
      refusedActions: 0,
      proposedRevisions: 0,
      totalBytesWritten: 26,
    },
    createdAt: NOW,
  });
}

function approvalFor(plan: RepairPlan): RepairApproval {
  return approveRepairPlan({ plan, approvedAt: '2026-09-26T09:10:00.000Z' });
}

/**
 * The cycle a human said yes to, with one thing swapped out.
 *
 * The approval follows the plan unless a test overrides it, because the default
 * fixture is an approved cycle and the interesting cases are the ones where the
 * yes and the work come apart.
 */
function build(over: Partial<RepairExecutionInput> = {}): RepairExecution {
  const a = patchA();
  const b = patchB();
  const input: RepairExecutionInput = {
    plan: planFor(a.identity),
    patchBefore: a.description,
    patchAfter: b.description,
    implementation: loopRecord(),
    createdAt: NOW,
    ...over,
  };
  return buildRepairExecution({
    ...input,
    approval: over.approval ?? approvalFor(input.plan),
  });
}

function failureOf(run: () => unknown): AppError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as AppError;
  }
}

describe('a repair cycle that ran with a human’s yes', () => {
  it('names the plan it executed by digest, so the record points at an approval', () => {
    const a = patchA();
    const plan = planFor(a.identity);
    const b = patchB();

    const execution = buildRepairExecution({
      plan,
      approval: approvalFor(plan),
      patchBefore: a.description,
      patchAfter: b.description,
      implementation: loopRecord(),
      createdAt: NOW,
    });

    expect(execution.planDigest).toBe(repairPlanDigest(plan));
    expect(execution.runId).toBe(RUN_ID);
  });

  it('carries the cycles of the plan it executed, not of the run as a whole', () => {
    const a = patchA();
    const plan = planFor(a.identity, { reviewCycle: 2, repairCycle: 3 });

    const execution = build({ plan, approval: approvalFor(plan) });

    expect(execution.reviewCycle).toBe(2);
    expect(execution.repairCycle).toBe(3);
  });

  it('records both patches by identity, so A and B stay distinguishable', () => {
    const a = patchA();
    const b = patchB();

    const execution = build({ patchBefore: a.description, patchAfter: b.description });

    expect(execution.patchBeforeIdentity).toBe(a.identity);
    expect(execution.patchAfterIdentity).toBe(b.identity);
    expect(execution.patchBeforeIdentity).not.toBe(execution.patchAfterIdentity);
    expect(execution.patchChanged).toBe(true);
  });

  it('says the old evidence describes bytes that are gone', () => {
    expect(build().verificationRequired).toBe(true);
  });

  it('keeps the loop’s own account of the cycle, refusals and all', () => {
    const implementation = loopRecord();

    const execution = build({ implementation });

    expect(execution.implementation).toEqual(implementation);
    expect(execution.implementation.verified).toBe(false);
  });

  it('classifies the delta with the scope guard instead of re-describing it', () => {
    const a = patchA();
    const plan = planFor(a.identity);
    const b = patchB();

    const execution = build({ plan, approval: approvalFor(plan) });

    expect(execution.scope).toEqual(
      classifyRepairScope({ plan, patchBefore: a.description, patchAfter: b.description }),
    );
    expect(execution.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');
  });

  it('survives a round trip through disk unchanged', () => {
    const execution = build();

    expect(parseRepairExecution(JSON.parse(JSON.stringify(execution)))).toEqual(execution);
  });
});

describe('a repair that changed nothing', () => {
  it('does not demand re-verification of bytes it never moved', () => {
    const a = patchA();

    const execution = build({ patchBefore: a.description, patchAfter: a.description });

    expect(execution.patchChanged).toBe(false);
    expect(execution.verificationRequired).toBe(false);
  });

  it('still cannot be read as a clean repair, because the scope guard said it was not one', () => {
    const a = patchA();

    const execution = build({ patchBefore: a.description, patchAfter: a.description });

    expect(execution.scope.outcome).toBe('REPAIR_LEFT_NO_TRACE');
  });
});

describe('a repair that reached outside its plan', () => {
  function overreached() {
    const a = patchA();
    const plan = planFor(a.identity);
    const b = measured([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['docs/EXTRA.md', 'while I am here\n', 'ADDED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);
    return { plan, patchBefore: a.description, patchAfter: b.description };
  }

  it('records the overreach rather than laundering it', () => {
    const execution = build(overreached());

    expect(execution.scope.outcome).toBe('OUTSIDE_PLANNED_SCOPE');
    expect(execution.scope.unexpectedFiles).toEqual(['docs/EXTRA.md']);
    expect(routeRepairScope(execution.scope)).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('leaves the old evidence stale even though the cycle is going to a human', () => {
    const execution = build(overreached());

    expect(execution.patchChanged).toBe(true);
    expect(execution.verificationRequired).toBe(true);
  });
});

describe('a cycle nobody approved', () => {
  it('is not recorded as an execution at all', () => {
    const a = patchA();
    const b = patchB();

    const error = failureOf(() =>
      buildRepairExecution({
        plan: planFor(a.identity),
        patchBefore: a.description,
        patchAfter: b.description,
        implementation: loopRecord(),
        createdAt: NOW,
      }),
    );

    expect(error).toBeDefined();
    expect(error?.message).toMatch(/approv/i);
  });

  it('refuses an approval made for a different plan, even one file apart', () => {
    const a = patchA();
    const approved = planFor(a.identity);
    const toExecute = planFor(a.identity, { expectedFiles: ['src/parse.ts', 'src/calendar.ts'] });

    const error = failureOf(() => build({ plan: toExecute, approval: approvalFor(approved) }));

    expect(error?.message).toMatch(/digest/i);
    expect(error?.message).toMatch(/different|stale/i);
  });

  it('refuses a digest the caller typed instead of one derived from the plan', () => {
    const error = failureOf(() =>
      build({ approval: { planDigest: 'f'.repeat(64), approvedAt: NOW } }),
    );

    expect(error?.message).toMatch(/digest/i);
  });

  it('records the canonical digest however the approval was typed', () => {
    const execution = build({
      approval: {
        planDigest: repairPlanDigest(planFor(patchA().identity)).toUpperCase(),
        approvedAt: NOW,
      },
    });

    expect(execution.planDigest).toBe(repairPlanDigest(planFor(patchA().identity)));
  });
});

describe('a cycle that belongs to somebody else’s run', () => {
  it('refuses a loop record written for another run', () => {
    const error = failureOf(() => build({ implementation: loopRecord({ runId: 'run-other' }) }));

    expect(error?.message).toMatch(/run/i);
  });

  it('refuses a before-measurement the plan was never frozen for', () => {
    const a = patchA();
    const b = patchB();

    const error = failureOf(() => build({ patchBefore: b.description, patchAfter: a.description }));

    expect(error?.message).toMatch(/frozen|not the patch/i);
  });

  it('refuses two measurements taken from different bases', () => {
    const a = patchA();
    const b = patchB();
    const otherBase = patchDescriptionSchema.parse({
      ...b.description,
      baseSha: 'd'.repeat(40),
    });

    const error = failureOf(() =>
      build({ plan: planFor(a.identity), patchBefore: a.description, patchAfter: otherBase }),
    );

    expect(error?.message).toMatch(/base/i);
  });
});

describe('what this document cannot say', () => {
  it('has exactly the fields a cycle leaves behind, and no room for more', () => {
    const execution = build();

    expect(Object.keys(execution).sort()).toEqual(
      [
        'createdAt',
        'implementation',
        'patchAfterIdentity',
        'patchBeforeIdentity',
        'patchChanged',
        'planDigest',
        'repairCycle',
        'reviewCycle',
        'runId',
        'scope',
        'schemaVersion',
        'verificationRequired',
      ].sort(),
    );
  });

  it('rejects a verdict written into it by hand', () => {
    const execution = build();

    const error = failureOf(() => parseRepairExecution({ ...execution, contributionReady: true }));

    expect(error?.message).toMatch(/contributionReady/);
  });

  it('rejects an approval pasted into it, which is what the digest is for', () => {
    const execution = build();

    const error = failureOf(() => parseRepairExecution({ ...execution, approvedBy: 'pavithran' }));

    expect(error?.message).toMatch(/approvedBy/);
  });

  it('rejects a document from a schema version this build does not read', () => {
    const execution = build();

    const error = failureOf(() => parseRepairExecution({ ...execution, schemaVersion: 99 }));

    expect(error?.message).toMatch(/version|schemaVersion/i);
  });

  it('states which schema version it is, so a later reader knows what it is owed', () => {
    expect(build().schemaVersion).toBe(REPAIR_EXECUTION_SCHEMA_VERSION);
  });

  it('carries no verdict, consent or free-form reasoning of its own', () => {
    const text = JSON.stringify(build());

    for (const word of [
      'CONTRIBUTION_READY',
      '"PASS"',
      '"approved"',
      '"verdict"',
      '"reasoning"',
      '"approvedBy"',
    ]) {
      expect(text.toLowerCase().includes(word.toLowerCase()), word).toBe(false);
    }
  });
});

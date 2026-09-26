import { describe, expect, it } from 'vitest';
import { parseRepairPlan, type RepairPlan } from '../../src/repair/plan.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import {
  approveRepairPlan,
  decideRepairApproval,
  parseRepairApproval,
  type RepairApproval,
} from '../../src/repair/consent.js';

/**
 * Whether a human has said yes to *this* repair — Stage 9R.
 *
 * A frozen plan is MergeSutra's work order, and a work order written by the
 * software is not the same object as permission from the person who owns the
 * repository. So the yes is its own capability, and the only thing it can carry
 * is the digest of the scope it was given. There is no wildcard in this shape, no
 * `--yes`, no `--force`, no `approvedAll`, and no field where a person could agree
 * to "whatever the model decides next" — agreeing to everything is the one thing
 * this stage is not allowed to be told.
 *
 * The comparison is the whole decision. Same digest, the repair may run. Different
 * digest, the approval on file is about some other job — a re-frozen plan, a later
 * cycle, a retyped word — and nothing here is mutated to find out which.
 */

const PATCH_A = 'a'.repeat(64);

function planFor(over: Partial<RepairPlan> = {}): RepairPlan {
  return parseRepairPlan({
    schemaVersion: 1,
    runId: 'run-20260924T101500Z-abc123',
    reviewCycle: 1,
    repairCycle: 1,
    reviewedPatchIdentity: PATCH_A,
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: ['AC-1'],
        intendedChange: 'Guard the empty month before indexing it.',
        expectedFiles: ['src/parse.ts'],
        expectedChecks: ['VG-001'],
      },
    ],
    criteria: ['AC-1'],
    expectedFiles: ['src/parse.ts'],
    expectedChecks: ['VG-001'],
    createdAt: '2026-09-24T10:15:00.000Z',
    ...over,
  });
}

function approvalFor(plan: RepairPlan): RepairApproval {
  return approveRepairPlan({ plan, approvedAt: '2026-09-24T10:20:00.000Z' });
}

describe('an approval nobody gave', () => {
  it('is not assumed from the plan existing', () => {
    const plan = planFor();
    const decision = decideRepairApproval({ plan });

    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('ABSENT');
    expect(decision.requiresApproval).toBe(true);
  });

  it('names the digest it would have needed, so the flag is typeable', () => {
    const plan = planFor();
    const decision = decideRepairApproval({ plan, approval: null });

    expect(decision.expectedDigest).toBe(repairPlanDigest(plan));
    expect(decision.reason).toMatch(/--approve-plan/);
  });

  it('is not filled in by a caller who passes an empty string', () => {
    expect(() => parseRepairApproval({ planDigest: '', approvedAt: 'now' })).toThrow(/digest/i);
  });
});

describe('an approval that matches', () => {
  it('lets the repair proceed, and only for the plan it was made against', () => {
    const plan = planFor();
    const decision = decideRepairApproval({ plan, approval: approvalFor(plan) });

    expect(decision.status).toBe('MATCHED');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('is authored from the plan, not from a digest the caller typed into it', () => {
    const plan = planFor();

    expect(approvalFor(plan).planDigest).toBe(repairPlanDigest(plan));
  });

  it('does not care about hex case, because a person is pasting it', () => {
    const plan = planFor();
    const upper: RepairApproval = {
      ...approvalFor(plan),
      planDigest: repairPlanDigest(plan).toUpperCase(),
    };

    expect(decideRepairApproval({ plan, approval: upper }).allowed).toBe(true);
  });

  it('is the same approval read back from disk', () => {
    const plan = planFor();
    const approval = approvalFor(plan);

    expect(parseRepairApproval(JSON.parse(JSON.stringify(approval)))).toEqual(approval);
  });
});

describe('an approval that does not match', () => {
  it('blocks a wrong digest rather than running the nearest repair', () => {
    const plan = planFor();
    const wrong: RepairApproval = { ...approvalFor(plan), planDigest: 'f'.repeat(64) };
    const decision = decideRepairApproval({ plan, approval: wrong });

    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('STALE');
    expect(decision.givenDigest).toBe(wrong.planDigest);
  });

  it('goes stale the moment the plan changes under it', () => {
    const approved = planFor();
    const approval = approvalFor(approved);
    const refrozen = planFor({ expectedFiles: ['src/parse.ts', 'src/calendar.ts'] });
    const decision = decideRepairApproval({ plan: refrozen, approval });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/different|no longer|stale/i);
  });

  it('does not carry from repair cycle 1 to repair cycle 2', () => {
    const first = planFor();
    const second = planFor({ repairCycle: 2, reviewCycle: 2 });

    expect(decideRepairApproval({ plan: second, approval: approvalFor(first) }).allowed).toBe(
      false,
    );
  });

  it('says a human is the missing thing, never that the repair may proceed anyway', () => {
    const plan = planFor();
    const decision = decideRepairApproval({
      plan,
      approval: { ...approvalFor(plan), planDigest: '0'.repeat(64) },
    });

    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toMatch(/human|operator|approve/i);
  });
});

describe('what an approval cannot be made of', () => {
  const rejected: [string, unknown][] = [
    ['a wildcard', { planDigest: '*', approvedAt: 'now' }],
    ['an all', { planDigest: 'all', approvedAt: 'now' }],
    ['a boolean', { planDigest: true, approvedAt: 'now' }],
    [
      'an approval of everything',
      { planDigest: 'a'.repeat(64), approvedAt: 'now', approveAll: true },
    ],
    ['a verdict', { planDigest: 'a'.repeat(64), approvedAt: 'now', status: 'APPROVED' }],
    [
      'a criterion passed',
      { planDigest: 'a'.repeat(64), approvedAt: 'now', criteriaPassed: ['AC-1'] },
    ],
    ['a missing timestamp', { planDigest: 'a'.repeat(64) }],
  ];

  for (const [what, value] of rejected) {
    it(`refuses ${what}`, () => {
      expect(() => parseRepairApproval(value), what).toThrow();
    });
  }

  it('carries no plan of its own, so it cannot disagree with the record', () => {
    const keys = Object.keys(approvalFor(planFor())).sort();

    expect(keys).toEqual(['approvedAt', 'planDigest']);
  });
});

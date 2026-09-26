import { describe, expect, it } from 'vitest';
import { parseRepairPlan, type RepairPlan } from '../../src/repair/plan.js';
import { REPAIR_PLAN_DIGEST_LABEL, repairPlanDigest } from '../../src/repair/digest.js';

/**
 * What a person is being asked to approve — Stage 9R.
 *
 * A repair plan is a scope: these findings, these files, these gates, against
 * these exact bytes. Stage 9 froze one and stopped; Stage 9R lets a human say
 * yes to *that* document, and a yes has to be attached to something a reader can
 * recompute. So this digest is the whole approval surface: it is over the plan's
 * scope and nothing else, which means the same plan written a minute later still
 * carries the same approval, and one word of scope different means the approval
 * on file is about a different job.
 */

const PATCH_A = 'a'.repeat(64);
const PATCH_B = 'b'.repeat(64);

function frozen(over: Partial<RepairPlan> = {}): RepairPlan {
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
      {
        findingId: 'RF-002',
        criterionIds: ['AC-2'],
        intendedChange: 'State the skipped criterion in the report.',
        expectedFiles: ['src/report.ts'],
        expectedChecks: ['VG-002'],
      },
    ],
    criteria: ['AC-1', 'AC-2'],
    expectedFiles: ['src/parse.ts', 'src/report.ts'],
    expectedChecks: ['VG-001', 'VG-002'],
    createdAt: '2026-09-24T10:15:00.000Z',
    ...over,
  });
}

describe('the shape of a repair-plan digest', () => {
  it('is a sha256 digest a reader can recompute', () => {
    expect(repairPlanDigest(frozen())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says what it digests, so a label cannot be borrowed from another document', () => {
    expect(REPAIR_PLAN_DIGEST_LABEL).toMatch(/repair/i);
  });

  it('is the same number for the same plan, measured twice', () => {
    const plan = frozen();

    expect(repairPlanDigest(plan)).toBe(repairPlanDigest(plan));
  });

  it('survives a round trip through disk', () => {
    const plan = frozen();

    expect(repairPlanDigest(parseRepairPlan(JSON.parse(JSON.stringify(plan))))).toBe(
      repairPlanDigest(plan),
    );
  });
});

describe('what a repair-plan digest refuses to notice', () => {
  it('ignores the minute the plan was frozen, because consent is about scope', () => {
    expect(repairPlanDigest(frozen({ createdAt: '2026-12-01T00:00:00.000Z' }))).toBe(
      repairPlanDigest(frozen()),
    );
  });

  it('ignores the order the findings were listed in', () => {
    const plan = frozen();
    const reversed = frozen({ findings: [...plan.findings].reverse() });

    expect(repairPlanDigest(reversed)).toBe(repairPlanDigest(plan));
  });

  it('ignores the order the roll-up lists files and gates in', () => {
    const plan = frozen();
    const shuffled = frozen({
      expectedFiles: [...plan.expectedFiles].reverse(),
      expectedChecks: [...plan.expectedChecks].reverse(),
      criteria: [...plan.criteria].reverse(),
    });

    expect(repairPlanDigest(shuffled)).toBe(repairPlanDigest(plan));
  });
});

describe('what a repair-plan digest binds', () => {
  const changes: [string, () => RepairPlan][] = [
    ['the run it belongs to', () => frozen({ runId: 'run-20260924T101500Z-zzz999' })],
    ['the review cycle', () => frozen({ reviewCycle: 2 })],
    ['the repair cycle', () => frozen({ repairCycle: 2 })],
    ['the patch it was frozen against', () => frozen({ reviewedPatchIdentity: PATCH_B })],
    [
      'a file the plan may touch',
      () =>
        frozen({
          expectedFiles: ['src/parse.ts', 'src/calendar.ts'],
          findings: [
            {
              findingId: 'RF-001',
              criterionIds: ['AC-1'],
              intendedChange: 'Guard the empty month before indexing it.',
              expectedFiles: ['src/parse.ts'],
              expectedChecks: ['VG-001'],
            },
            {
              findingId: 'RF-002',
              criterionIds: ['AC-2'],
              intendedChange: 'State the skipped criterion in the report.',
              expectedFiles: ['src/calendar.ts'],
              expectedChecks: ['VG-002'],
            },
          ],
        }),
    ],
    [
      'a gate the plan answers to',
      () =>
        frozen({
          expectedChecks: ['VG-001'],
          findings: [
            {
              findingId: 'RF-001',
              criterionIds: ['AC-1'],
              intendedChange: 'Guard the empty month before indexing it.',
              expectedFiles: ['src/parse.ts'],
              expectedChecks: ['VG-001'],
            },
            {
              findingId: 'RF-002',
              criterionIds: ['AC-2'],
              intendedChange: 'State the skipped criterion in the report.',
              expectedFiles: ['src/report.ts'],
              expectedChecks: [],
            },
          ],
        }),
    ],
    [
      'a criterion the plan bears on',
      () =>
        frozen({
          criteria: ['AC-1', 'AC-2', 'AC-3'],
          findings: [
            {
              findingId: 'RF-001',
              criterionIds: ['AC-1', 'AC-3'],
              intendedChange: 'Guard the empty month before indexing it.',
              expectedFiles: ['src/parse.ts'],
              expectedChecks: ['VG-001'],
            },
            {
              findingId: 'RF-002',
              criterionIds: ['AC-2'],
              intendedChange: 'State the skipped criterion in the report.',
              expectedFiles: ['src/report.ts'],
              expectedChecks: ['VG-002'],
            },
          ],
        }),
    ],
    [
      'the wording of what a finding asked for',
      () =>
        frozen({
          findings: [
            {
              findingId: 'RF-001',
              criterionIds: ['AC-1'],
              intendedChange: 'Delete the check instead.',
              expectedFiles: ['src/parse.ts'],
              expectedChecks: ['VG-001'],
            },
            {
              findingId: 'RF-002',
              criterionIds: ['AC-2'],
              intendedChange: 'State the skipped criterion in the report.',
              expectedFiles: ['src/report.ts'],
              expectedChecks: ['VG-002'],
            },
          ],
        }),
    ],
    [
      'which finding is in the plan at all',
      () =>
        frozen({
          findings: [
            {
              findingId: 'RF-003',
              criterionIds: ['AC-1'],
              intendedChange: 'Guard the empty month before indexing it.',
              expectedFiles: ['src/parse.ts'],
              expectedChecks: ['VG-001'],
            },
            {
              findingId: 'RF-002',
              criterionIds: ['AC-2'],
              intendedChange: 'State the skipped criterion in the report.',
              expectedFiles: ['src/report.ts'],
              expectedChecks: ['VG-002'],
            },
          ],
        }),
    ],
  ];

  for (const [what, make] of changes) {
    it(`changes when the plan changes in ${what}`, () => {
      expect(repairPlanDigest(make())).not.toBe(repairPlanDigest(frozen()));
    });
  }
});

describe('what a digest will not digest', () => {
  it('refuses a document that is not a repair plan, rather than hashing anything', () => {
    const almost = { ...frozen(), status: 'APPROVED' } as unknown as RepairPlan;

    expect(() => repairPlanDigest(almost)).toThrow(/unrecognized key|repair plan|not a/i);
  });

  it('refuses a plan whose reviewed patch identity is not a digest', () => {
    const body = { ...frozen(), reviewedPatchIdentity: 'HEAD' };

    expect(() => repairPlanDigest(body as unknown as RepairPlan)).toThrow(
      /digest|sha256|identity/i,
    );
  });
});

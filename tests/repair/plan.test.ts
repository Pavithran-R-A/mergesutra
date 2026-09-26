import { afterAll, describe, expect, it } from 'vitest';
import { assembleReviewContext, type ReviewContext } from '../../src/review/context.js';
import {
  buildReviewDocument,
  reviewFindingBodySchema,
  type ReviewDisposition,
  type ReviewDispositionInput,
  type ReviewDocument,
  type ReviewFindingBody,
} from '../../src/review/schema.js';
import {
  MAX_FINDINGS_PER_REPAIR,
  MAX_FINDINGS_PER_REPAIR_CEILING,
  MAX_REVIEW_CYCLES_CEILING,
} from '../../src/repair/bounds.js';
import {
  REPAIR_PLAN_SCHEMA_VERSION,
  buildRepairPlan,
  parseRepairPlan,
  type RepairPlan,
} from '../../src/repair/plan.js';
import { planTouching } from '../helpers/implement.js';
import {
  cleanUp,
  hasGit,
  recordWith,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * What may become work — Stage 9's frozen repair plan.
 *
 * A review is a stream of claims; the plan is the single document that turns some
 * of them into an edit, so this is where a model's words stop being authority.
 * It is built only from findings MergeSutra already weighed and cross-checked
 * against the manifest, it names the patch those findings describe, and it is
 * written down before anything is changed. It cannot say a criterion passed,
 * because the only thing that may answer that is a fresh verification of the
 * bytes the repair produced.
 *
 * The negative half is the substance. A plan that carried a status would let a
 * model declare its own fix successful; a plan that carried a command string
 * would be a shell with a schema drawn around it; a plan that named a file nobody
 * reviewed would point a writer at anything. Those keys do not exist here, and
 * the tests below are what keep that from being a claim about a comment.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

/** The plan Stage 4 promised and the patch left one of them untouched. */
const PROMISED = ['src/parse.ts', 'src/calendar.ts', '.github/workflows/ci.yml'];

let prepared: Promise<{ fixture: ReviewFixture; context: ReviewContext }> | null = null;

async function oneContext() {
  if (!prepared) {
    prepared = (async () => {
      const fixture = await reviewFixture(made);
      const record = recordWith(fixture.record, { plan: planTouching(PROMISED) });
      const context = await assembleReviewContext({
        record,
        workspace: fixture.workspace,
        patch: fixture.patch,
      });
      return { fixture, context };
    })();
  }
  return prepared;
}

function bodies(count: number, criteria: readonly string[]): ReviewFindingBody[] {
  return Array.from({ length: count }, (unused, index) =>
    reviewFindingBodySchema.parse({
      severity: 'HIGH',
      category: index % 2 === 0 ? 'CORRECTNESS' : 'TEST_GAP',
      statement: `The parser accepts a day that never happened on input shape ${index}.`,
      impact: `A caller relying on shape ${index} stores the wrong day and is never told.`,
      evidence: 'src/parse.ts builds a Date from a string it does not validate.',
      file: 'src/parse.ts',
      criterionIds: [criteria[index % criteria.length]],
      contextRefs: [],
      proposedAction: `Change src/parse.ts to reject shape ${index} before constructing a Date.`,
    }),
  );
}

interface ReviewCase {
  readonly count?: number;
  readonly dispositions?: readonly ReviewDisposition[];
  readonly patchMoved?: boolean;
  readonly manifestFromOtherPatch?: boolean;
  readonly runOtherThanTheRecord?: boolean;
  readonly limits?: { readonly maxFindingsPerRepair?: number };
  readonly cycles?: { readonly reviewCycle?: number; readonly repairCycle?: number };
}

async function planned(
  case_: ReviewCase = {},
): Promise<{ plan: RepairPlan; review: ReviewDocument }> {
  const { fixture, context } = await oneContext();
  // Criteria with a receipt behind them, so a plan's `expectedChecks` can never
  // be asserted against an empty list and pass by saying nothing.
  const criteria = context.criteria
    .map((criterion) => criterion.id)
    .filter((id) => promisedGates(fixture, [id]).length > 0);
  if (criteria.length === 0) throw new Error('the fixture has no criterion with a gate behind it');
  const findings = bodies(case_.count ?? 1, criteria).map((finding, index) => {
    const criterionId = criteria[index % criteria.length] ?? criteria[0];
    if (!criterionId) throw new Error('the fixture offers no criterion to cite');
    return reviewFindingBodySchema.parse({
      ...finding,
      criterionIds: [criterionId],
      contextRefs: [refTo(context, 'src/parse.ts'), criterionRef(context, criterionId)],
    });
  });
  const review = buildReviewDocument({
    runId: case_.runOtherThanTheRecord ? 'run-some-other-run' : fixture.record.runId,
    baseSha: fixture.base,
    reviewedPatchIdentity: fixture.patch.identity,
    currentPatchIdentity: case_.patchMoved ? 'b'.repeat(64) : fixture.patch.identity,
    modelId: 'answered-model-id',
    reviewedAt: '2026-09-26T09:00:00.000Z',
    attempts: 1,
    body: { summary: 'Findings to route.', findings },
    dispositions: dispositionsOf(findings, case_.dispositions),
  });
  const record = recordWith(fixture.record, { review });
  const manifest = case_.manifestFromOtherPatch
    ? { ...context.manifest, reviewedPatchIdentity: 'c'.repeat(64) }
    : context.manifest;

  const plan = buildRepairPlan({
    record,
    review,
    manifest,
    reviewCycle: case_.cycles?.reviewCycle ?? 1,
    repairCycle: case_.cycles?.repairCycle ?? 1,
    createdAt: '2026-09-26T09:05:00.000Z',
    ...(case_.limits ? { limits: case_.limits } : {}),
  });
  return { plan, review };
}

function dispositionsOf(
  findings: readonly unknown[],
  forced?: readonly ReviewDisposition[],
): readonly ReviewDispositionInput[] {
  return findings.map((unused, index) => ({
    index,
    disposition: forced?.[index] ?? 'VALID_REPAIR_CANDIDATE',
    reason: forced?.[index]
      ? `Routed away by test: ${forced[index]}.`
      : 'Cited material MergeSutra checked, and names a file a repair can aim at.',
  }));
}

function refused(case_: ReviewCase): Promise<string> {
  return planned(case_).then(
    () => {
      throw new Error('expected the plan to be refused');
    },
    (error: unknown) => (error as Error).message,
  );
}

/** The gates this run promised would answer for these criteria. */
function promisedGates(fixture: ReviewFixture, criteria: readonly string[]): string[] {
  return (fixture.record.verificationPlan?.gates ?? [])
    .filter((gate) => gate.relevantCriteria.some((id) => criteria.includes(id)))
    .map((gate) => gate.id);
}

function refTo(context: ReviewContext, path: string): string {
  const found = context.manifest.references.find((reference) => reference.path === path);
  if (!found) throw new Error(`the manifest carries no reference for ${path}`);
  return found.ref;
}

function criterionRef(context: ReviewContext, id: string): string {
  const found = context.manifest.references.find((reference) => reference.criterionId === id);
  if (!found) throw new Error(`the manifest carries no reference for ${id}`);
  return found.ref;
}

function receiptRef(context: ReviewContext, gateId: string): string {
  const found = context.manifest.references.find((reference) => reference.gateId === gateId);
  if (!found) throw new Error(`the manifest carries no reference for ${gateId}`);
  return found.ref;
}

/** A plan that is legal in every way except whatever a test breaks on purpose. */
function frozen(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: 'run-20260925T090000Z-999999',
    reviewCycle: 1,
    repairCycle: 1,
    reviewedPatchIdentity: 'a'.repeat(64),
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: ['AC-1'],
        intendedChange: 'Change src/parse.ts to reject the day before constructing a Date.',
        expectedFiles: ['src/parse.ts'],
        expectedChecks: ['VG-001'],
      },
    ],
    criteria: ['AC-1'],
    expectedFiles: ['src/parse.ts'],
    expectedChecks: ['VG-001'],
    createdAt: '2026-09-26T09:05:00.000Z',
    ...over,
  };
}

describe.skipIf(!AVAILABLE)('what may enter a repair plan', () => {
  it('is authored from a finding MergeSutra called a repair candidate', async () => {
    const { plan, review } = await planned();

    expect(plan.schemaVersion).toBe(REPAIR_PLAN_SCHEMA_VERSION);
    expect(plan.runId).toBe(review.runId);
    expect(plan.findings.length).toBe(1);
    expect(plan.findings[0]?.findingId).toBe('RF-001');
    expect(plan.findings[0]?.expectedFiles).toEqual(['src/parse.ts']);
    expect(plan.expectedFiles).toEqual(['src/parse.ts']);
    expect(plan.createdAt).toBe('2026-09-26T09:05:00.000Z');
  });

  it('carries the reviewer’s words as a task, and no verdict of any kind', async () => {
    const { plan } = await planned();

    expect(plan.findings[0]?.intendedChange).toMatch(/Change src\/parse\.ts to reject shape 0/);
    expect(JSON.stringify(plan)).not.toMatch(
      /"status"|"verdict"|"score"|"ready"|"passed"|CONTRIBUTION_READY/i,
    );
  });

  it('takes only the candidates when one review carries several routes', async () => {
    const { plan } = await planned({
      count: 3,
      dispositions: ['VALID_REPAIR_CANDIDATE', 'NEEDS_HUMAN_REVIEW', 'UNSUPPORTED'],
    });

    expect(plan.findings.map((item) => item.findingId)).toEqual(['RF-001']);
    expect(plan.findings[0]?.intendedChange).toMatch(/shape 0/);
  });

  it('refuses a review whose every finding went elsewhere', async () => {
    for (const disposition of [
      'NEEDS_HUMAN_REVIEW',
      'DUPLICATE',
      'OUT_OF_SCOPE',
      'UNSUPPORTED',
      'STALE',
    ] as const) {
      const message = await refused({ count: 2, dispositions: [disposition, disposition] });
      expect(message, disposition).toMatch(/candidate|nothing|no finding/i);
    }
  });

  it('names the patch the findings describe, not whatever is on disk now', async () => {
    const { plan, review } = await planned();

    expect(plan.reviewedPatchIdentity).toBe(review.reviewedPatchIdentity);
    expect(plan.reviewedPatchIdentity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('will not plan a repair for a review that has already gone stale', async () => {
    const message = await refused({ patchMoved: true });

    expect(message).toMatch(/stale|moved|changed/i);
  });

  it('will not author from a manifest that vouches for other bytes', async () => {
    const message = await refused({ manifestFromOtherPatch: true });

    expect(message).toMatch(/identity|bytes|patch/i);
  });

  it('will not author a plan for a run the record does not belong to', async () => {
    const message = await refused({ runOtherThanTheRecord: true });

    expect(message).toMatch(/run/i);
  });

  it('is the same plan read back from disk, and carries no invented item', async () => {
    const { plan } = await planned({ count: 2 });

    expect(parseRepairPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });
});

describe.skipIf(!AVAILABLE)('what a repair plan may name', () => {
  it('accepts a plan that names only a file, a criterion and a gate', () => {
    expect(() => parseRepairPlan(frozen())).not.toThrow();
  });

  it('collects the criteria its items bear on, once each', async () => {
    const { plan } = await planned({ count: 4 });

    expect(plan.criteria).toEqual(
      [...new Set(plan.findings.flatMap((item) => [...item.criterionIds]))].sort(),
    );
    expect(plan.criteria.length).toBeGreaterThan(0);
  });

  it('names the checks its items answer to, taken from this run’s verification plan', async () => {
    const { fixture } = await oneContext();
    const { plan } = await planned();

    expect(plan.expectedChecks.length, 'a plan with no checks re-ran nothing').toBeGreaterThan(0);
    for (const item of plan.findings) {
      expect(item.expectedChecks, item.findingId).toEqual(
        [...new Set(promisedGates(fixture, item.criterionIds))].sort(),
      );
      for (const gate of item.expectedChecks) expect(gate).toMatch(/^VG-\d{3}$/);
    }
    expect(plan.expectedChecks).toEqual(
      [...new Set(plan.findings.flatMap((item) => [...item.expectedChecks]))].sort(),
    );
  });

  it('keeps a receipt the reviewer cited, even when no criterion points at it', async () => {
    const { fixture, context } = await oneContext();
    const review = buildReviewDocument({
      runId: fixture.record.runId,
      baseSha: fixture.base,
      reviewedPatchIdentity: fixture.patch.identity,
      currentPatchIdentity: fixture.patch.identity,
      modelId: 'answered-model-id',
      reviewedAt: '2026-09-26T09:00:00.000Z',
      attempts: 1,
      body: {
        summary: 'One finding that names a receipt and no criterion.',
        findings: [
          reviewFindingBodySchema.parse({
            ...bodies(1, ['AC-1'])[0],
            criterionIds: [],
            contextRefs: [refTo(context, 'src/parse.ts'), receiptRef(context, 'VG-001')],
          }),
        ],
      },
      dispositions: [{ index: 0, disposition: 'VALID_REPAIR_CANDIDATE', reason: 'Checked.' }],
    });

    const plan = buildRepairPlan({
      record: recordWith(fixture.record, { review }),
      review,
      manifest: context.manifest,
      reviewCycle: 1,
      repairCycle: 1,
      createdAt: '2026-09-26T09:05:00.000Z',
    });

    expect(plan.findings[0]?.criterionIds).toEqual([]);
    expect(plan.findings[0]?.expectedChecks).toEqual(['VG-001']);
  });

  it('refuses a check that is a command string rather than an id', () => {
    expect(() => parseRepairPlan(frozen({ expectedChecks: ['npm test && rm -rf /'] }))).toThrow(
      /VG-/,
    );
  });

  it('refuses a file that would leave the repository', () => {
    const body = frozen({
      findings: [
        {
          findingId: 'RF-001',
          criterionIds: ['AC-1'],
          intendedChange: 'Change ../../etc/passwd so the reviewer’s claim holds.',
          expectedFiles: ['../../etc/passwd'],
          expectedChecks: [],
        },
      ],
      criteria: ['AC-1'],
      expectedFiles: ['../../etc/passwd'],
    });

    expect(() => parseRepairPlan(body)).toThrow(/repository-relative/);
  });

  it('has no key for authority it was never granted', () => {
    for (const key of ['command', 'shell', 'risk', 'allowRemote', 'delete', 'force']) {
      expect(() => parseRepairPlan(frozen({ [key]: true })), key).toThrow(/unrecognized key/i);
    }
  });

  it('refuses an item with no file, because there would be nothing to confine', () => {
    const body = frozen({
      findings: [
        {
          findingId: 'RF-001',
          criterionIds: ['AC-1'],
          intendedChange: 'Reconsider the architecture somewhere.',
          expectedFiles: [],
          expectedChecks: [],
        },
      ],
      criteria: ['AC-1'],
    });

    expect(() => parseRepairPlan(body)).toThrow(/file/i);
  });
});

describe.skipIf(!AVAILABLE)('how many findings one cycle may carry', () => {
  it(`stops at ${MAX_FINDINGS_PER_REPAIR}, because a repair of fifteen findings proves none of them`, async () => {
    const message = await refused({ count: MAX_FINDINGS_PER_REPAIR + 1 });

    expect(message).toMatch(new RegExp(String(MAX_FINDINGS_PER_REPAIR)));
  });

  it('cannot be told to carry more by a caller that asks', async () => {
    const message = await refused({
      count: MAX_FINDINGS_PER_REPAIR_CEILING + 1,
      limits: { maxFindingsPerRepair: 10_000 },
    });

    expect(message).toMatch(new RegExp(String(MAX_FINDINGS_PER_REPAIR_CEILING)));
  });

  it('keeps the cycles it was given, so a reader can see which round this was', async () => {
    const { plan } = await planned({ cycles: { reviewCycle: 2, repairCycle: 1 } });

    expect(plan.reviewCycle).toBe(2);
    expect(plan.repairCycle).toBe(1);
  });

  it('refuses a cycle number past the ceiling, rather than spinning quietly', async () => {
    const message = await refused({
      cycles: { reviewCycle: MAX_REVIEW_CYCLES_CEILING + 1, repairCycle: 1 },
    });

    expect(message).toMatch(new RegExp(String(MAX_REVIEW_CYCLES_CEILING)));
  });
});

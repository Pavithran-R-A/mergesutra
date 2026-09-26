import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../../src/report/pack.js';
import { buildReviewDocument, reviewBodySchema } from '../../src/review/schema.js';
import { REPAIR_PLAN_SCHEMA_VERSION, parseRepairPlan } from '../../src/repair/plan.js';
import { recordWith } from '../helpers/review.js';
import { cycleFor, frozenPlan, measuredPatch } from '../helpers/repair.js';
import { stubImplementation } from '../helpers/verifyRun.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { recordAt, verifiedRecord } from '../helpers/report.js';

/**
 * The evidence pack: three files a reviewer reads without running anything.
 *
 * Stage 8's discipline is that a report is a *rendering*. Every status,
 * sufficiency and exit code in here already sits in the run record, written
 * there by the stage that earned it, and the only judgement this module makes is
 * where to put it on the page. That is why the sharpest test is the first one: a
 * run that never verified must not be able to produce a pack that reads as
 * though it did.
 */

function packOf(record: RunRecord) {
  return buildEvidencePack(record);
}

describe('a pack for a run that never verified', () => {
  it('reports the criteria as they stand, with no verdict to over-read', () => {
    const pack = packOf(recordAt());

    expect(pack.files['report.md']).toContain('PENDING');
    expect(pack.files['report.md']).not.toMatch(/VERIFIED|\bPASS\b|contribution ready/i);
  });

  it('holds the absence of verification as a fact instead of an empty success', () => {
    const json = JSON.parse(packOf(recordAt()).files['report.json']) as Record<string, unknown>;

    expect(json.verification).toBeNull();
    expect(json.contributionReady).toBe(false);
  });

  it('attributes a criterion caveat to the contract that wrote it, not to a mapper that never ran', () => {
    // Before `verify` the rows are copied from the contract, so a qualifier
    // beside one of them is the contract's own words. Labelling it "from the
    // evidence mapper" would credit a document that has not run with a sentence
    // it never wrote — the same misattribution, one stage earlier.
    const record = recordAt();
    const caveat = record.acceptanceContract?.criteria[0]?.limitations[0] ?? '';
    expect(caveat).not.toBe('');

    const report = packOf(record).files['report.md'];
    const contractGroup = report.indexOf('Recorded with the Acceptance Contract');

    expect(report).not.toContain('From the evidence mapper');
    expect(contractGroup).toBeGreaterThan(-1);
    expect(report.indexOf(caveat)).toBeGreaterThan(contractGroup);
  });
});

describe('a pack for a run that verified', () => {
  it('carries the receipts as they were filed, one line per gate', async () => {
    const argv = ['node', '--test'];
    const pack = packOf(await verifiedRecord(argv));

    const lines = pack.files['commands.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      gateId: 'VG-001',
      argv,
      cwd: '.',
      result: 'PASS',
      exitCode: 0,
      termination: 'EXITED',
    });
  });

  it('quotes the recorded evidence instead of restating it in its own words', async () => {
    const argv = ['node', '--test'];
    const withRun = await verifiedRecord(argv);

    const json = JSON.parse(packOf(withRun).files['report.json']) as {
      evidence: unknown;
      verification: unknown;
      criteria: readonly { status: string; sufficiency: string; gateIds: readonly string[] }[];
    };

    expect(json.evidence).toEqual(withRun.evidence);
    expect(json.verification).toBe(withRun.verification?.result);
    expect(json.criteria).toEqual([
      {
        id: 'AC-1',
        statement: 'The suite passes.',
        status: 'PASS',
        sufficiency: 'VERIFIED',
        gateIds: ['VG-001'],
        limitations: withRun.evidence?.criteria[0]?.limitations ?? [],
      },
    ]);
  });

  it('shows the gate and the criterion it carried on the same page', async () => {
    const pack = packOf(await verifiedRecord(['node', '--test']));

    expect(pack.files['report.md']).toContain('node --test');
    expect(pack.files['report.md']).toContain('VG-001');
    expect(pack.files['report.md']).toContain('exit 0');
    expect(pack.files['report.md']).not.toMatch(/contribution ready/i);
  });

  it('carries the reason a green row is not trustworthy up to the table', async () => {
    // Implementation continued after the gates ran. The mapper marks the
    // receipts STALE; a pack that printed only the status would show green rows
    // for a patch those rows no longer describe.
    const moved = await verifiedRecord(['node', '--test'], {
      currentPatchIdentity: 'c'.repeat(64),
    });

    expect(moved.evidence?.notes.join(' ')).toMatch(/STALE/);
    expect(packOf(moved).files['report.md']).toMatch(/STALE/);
  });

  it('files what the model said as what the model said', async () => {
    // A reviewer is entitled to the loop's own account of its work, and a pack
    // that hides it is not more honest — it is just less checkable. So the claim
    // is printed, under a heading that says what it is, and never in the table.
    const claimed = await verifiedRecord(['node', '--test'], {
      claims: [{ source: 'FINISH', text: 'parseDate now rejects; the suite covers it.' }],
    });

    const report = packOf(claimed).files['report.md'];
    const criteriaSection = report.split('## Criteria')[1]?.split('\n## ')[0] ?? '';
    expect(criteriaSection).not.toContain('parseDate now rejects');
    expect(report).toMatch(/decided nothing/i);
    expect(report).toContain('the suite covers it');
  });

  it('says which document wrote each caveat, so a carried one is not re-asserted', async () => {
    // A run accumulates caveats: the contract stage writes one, the plan stage
    // carries it, the implement stage carries it again, and the verify record
    // holds all of them. Some of those lines were true of their own stage and
    // are simply false of a record whose rows now read VERIFIED. The pack may
    // not delete them — deciding which caveats a later stage answered is not a
    // renderer's job — but it must not reprint them as though this run said so.
    const carried = 'Nothing here is verified. No criterion changed status.';
    const withRun = await verifiedRecord(['node', '--test'], {
      currentPatchIdentity: 'c'.repeat(64),
      recordLimitations: [carried],
    });

    const report = packOf(withRun).files['report.md'];
    const at = (text: string) => report.indexOf(text);

    expect(at(carried)).toBeGreaterThan(-1);
    expect(at('Recorded by the stages of this run')).toBeGreaterThan(-1);
    expect(at(carried)).toBeGreaterThan(at('Recorded by the stages of this run'));
    // The mapper's own note about these receipts keeps its own attribution, so
    // the two kinds of caveat cannot be read as one undifferentiated list.
    expect(at('STALE')).toBeGreaterThan(-1);
    expect(at('STALE')).toBeLessThan(at('Recorded by the stages of this run'));
  });

  it('keeps the two provenances apart in the machine-readable file too', async () => {
    const carried = 'Nothing here is verified.';
    const withRun = await verifiedRecord(['node', '--test'], { recordLimitations: [carried] });

    const json = JSON.parse(packOf(withRun).files['report.json']) as {
      stageLimitations: readonly string[];
      contractLimitations: readonly string[];
    };

    expect(json.stageLimitations).toContain(carried);
    expect(json.contractLimitations).toEqual(withRun.acceptanceContract?.limitations ?? []);
  });
});

describe('which bytes a pack answers for', () => {
  /**
   * Stage 9's reason for existing is that a repair puts old evidence over new
   * bytes, and a reviewer cannot check that claim against a document that never
   * says which bytes it describes. So the pack prints the digest Stage 7
   * measured — copied from the record, with the engine's own precondition beside
   * it — and a reader with git can then settle the question themselves.
   */
  it('names the patch its receipts describe, in full', async () => {
    const withRun = await verifiedRecord(['node', '--test']);
    const planned = withRun.verificationPlan?.patchIdentity ?? '';

    expect(planned).toMatch(/^[0-9a-f]{64}$/);
    expect(packOf(withRun).files['report.md']).toContain(planned);
  });

  it("shows the observed digest and the engine's staleness on one line when the bytes moved", async () => {
    const observed = 'd'.repeat(64);
    const moved = await verifiedRecord(['node', '--test'], { observedPatchIdentity: observed });

    // The fixture must really have produced a stale precondition, or the
    // assertion below would only prove the renderer prints a word.
    expect(moved.verification?.patchPrecondition.status).toBe('STALE');
    expect(moved.verification?.patchPrecondition.observedIdentity).toBe(observed);

    const line = packOf(moved)
      .files['report.md'].split('\n')
      .find((entry) => entry.includes(observed));
    expect(line).toBeDefined();
    expect(line ?? '').toContain('STALE');
  });

  it('copies the identities into the machine-readable file instead of deriving others', async () => {
    const withRun = await verifiedRecord(['node', '--test']);

    const json = JSON.parse(packOf(withRun).files['report.json']) as {
      patch: {
        plannedIdentity: string;
        observedIdentity: string | null;
        precondition: string;
        baseSha: string;
      };
    };

    expect(json.patch).toEqual({
      plannedIdentity: withRun.verificationPlan?.patchIdentity ?? '',
      observedIdentity: withRun.verification?.patchPrecondition.observedIdentity ?? null,
      precondition: withRun.verification?.patchPrecondition.status ?? '',
      baseSha: withRun.verificationPlan?.baseSha ?? '',
    });
  });

  it('says a run that never verified has no pinned bytes, and names no digest', () => {
    const pack = packOf(recordAt());

    expect(pack.files['report.md']).toMatch(/no patch/i);
    expect(pack.files['report.md']).not.toMatch(/[0-9a-f]{64}/);
    const json = JSON.parse(pack.files['report.json']) as {
      patch: { plannedIdentity: string | null; precondition: string | null };
    };
    expect(json.patch.plannedIdentity).toBeNull();
    expect(json.patch.precondition).toBeNull();
  });
});

describe('a pack for a run that has been reviewed', () => {
  /**
   * Stage 9's answer to the temptation Stage 8 was built to resist: a green
   * table is not a reviewed diff. The review is printed because a reviewer is
   * entitled to see that a second pass read these bytes and what it said — and
   * printed as what it is, a model's reading with MergeSutra's dispositions
   * beside it, never as an approval.
   */
  const DIGEST = 'b'.repeat(64);

  async function reviewedRecord(
    overrides: Partial<Parameters<typeof buildReviewDocument>[0]> = {},
  ): Promise<RunRecord> {
    const base = await verifiedRecord(['node', '--test']);
    const findings = [
      {
        severity: 'HIGH',
        category: 'REQUIREMENT_GAP',
        statement: 'The parser still accepts the empty input AC-1 rejects.',
        impact: 'A caller gets a Date back where the criterion asks for an error.',
        evidence: 'src/parse.ts returns early on an empty string.',
        file: 'src/parse.ts',
        criterionIds: ['AC-1'],
        contextRefs: ['CTX-001'],
        proposedAction: 'Reject empty input before constructing a Date.',
      },
    ];
    const review = buildReviewDocument({
      runId: base.runId,
      baseSha: 'a'.repeat(40),
      reviewedPatchIdentity: DIGEST,
      currentPatchIdentity: DIGEST,
      modelId: 'answered-model-id',
      reviewedAt: '2026-09-26T09:00:00.000Z',
      attempts: 1,
      body: reviewBodySchema.parse({
        summary: 'One gap against AC-1.',
        findings,
      }),
      dispositions: [
        {
          index: 0,
          disposition: 'VALID_REPAIR_CANDIDATE',
          reason: 'Cited material MergeSutra checked, and names a file a repair can aim at.',
        },
      ],
      ...overrides,
    });

    return recordWith(base, { review, stage: 'review', outcome: 'REVIEW_RECORDED' });
  }

  it('prints the review against the patch it was made for', async () => {
    const reviewed = await reviewedRecord();
    const report = packOf(reviewed).files['report.md'];

    expect(report).toContain('## Review');
    const line = report
      .split('\n')
      .find((entry) => entry.includes(DIGEST) && /review/i.test(entry));
    expect(line).toBeDefined();
  });

  it('shows each finding with the disposition MergeSutra gave it, not one the model claimed', async () => {
    const reviewed = await reviewedRecord();
    const report = packOf(reviewed).files['report.md'];

    expect(report).toContain('RF-001');
    expect(report).toContain('HIGH');
    expect(report).toContain('VALID_REPAIR_CANDIDATE');
    expect(report).toContain('Reject empty input before constructing a Date.');
  });

  it('labels the review as a reading that decided nothing, and never as an approval', async () => {
    const report = packOf(await reviewedRecord()).files['report.md'];

    expect(report).toMatch(/a claim|decided nothing|not a verdict|reading/i);
    expect(report).not.toMatch(
      /AI APPROVED|approved by the model|review passed|CONTRIBUTION_READY/i,
    );
  });

  it('says a STALE review describes bytes that are gone, in the review’s own line', async () => {
    const moved = await reviewedRecord({ currentPatchIdentity: 'e'.repeat(64) });

    expect(moved.review?.patchPrecondition.status).toBe('STALE');
    const report = packOf(moved).files['report.md'];
    const line = report.split('\n').find((entry) => entry.includes('e'.repeat(64)));
    expect(line).toBeDefined();
    expect(line ?? '').toContain('STALE');
  });

  it('does not describe a review that never happened', async () => {
    const report = packOf(await verifiedRecord(['node', '--test'])).files['report.md'];

    expect(report).not.toContain('## Review');
    expect(report).toMatch(/review: none/i);
    expect(report).not.toMatch(/no defects|looks correct/i);
  });

  it('carries the frozen repair plan when one exists, as a scope and nothing else', async () => {
    const reviewed = await reviewedRecord();
    const plan = parseRepairPlan({
      schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
      runId: reviewed.runId,
      reviewCycle: 1,
      repairCycle: 1,
      reviewedPatchIdentity: DIGEST,
      findings: [
        {
          findingId: 'RF-001',
          criterionIds: ['AC-1'],
          intendedChange: 'Reject empty input before constructing a Date.',
          expectedFiles: ['src/parse.ts'],
          expectedChecks: ['VG-001'],
        },
      ],
      criteria: ['AC-1'],
      expectedFiles: ['src/parse.ts'],
      expectedChecks: ['VG-001'],
      createdAt: '2026-09-26T09:05:00.000Z',
    });
    const withPlan = recordWith(reviewed, { repairPlan: plan });

    const report = packOf(withPlan).files['report.md'];
    expect(report).toContain('src/parse.ts');
    expect(report).toContain('VG-001');
    expect(report).toMatch(/before any edit|frozen before|work order/i);

    const json = JSON.parse(packOf(withPlan).files['report.json']) as { repairPlan: unknown };
    expect(json.repairPlan).toEqual(plan);
  });

  it('lets a repaired patch disprove the pack that came before it, by naming both digests', async () => {
    const reviewed = await reviewedRecord();
    const pack = packOf(reviewed);

    expect(pack.files['report.md']).toContain(DIGEST);
    expect(pack.files['report.md']).not.toContain('e'.repeat(64));
  });
});

describe('a pack regenerated after a repair cycle', () => {
  /**
   * §19's requirement, and the reason Stage 8's renderer has to change at all.
   *
   * Once a repair has run, the pack is no longer a description of one patch. It
   * holds receipts measured against patch A and a plan written against those same
   * bytes, and the workspace is now on B — so the same table that was honest an
   * hour ago is now silently false. Printing the cycles is the minimum that keeps
   * the pack truthful: which bytes each row describes, which cycle moved them, and
   * the plain statement that the earlier evidence went stale *because* of that
   * move. What the section may not do is read as an outcome; a repair is a thing
   * that happened to files, and the only answer to whether it worked is the
   * re-verification, which is a different set of rows.
   */
  const BASE = 'a'.repeat(40);
  const AT = '2026-09-26T09:05:00.000Z';

  async function cycle(how: 'moved' | 'unchanged' | 'moved-and-reverified') {
    const verified = await verifiedRecord(['node', '--test']);
    const before = measuredPatch(
      [['src/parse.ts', 'export const PARSED = 1;\n', 'MODIFIED']],
      BASE,
    );
    const after =
      how === 'unchanged'
        ? before
        : measuredPatch([['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED']], BASE);
    const plan = frozenPlan({
      runId: verified.runId,
      criteria: ['AC-1'],
      patchIdentity: before.identity,
      expectedChecks: ['VG-001'],
      createdAt: AT,
    });
    const execution = cycleFor({
      plan,
      patch: before.description,
      patchAfter: after.description,
      implementation: stubImplementation(verified, ['AC-1'], BASE),
      createdAt: AT,
    });
    const carried = {
      stage: 'repair',
      outcome: 'REPAIR_APPLIED',
      repairPlan: plan,
      repairExecutions: [execution],
    } as const;

    return {
      before,
      after,
      execution,
      record: recordWith(verified, {
        // A pack regenerated *after* the re-verification carries receipts measured
        // on B, so its rows describe the current bytes and the cycle that produced
        // them is history, not a live defect in the evidence above.
        ...(how === 'moved-and-reverified'
          ? { evidence: { ...verified.evidence!, patchIdentity: after.identity } }
          : {}),
        ...carried,
      }),
    };
  }

  /**
   * The cycles section on its own, because a digest appears in the plan section
   * too and a test that scans the whole page cannot tell the two apart.
   */
  function cyclesOf(report: string): string {
    const start = report.indexOf('## Repair cycles');
    expect(start, report).toBeGreaterThan(-1);
    const rest = report.slice(start);
    const end = rest.indexOf('\n## ', 1);
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('names both the patch the review read and the patch the repair left', async () => {
    const { before, after, record } = await cycle('moved');

    const cycles = cyclesOf(packOf(record).files['report.md']);
    expect(before.identity).not.toBe(after.identity);
    expect(cycles).toContain(before.identity);
    expect(cycles).toContain(after.identity);
  });

  it('says which cycle it was, and to which frozen plan that cycle answered', async () => {
    const { execution, record } = await cycle('moved');
    const cycles = cyclesOf(packOf(record).files['report.md']);

    expect(execution.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(cycles).toContain(execution.planDigest);
    expect(cycles).toMatch(/repair cycle 1/i);
  });

  it('says the earlier receipts are stale because this cycle moved bytes, in the cycle’s own line', async () => {
    const { before, record } = await cycle('moved');
    const line = cyclesOf(packOf(record).files['report.md'])
      .split('\n')
      .find((entry) => entry.includes(before.identity));

    expect(line).toBeDefined();
    expect(line ?? '').toMatch(/stale/i);
  });

  it('does not call a cycle that changed nothing a reason to distrust the evidence', async () => {
    const { before, record, execution } = await cycle('unchanged');
    const line = cyclesOf(packOf(record).files['report.md'])
      .split('\n')
      .find((entry) => entry.includes(before.identity));

    expect(execution.scope.outcome).toBe('REPAIR_LEFT_NO_TRACE');
    expect(line).toBeDefined();
    expect(line ?? '').not.toMatch(/stale/i);
    expect(line ?? '').toMatch(/unchanged|no bytes|left the patch/i);
  });

  it('stops calling the rows stale once a re-verification has measured the new bytes', async () => {
    const { after, record } = await cycle('moved-and-reverified');
    const cycles = cyclesOf(packOf(record).files['report.md']);
    const line = cycles.split('\n').find((entry) => entry.includes(after.identity));

    expect(line).toBeDefined();
    expect(line ?? '').not.toMatch(/stale/i);
    expect(line ?? '').toMatch(/measured (again|on these bytes)|current/i);
  });

  it('prints what the cycle reported about its own scope, and not whether it worked', async () => {
    const { execution, record } = await cycle('moved');
    const report = packOf(record).files['report.md'];
    const cycles = cyclesOf(report);

    expect(execution.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');
    expect(cycles).toContain('WITHIN_PLANNED_SCOPE');
    expect(report).not.toMatch(/repair (succeeded|complete|passed|fixed)/i);
    expect(report).not.toMatch(/CONTRIBUTION_READY|AI APPROVED/i);
  });

  it('carries the executions in report.json so a machine can order them', async () => {
    const { execution, record } = await cycle('moved');
    const json = JSON.parse(packOf(record).files['report.json']) as {
      repairExecutions: unknown[];
      contributionReady: boolean;
    };

    expect(json.repairExecutions).toEqual([execution]);
    expect(json.contributionReady).toBe(false);
  });

  it('says nothing about repair when no cycle ran, rather than an empty section', async () => {
    const report = packOf(await verifiedRecord(['node', '--test'])).files['report.md'];

    expect(report).not.toContain('## Repair cycles');
    expect(report).not.toMatch(/no repairs were needed|nothing to repair/i);
  });
});

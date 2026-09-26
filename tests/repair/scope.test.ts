import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/security/digest.js';
import {
  describePatch,
  patchDescriptionSchema,
  type PatchDescription,
} from '../../src/verify/patch.js';
import {
  REPAIR_SCOPE_SCHEMA_VERSION,
  classifyRepairScope,
  routeRepairScope,
  type RepairScopeDelta,
} from '../../src/repair/scope.js';
import {
  REPAIR_PLAN_SCHEMA_VERSION,
  parseRepairPlan,
  type RepairPlan,
} from '../../src/repair/plan.js';
import { cleanUp, hasGit, reviewFixture, type ReviewFixture } from '../helpers/review.js';

/**
 * What the repair actually touched — Stage 9's scope guard.
 *
 * A repair cycle ends with a workspace and a story. The story is the plan; the
 * workspace is the fact, and only the second one gets re-verified. This module
 * compares them and writes down the difference, which is the step that makes a
 * "while I'm here" refactor visible instead of folded into the diff a reviewer
 * then has to re-read by hand.
 *
 * The comparison is a delta, not a file list. Every file in the reviewed patch is
 * still in the repaired patch — that is what a repair on top of a contribution
 * looks like — so calling the whole final diff "what the repair did" would blame
 * the repair for the contribution, and would hide the one file it added that
 * nobody planned. Only bytes that moved between the two measurements count as the
 * repair's, and a file that moved without being in the plan is reported, not
 * removed: the guard has no writer, no deleter and no field that can say PASS.
 *
 * The routing rule beside it is what stops "the tests still pass" from closing the
 * loop: an out-of-scope repair goes to a human, and a repair that left no trace
 * goes to a human too, because a cycle that reported work it did not do is not
 * evidence of anything.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

const BASE = 'b'.repeat(40);

/** A patch measured from disk would carry a digest of its own bytes; this is one. */
function described(files: readonly [string, string, 'ADDED' | 'MODIFIED' | 'DELETED'][]): {
  description: PatchDescription;
  identity: string;
} {
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
      baseSha: BASE,
      identity,
      files: facts,
    }),
    identity,
  };
}

function planFor(expectedFiles: readonly string[], reviewedPatchIdentity: string): RepairPlan {
  const [first, ...rest] = expectedFiles;
  if (!first) throw new Error('a plan with no file to change is not a plan');
  return parseRepairPlan({
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: 'run-20260926t090000z-repair1',
    reviewCycle: 1,
    repairCycle: 1,
    reviewedPatchIdentity,
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: ['AC-1'],
        intendedChange: 'Handle the leap-year case the criterion names.',
        expectedFiles: [first, ...rest],
        expectedChecks: ['VG-001'],
      },
    ],
    criteria: ['AC-1'],
    expectedFiles: [...expectedFiles],
    expectedChecks: ['VG-001'],
    createdAt: '2026-09-26T09:00:00.000Z',
  });
}

/** The contribution under review: two files Stage 6 wrote and one it deleted. */
function patchA() {
  return described([
    ['src/parse.ts', 'export const PARSED = 1;\n', 'MODIFIED'],
    ['README.md', 'old readme\n', 'DELETED'],
  ]);
}

function classify(
  plan: RepairPlan,
  before: PatchDescription,
  after: PatchDescription,
): RepairScopeDelta {
  return classifyRepairScope({ plan, patchBefore: before, patchAfter: after });
}

describe.skipIf(!AVAILABLE)('a repair that stayed inside its plan', () => {
  it('calls the file the plan named the repair’s own', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(delta.schemaVersion).toBe(REPAIR_SCOPE_SCHEMA_VERSION);
    expect(delta.patchChanged).toBe(true);
    // Every measurement lists the same paths in the same order, so two readers of
    // one delta see one document rather than an accident of git's output.
    expect(delta.files).toEqual([
      {
        path: 'README.md',
        delta: 'UNCHANGED',
        classification: 'PRE_EXISTING_PATCH_FILE',
      },
      {
        path: 'src/parse.ts',
        delta: 'CHANGED_BY_REPAIR',
        classification: 'EXPECTED',
      },
    ]);
    expect(delta.outcome).toBe('WITHIN_PLANNED_SCOPE');
    expect(delta.unexpectedFiles).toEqual([]);
  });

  it('counts the omitted contextual file the plan added as planned work', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts', 'src/calendar.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 1;\n', 'MODIFIED'],
      ['src/calendar.ts', 'export const LEAP_NOTES = 1;\n', 'ADDED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    const added = delta.files.find((file) => file.path === 'src/calendar.ts');
    expect(added).toEqual({
      path: 'src/calendar.ts',
      delta: 'ADDED_BY_REPAIR',
      classification: 'EXPECTED',
    });
    expect(delta.outcome).toBe('WITHIN_PLANNED_SCOPE');
    expect(delta.unexpectedFiles).toEqual([]);
  });

  it('says which planned file the repair never touched', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts', 'src/calendar.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(delta.plannedButUntouchedFiles).toEqual(['src/calendar.ts']);
  });

  it('reports the patch it measured by identity, so a reader can re-derive it', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(delta.reviewedPatchIdentity).toBe(a.identity);
    expect(delta.repairPatchIdentity).toBe(b.identity);
  });
});

describe.skipIf(!AVAILABLE)('a repair that reached outside its plan', () => {
  it('flags a file no finding named, and keeps it in the patch', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['src/utils/format.ts', 'export const SHINY = 1;\n', 'ADDED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(delta.files.find((f) => f.path === 'src/utils/format.ts')).toEqual({
      path: 'src/utils/format.ts',
      delta: 'ADDED_BY_REPAIR',
      classification: 'UNEXPECTED',
    });
    expect(delta.unexpectedFiles).toEqual(['src/utils/format.ts']);
    expect(delta.outcome).toBe('OUTSIDE_PLANNED_SCOPE');
  });

  it('does not report the original patch files as the repair’s additions', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(delta.unexpectedFiles).toEqual([]);
    expect(delta.files.filter((file) => file.classification === 'PRE_EXISTING_PATCH_FILE')).toEqual(
      [expect.objectContaining({ path: 'README.md' })],
    );
  });

  it('counts a change the repair reverted as its own, unplanned work', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED']]);

    const delta = classify(plan, a.description, b.description);

    expect(delta.files.find((f) => f.path === 'README.md')).toEqual({
      path: 'README.md',
      delta: 'REMOVED_BY_REPAIR',
      classification: 'UNEXPECTED',
    });
    expect(delta.outcome).toBe('OUTSIDE_PLANNED_SCOPE');
  });

  it('has no field anywhere that could be read as a verdict', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['src/utils/format.ts', 'export const SHINY = 1;\n', 'ADDED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const text = JSON.stringify(classify(plan, a.description, b.description));

    for (const word of [
      'PASS',
      'FAIL',
      'CONTRIBUTION_READY',
      'VERIFIED',
      'AI APPROVED',
      'accepted',
      'deleted',
    ]) {
      expect(text.toLowerCase().includes(word.toLowerCase()), word).toBe(false);
    }
  });
});

describe.skipIf(!AVAILABLE)('a repair that changed nothing', () => {
  it('says so, rather than reporting a clean repair', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);

    const delta = classify(plan, a.description, a.description);

    expect(delta.patchChanged).toBe(false);
    expect(delta.outcome).toBe('REPAIR_LEFT_NO_TRACE');
    expect(delta.files.every((file) => file.delta === 'UNCHANGED')).toBe(true);
    expect(delta.plannedButUntouchedFiles).toEqual(['src/parse.ts']);
  });
});

describe.skipIf(!AVAILABLE)('what a delta may be used for', () => {
  it('sends an out-of-scope repair to a human, not to re-verification', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['docs/EXTRA.md', 'while I am here\n', 'ADDED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(routeRepairScope(delta)).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('sends a repair that left no trace to a human too', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);

    const delta = classify(plan, a.description, a.description);

    expect(routeRepairScope(delta)).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('sends a within-scope repair back through Stage 7, which is the only judge', () => {
    const a = patchA();
    const plan = planFor(['src/parse.ts'], a.identity);
    const b = described([
      ['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED'],
      ['README.md', 'old readme\n', 'DELETED'],
    ]);

    const delta = classify(plan, a.description, b.description);

    expect(routeRepairScope(delta)).toBe('REVERIFY_THROUGH_STAGE_7');
  });

  it('refuses to judge a repair against bytes the plan never described', () => {
    const a = patchA();
    const other = described([['src/elsewhere.ts', 'export const X = 1;\n', 'MODIFIED']]);
    const plan = planFor(['src/parse.ts'], a.identity);

    const error = capture(() => classify(plan, other.description, a.description));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/plan was frozen|describes a different patch/i);
  });

  it('refuses two measurements of different bases, which are not the same patch', () => {
    const a = patchA();
    const b = described([['src/parse.ts', 'export const PARSED = 2;\n', 'MODIFIED']]);
    const plan = planFor(['src/parse.ts'], a.identity);
    const moved = patchDescriptionSchema.parse({ ...b.description, baseSha: 'c'.repeat(40) });

    const error = capture(() => classify(plan, a.description, moved));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/base/i);
  });
});

let prepared: Promise<ReviewFixture> | null = null;
function fixtureOnce(): Promise<ReviewFixture> {
  prepared ??= reviewFixture(made);
  return prepared;
}

describe.skipIf(!AVAILABLE)('a repair measured from a real workspace', () => {
  it('classifies what git says changed, with no hand-written descriptions', async () => {
    const fixture = await fixtureOnce();
    const plan = planFor(['src/parse.ts'], fixture.patch.identity);

    const untouched = classify(plan, fixture.patch, fixture.patch);
    expect(untouched.outcome).toBe('REPAIR_LEFT_NO_TRACE');

    await writeFile(path.join(fixture.workspace, 'src/parse.ts'), 'export const PARSED = 7;\n');
    const after = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });

    const delta = classify(plan, fixture.patch, after);

    expect(delta.patchChanged).toBe(true);
    expect(delta.outcome).toBe('WITHIN_PLANNED_SCOPE');
    expect(delta.files.filter((f) => f.classification === 'EXPECTED').map((f) => f.path)).toEqual([
      'src/parse.ts',
    ]);
    expect(delta.files.filter((f) => f.classification === 'UNEXPECTED')).toEqual([]);
    // Every other file the contribution touched is still the contribution's.
    expect(delta.files.filter((f) => f.delta === 'UNCHANGED').length).toBeGreaterThan(1);
  });
});

function capture(action: () => unknown): AppError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error('expected the comparison to be refused');
  return thrown as AppError;
}

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppError } from '../../src/core/errors.js';
import {
  RUN_SCHEMA_VERSION,
  RUN_SCHEMA_VERSIONS_SUPPORTED,
  parseRunRecord,
  type RunRecord,
} from '../../src/state/run-record.js';
import { createFileRunStore } from '../../src/state/run-store.js';
import { buildReviewDocument } from '../../src/review/schema.js';
import { assembleReviewContext } from '../../src/review/context.js';
import {
  REPAIR_PLAN_SCHEMA_VERSION,
  parseRepairPlan,
  type RepairPlan,
} from '../../src/repair/plan.js';
import {
  cleanUp,
  hasGit,
  recordWith,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * Reading what an older MergeSutra wrote — the compatibility rule.
 *
 * This product's whole promise is that a later stage can pick up a run from the
 * evidence on disk, so a version bump that makes earlier records unreadable would
 * destroy the thing it ships. The rule tested here is narrow on purpose: the
 * parser accepts the versions this build supports, migrates them in memory by
 * filling in what Stage 9 has *not* done yet, and refuses anything else with the
 * error it has always given.
 *
 * The part that matters most is what migration may not do. A v6 record has no
 * review and no frozen repair plan, so the migrated record has both as null —
 * not an empty review, not a plan with zero items, and above nothing that could
 * be read downstream as "it was checked". Null is the honest value for "this
 * stage never ran", and the tests below are what keep it that way.
 *
 * And a read is a read: opening an old file must not quietly rewrite it in the
 * current version, because then the file a human audited would no longer be the
 * file the run wrote.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

let fixture: ReviewFixture;

beforeAll(async () => {
  if (!AVAILABLE) return;
  fixture = await reviewFixture(made);
});

/**
 * The same document as its author wrote it: v6 had no Stage 9 field at all.
 *
 * Stage 9's review and its frozen repair plan are both stripped here, which is
 * what a real v6 file looks like: it has no key for either, rather than a key
 * holding null.
 */
function asV6(record: RunRecord): Record<string, unknown> {
  const { schemaVersion: _version, review: _review, repairPlan: _plan, ...rest } = record;
  return { schemaVersion: 6, ...rest };
}

function fieldsOf(value: Record<string, unknown>): Record<string, unknown> {
  const { schemaVersion: _version, ...rest } = value;
  return rest;
}

/**
 * A work order exactly as Stage 9 freezes one.
 *
 * It is built through the repair plan's own parser rather than written as a
 * literal, so this file cannot pass by loosening the record while the schema
 * behind the plan drifts. The ids are the fixture's: the file is one the reviewed
 * patch touched, the gate is one the run already has a receipt for.
 */
function frozenPlan(overrides: Record<string, unknown> = {}): RepairPlan {
  const criterion = fixture.criteria[0];
  if (!criterion) throw new Error('the review fixture must carry a criterion');
  return parseRepairPlan({
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: fixture.record.runId,
    reviewCycle: 1,
    repairCycle: 1,
    reviewedPatchIdentity: fixture.patch.identity,
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: [criterion],
        intendedChange: 'Give the parser the branch the criterion asks for.',
        expectedFiles: ['src/parse.ts'],
        expectedChecks: ['VG-001'],
      },
    ],
    criteria: [criterion],
    expectedFiles: ['src/parse.ts'],
    expectedChecks: ['VG-001'],
    createdAt: '2026-09-26T09:30:00.000Z',
    ...overrides,
  });
}

describe.skipIf(!AVAILABLE)('a run record written by the previous version', () => {
  it('loads a real Stage 8 record and calls it the current version', () => {
    const migrated = parseRunRecord(asV6(fixture.record));

    expect(RUN_SCHEMA_VERSION).toBeGreaterThan(6);
    expect(migrated.schemaVersion).toBe(RUN_SCHEMA_VERSION);
  });

  it('gives it no review and no repair plan, because neither happened', () => {
    const migrated = parseRunRecord(asV6(fixture.record));

    expect(migrated.review).toBeNull();
    expect(migrated.repairPlan).toBeNull();
  });

  it('carries every field the old record held, unchanged', () => {
    const original = asV6(fixture.record);
    const migrated = parseRunRecord(asV6(fixture.record));
    const carried = fieldsOf(migrated as unknown as Record<string, unknown>);

    for (const [key, value] of Object.entries(fieldsOf(original))) {
      expect(carried[key], key).toEqual(value);
    }
  });

  it('invents no verdict, disposition or receipt on the way in', () => {
    const text = JSON.stringify(parseRunRecord(asV6(fixture.record)));

    for (const word of [
      'CONTRIBUTION_READY',
      'VALID_REPAIR_CANDIDATE',
      'VERIFICATION_PASS',
      'AI APPROVED',
    ]) {
      expect(text.includes(word), word).toBe(word === 'VERIFICATION_PASS');
    }
    expect(parseRunRecord(asV6(fixture.record)).outcome).toBe(fixture.record.outcome);
  });

  it('is still readable by Stage 9, which is the point of keeping it readable', async () => {
    const migrated = parseRunRecord(asV6(fixture.record));

    const context = await assembleReviewContext({
      record: migrated,
      workspace: fixture.workspace,
      patch: fixture.patch,
    });

    expect(context.manifest.references.length).toBeGreaterThan(0);
    expect(context.manifest.reviewedPatchIdentity).toBe(fixture.patch.identity);
  });
});

describe.skipIf(!AVAILABLE)('the current version, and versions nobody knows', () => {
  it('round-trips a record that has a Stage 9 review in it', () => {
    const current = recordWith(fixture.record, {
      review: buildReviewDocument({
        runId: fixture.record.runId,
        baseSha: fixture.base,
        reviewedPatchIdentity: fixture.patch.identity,
        currentPatchIdentity: fixture.patch.identity,
        modelId: 'answered-model-id',
        reviewedAt: '2026-09-26T09:00:00.000Z',
        attempts: 1,
        body: { summary: 'Nothing to report on these bytes.', findings: [] },
        dispositions: [],
      }),
    });

    expect(parseRunRecord(JSON.parse(JSON.stringify(current)))).toEqual(current);
  });

  it('round-trips a record that carries the repair plan it froze', () => {
    const current = recordWith(fixture.record, { repairPlan: frozenPlan() });

    const loaded = parseRunRecord(JSON.parse(JSON.stringify(current)));

    expect(loaded.repairPlan).toEqual(current.repairPlan);
    expect(loaded.repairPlan?.reviewedPatchIdentity).toBe(fixture.patch.identity);
  });

  it('gives a record that never planned a repair no plan, not an empty one', () => {
    const { repairPlan: _plan, ...without } = recordWith(fixture.record, {
      repairPlan: frozenPlan(),
    });

    const loaded = parseRunRecord(without);

    expect(loaded.repairPlan).toBeNull();
    expect(loaded.review).toBeNull();
  });

  it('refuses a repair plan the repair plan schema itself refuses', () => {
    const smuggled = {
      ...fixture.record,
      repairPlan: { ...frozenPlan(), expectedChecks: ['npm test && rm -rf .'] },
    };

    const error = capture(() => parseRunRecord(smuggled));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/VG-\d{3}|gate id/i);
  });

  it('refuses a version from before the supported window, and says which one', () => {
    const old = { ...asV6(fixture.record), schemaVersion: 5 };
    const error = capture(() => parseRunRecord(old));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/version 5|schemaVersion/i);
    expect(RUN_SCHEMA_VERSIONS_SUPPORTED).toContain(6);
  });

  it('refuses a future version rather than guessing what it meant', () => {
    for (const version of [8, 99, 'six', null]) {
      const error = capture(() =>
        parseRunRecord({ ...asV6(fixture.record), schemaVersion: version }),
      );
      expect(error.kind, JSON.stringify(version)).toBe('validation');
      expect(error.message).toMatch(/not readable|version/i);
    }
  });

  it('refuses a record with no version at all', () => {
    const { schemaVersion: _version, ...rest } = asV6(fixture.record);
    expect(capture(() => parseRunRecord(rest)).kind).toBe('validation');
  });

  it('still refuses a malformed v6 document instead of migrating past the damage', () => {
    const missing = { ...asV6(fixture.record) };
    delete missing['createdAt'];
    expect(capture(() => parseRunRecord(missing)).kind).toBe('validation');

    const impossible = { ...asV6(fixture.record), outcome: 'ALMOST_READY' };
    expect(capture(() => parseRunRecord(impossible)).kind).toBe('validation');
  });

  it('will not accept a v6 field that v6 never had', () => {
    const smuggled = { ...asV6(fixture.record), review: { findings: [] } };
    expect(capture(() => parseRunRecord(smuggled)).kind).toBe('validation');
  });
});

describe.skipIf(!AVAILABLE)('what the store does to an old file', () => {
  const runsDirectory = async (prefix: string): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    made.push(root);
    return path.join(root, 'runs');
  };

  it('reads a v6 record without rewriting the bytes on disk', async () => {
    const runs = await runsDirectory('mergesutra-v6-');
    const store = createFileRunStore(runs);
    const text = JSON.stringify(asV6(fixture.record), null, 2) + '\n';
    const file = await seedRunFile(runs, fixture.record.runId, text);

    const loaded = await store.load(fixture.record.runId);

    expect(loaded.schemaVersion).toBe(RUN_SCHEMA_VERSION);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('lists an old record rather than reporting it unreadable', async () => {
    const runs = await runsDirectory('mergesutra-v6-list-');
    const store = createFileRunStore(runs);
    await seedRunFile(runs, fixture.record.runId, JSON.stringify(asV6(fixture.record)));

    const listed = await store.list();

    expect(listed.unreadable).toEqual([]);
    expect(listed.runs.map((run) => run.runId)).toEqual([fixture.record.runId]);
  });

  it('writes the current version when a stage legitimately saves Stage 9 state', async () => {
    const runs = await runsDirectory('mergesutra-v7-');
    const store = createFileRunStore(runs);
    const reviewed = recordWith(fixture.record, {
      review: buildReviewDocument({
        runId: fixture.record.runId,
        baseSha: fixture.base,
        reviewedPatchIdentity: fixture.patch.identity,
        currentPatchIdentity: fixture.patch.identity,
        modelId: 'answered-model-id',
        reviewedAt: '2026-09-26T09:00:00.000Z',
        attempts: 1,
        body: { summary: 'Nothing to report on these bytes.', findings: [] },
        dispositions: [],
      }),
    });

    const file = await store.save(reviewed);
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number };

    expect(onDisk.schemaVersion).toBe(RUN_SCHEMA_VERSION);
    expect((await store.load(reviewed.runId)).review?.findings).toEqual([]);
  });

  it('keeps a frozen plan readable as the same document a later cycle would obey', async () => {
    const runs = await runsDirectory('mergesutra-plan-');
    const store = createFileRunStore(runs);
    const planned = recordWith(fixture.record, { repairPlan: frozenPlan() });

    await store.save(planned);
    const loaded = await store.load(planned.runId);

    expect(loaded.repairPlan).toEqual(planned.repairPlan);
    expect(loaded.repairPlan?.findings.map((finding) => finding.expectedFiles)).toEqual([
      ['src/parse.ts'],
    ]);
  });

  it('migrates on the way in without touching the file a human already audited', async () => {
    const runs = await runsDirectory('mergesutra-v6-copy-');
    const store = createFileRunStore(runs);
    const file = await seedRunFile(
      runs,
      fixture.record.runId,
      JSON.stringify(asV6(fixture.record)),
    );
    const before = await readFile(file, 'utf8');

    await store.load(fixture.record.runId);
    await store.list();

    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

/** A file written by hand, the way Stage 8 left records, with no directory behind it. */
async function seedRunFile(directory: string, runId: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${runId}.json`);
  await writeFile(file, text);
  return file;
}

function capture(action: () => unknown): AppError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error('expected the record to be refused');
  return thrown as AppError;
}

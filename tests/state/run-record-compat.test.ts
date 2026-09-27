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
import { buildRepairExecution, type RepairExecution } from '../../src/repair/execution.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { approveRepairPlan } from '../../src/repair/consent.js';
import { approvePublication } from '../../src/pr/approval.js';
import { candidateOf } from '../../src/pr/candidate.js';
import { buildPublicationRecord, type PublicationRecord } from '../../src/pr/record.js';
import { candidateInput, OTHER_PATCH_IDENTITY } from '../helpers/publication.js';
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
 * filling in what this build has *not* done yet, and refuses anything else with the
 * error it has always given.
 *
 * The part that matters most is what migration may not do. A v6 record has no
 * review and no frozen repair plan, so the migrated record has both as null —
 * not an empty review, not a plan with zero items, and above nothing that could
 * be read downstream as "it was checked". A v7 record has never run a repair
 * cycle, so its execution list is empty rather than populated with a plausible
 * cycle. A v8 record has never been put in front of a human as a pull request
 * proposal, so its publication list is empty too — and a candidate that was
 * proposed but not approved stays absent rather than arriving with a yes that
 * nobody gave. Null is the honest value for "this stage never ran", and the tests
 * below are what keep it that way.
 *
 * Keeping the older shapes strict is the other half of the rule: a v7 file that
 * smuggles in v8's execution list, or claims v8's `repair` stage, is refused as the
 * version it says it is rather than upgraded on trust — and the same holds for a v8
 * file that carries v9's publications or claims v9's `pr` stage.
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
 * Stage 9's review, its frozen repair plan, Stage 9R's execution list and Stage 10's
 * publications are all stripped here, which is what a real v6 file looks like: it has
 * no key for any of them, rather than a key holding null or an empty list.
 */
function asV6(record: RunRecord): Record<string, unknown> {
  const {
    schemaVersion: _version,
    review: _review,
    repairPlan: _plan,
    repairExecutions: _executions,
    publications: _publications,
    ...rest
  } = record;
  return { schemaVersion: 6, ...rest };
}

/** A v7 file: Stage 9 had run, and no repair cycle had. */
function asV7(record: RunRecord): Record<string, unknown> {
  const {
    schemaVersion: _version,
    repairExecutions: _executions,
    publications: _publications,
    ...rest
  } = record;
  return { schemaVersion: 7, ...rest };
}

/**
 * A v8 file: a repair cycle had been recorded, and no candidate had been assembled.
 *
 * Stage 10's publications are stripped the way Stage 9's review was: an old file has
 * no key for them at all, rather than a key holding an empty list.
 */
function asV8(record: RunRecord): Record<string, unknown> {
  const { schemaVersion: _version, publications: _publications, ...rest } = record;
  return { schemaVersion: 8, ...rest };
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

/**
 * One cycle's record, built the way a repair stage builds it.
 *
 * Both measurements are the fixture's own patch, which makes this a cycle that
 * changed nothing — the honest thing to store in a version test, because a changed
 * patch would mean hand-writing a measurement this file never took. Whether the
 * cycle achieved anything is a different test's business; this one is about whether
 * the record can hold the document at all.
 */
function executionFor(record: RunRecord, overrides: Record<string, unknown> = {}): RepairExecution {
  const implementation = record.implementation;
  if (!implementation) throw new Error('the review fixture must carry an implementation record');
  const plan = frozenPlan(overrides);
  return buildRepairExecution({
    plan,
    approval: approveRepairPlan({ plan, approvedAt: '2026-09-26T09:35:00.000Z' }),
    patchBefore: fixture.patch,
    patchAfter: fixture.patch,
    implementation,
    createdAt: '2026-09-26T09:40:00.000Z',
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
    expect(migrated.repairExecutions).toEqual([]);
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

/**
 * A v7 record, seen by a build that has run a repair cycle.
 *
 * Stage 9R's whole storage question is whether a run that was reviewed by an older
 * MergeSutra can still be repaired by this one, so this group is the same
 * discipline as the v6 one with one thing added: a migrated record gets an *empty*
 * execution list, never a plausible-looking one. A v7 file has no evidence that any
 * cycle ran, and an invented entry would attribute writes to a run that never made
 * them — including, potentially, to a patch nobody approved.
 */
describe.skipIf(!AVAILABLE)('a run record written by version 7', () => {
  it('loads a real Stage 9 record and calls it the current version', () => {
    const migrated = parseRunRecord(asV7(fixture.record));

    expect(RUN_SCHEMA_VERSION).toBeGreaterThan(7);
    expect(migrated.schemaVersion).toBe(RUN_SCHEMA_VERSION);
  });

  it('gives it no repair executions, because no cycle ever ran', () => {
    const migrated = parseRunRecord(asV7(fixture.record));

    expect(migrated.review).toEqual(fixture.record.review);
    expect(migrated.repairExecutions).toEqual([]);
  });

  it('carries every field the v7 record held, unchanged', () => {
    const original = asV7(fixture.record);
    const carried = fieldsOf(parseRunRecord(original) as unknown as Record<string, unknown>);

    for (const [key, value] of Object.entries(fieldsOf(original))) {
      expect(carried[key], key).toEqual(value);
    }
  });

  it('invents no cycle, consent or verdict on the way in', () => {
    const migrated = parseRunRecord(asV7(fixture.record));

    expect(migrated.stage).toBe(fixture.record.stage);
    expect(migrated.outcome).toBe(fixture.record.outcome);
    expect(JSON.stringify(migrated)).not.toMatch(
      /REPAIR_APPLIED|REPAIR_NEEDS_HUMAN|OUTSIDE_PLANNED_SCOPE/,
    );
  });

  it('is a record a repair cycle can genuinely be recorded against', () => {
    const migrated = parseRunRecord(asV7(fixture.record));

    const repaired = recordWith(migrated, {
      stage: 'repair',
      outcome: 'REPAIR_APPLIED',
      repairExecutions: [executionFor(migrated)],
    });

    expect(repaired.repairExecutions).toHaveLength(1);
    expect(repaired.repairExecutions[0]?.patchBeforeIdentity).toBe(fixture.patch.identity);
  });

  it('will not accept a v7 field that v7 never had', () => {
    const smuggled = { ...asV7(fixture.record), repairExecutions: [] };

    expect(capture(() => parseRunRecord(smuggled)).kind).toBe('validation');
  });

  it('will not let an old record claim the repair stage', () => {
    const error = capture(() => parseRunRecord({ ...asV7(fixture.record), stage: 'repair' }));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/stage|repair/i);
  });

  it('will not let an old record carry a repair outcome', () => {
    const error = capture(() =>
      parseRunRecord({ ...asV7(fixture.record), outcome: 'REPAIR_BLOCKED' }),
    );

    expect(error.kind).toBe('validation');
  });
});

/**
 * One proposed candidate for this run, approved the way the CLI approves one.
 *
 * Built from the helper's facts with this run's id, so the document the record holds
 * is one Stage 10 would genuinely have written rather than a literal that could drift
 * from the candidate schema.
 */
function publicationFor(record: RunRecord, approved = true): PublicationRecord {
  const candidate = candidateOf(candidateInput({ runId: record.runId }));
  return buildPublicationRecord({
    candidate,
    ...(approved
      ? { approval: approvePublication({ candidate, approvedAt: '2026-09-27T09:00:00.000Z' }) }
      : {}),
  });
}

describe.skipIf(!AVAILABLE)('a run record written by version 8', () => {
  /**
   * Stage 10's slot is a list of candidate/approval pairs, and a v8 run has never
   * filled it: no human was shown a title, so there is no digest to name and no yes
   * to store. The migration therefore gives an empty list — the same reading a v7
   * record gets for repairs — and the tests below keep the two directions apart: an
   * old record must stay loadable, and must not gain a publication on the way in.
   */
  it('loads a real Stage 9R record and calls it the current version', () => {
    const migrated = parseRunRecord(asV8(fixture.record));

    expect(RUN_SCHEMA_VERSION).toBeGreaterThan(8);
    expect(migrated.schemaVersion).toBe(RUN_SCHEMA_VERSION);
  });

  it('gives it no publications, because no candidate was ever assembled', () => {
    const migrated = parseRunRecord(asV8(fixture.record));

    expect(migrated.publications).toEqual([]);
    expect(migrated.repairExecutions).toEqual(fixture.record.repairExecutions);
  });

  it('carries every field the v8 record held, unchanged', () => {
    const original = asV8(fixture.record);
    const carried = fieldsOf(parseRunRecord(original) as unknown as Record<string, unknown>);

    for (const [key, value] of Object.entries(fieldsOf(original))) {
      expect(carried[key], key).toEqual(value);
    }
  });

  it('invents no candidate, approval or publication outcome on the way in', () => {
    const migrated = parseRunRecord(asV8(fixture.record));

    expect(migrated.stage).toBe(fixture.record.stage);
    expect(migrated.outcome).toBe(fixture.record.outcome);
    expect(JSON.stringify(migrated)).not.toMatch(/PR_APPROVED_LOCAL|CREATE_PULL_REQUEST/);
  });

  it('is a record a candidate can genuinely be recorded against', () => {
    const migrated = parseRunRecord(asV8(fixture.record));

    const proposed = recordWith(migrated, {
      stage: 'pr',
      outcome: 'PR_CANDIDATE_RECORDED',
      publications: [publicationFor(migrated, false)],
    });

    expect(proposed.publications).toHaveLength(1);
    expect(proposed.publications[0]?.approval).toBeNull();
    expect(proposed.publications[0]?.candidate.runId).toBe(fixture.record.runId);
  });

  it('will not accept a v8 field that v8 never had', () => {
    const smuggled = { ...asV8(fixture.record), publications: [] };

    expect(capture(() => parseRunRecord(smuggled)).kind).toBe('validation');
  });

  it('will not let an old record claim the publication stage', () => {
    const error = capture(() => parseRunRecord({ ...asV8(fixture.record), stage: 'pr' }));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/stage|pr/i);
  });

  it('will not let an old record carry a publication outcome', () => {
    const error = capture(() =>
      parseRunRecord({ ...asV8(fixture.record), outcome: 'PR_APPROVED_LOCAL' }),
    );

    expect(error.kind).toBe('validation');
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

  it('round-trips a record that carries the execution of a repair cycle', () => {
    const current = recordWith(fixture.record, {
      stage: 'repair',
      outcome: 'REPAIR_NEEDS_HUMAN',
      repairExecutions: [executionFor(fixture.record)],
    });

    const loaded = parseRunRecord(JSON.parse(JSON.stringify(current)));

    expect(loaded).toEqual(current);
    expect(loaded.repairExecutions[0]?.planDigest).toBe(repairPlanDigest(frozenPlan()));
  });

  it('keeps two cycles in the order they ran, each with its own lineage', () => {
    const current = recordWith(fixture.record, {
      repairExecutions: [
        executionFor(fixture.record),
        executionFor(fixture.record, { repairCycle: 2 }),
      ],
    });

    const loaded = parseRunRecord(JSON.parse(JSON.stringify(current)));

    expect(loaded.repairExecutions.map((execution) => execution.repairCycle)).toEqual([1, 2]);
    expect(loaded.repairExecutions[1]?.planDigest).not.toBe(loaded.repairExecutions[0]?.planDigest);
  });

  it('tells a run that never repaired from a cycle that changed nothing', () => {
    const never = parseRunRecord(asV7(fixture.record));
    const ran = recordWith(fixture.record, { repairExecutions: [executionFor(fixture.record)] });

    expect(never.repairExecutions).toEqual([]);
    expect(ran.repairExecutions[0]?.scope.outcome).toBe('REPAIR_LEFT_NO_TRACE');
  });

  it('refuses an execution the repair execution schema itself refuses', () => {
    const smuggled = {
      ...fixture.record,
      repairExecutions: [{ ...executionFor(fixture.record), contributionReady: true }],
    };

    const error = capture(() => parseRunRecord(smuggled));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/contributionReady/);
  });

  it('round-trips a record that carries the candidate Stage 10 showed a human', () => {
    const current = recordWith(fixture.record, {
      stage: 'pr',
      outcome: 'PR_APPROVED_LOCAL',
      publications: [publicationFor(fixture.record)],
    });

    const loaded = parseRunRecord(JSON.parse(JSON.stringify(current)));

    expect(loaded).toEqual(current);
    expect(loaded.publications[0]?.approval?.action).toBe('CREATE_PULL_REQUEST');
  });

  it('keeps two proposals in the order they were shown, the first one unapproved', () => {
    const edited = candidateOf(
      candidateInput({
        runId: fixture.record.runId,
        draft: { title: 'Revised title', body: 'B.\n' },
      }),
    );
    const current = recordWith(fixture.record, {
      publications: [
        publicationFor(fixture.record, false),
        buildPublicationRecord({
          candidate: edited,
          approval: approvePublication({
            candidate: edited,
            approvedAt: '2026-09-27T09:20:00.000Z',
          }),
        }),
      ],
    });

    const loaded = parseRunRecord(JSON.parse(JSON.stringify(current)));

    expect(loaded.publications.map((entry) => entry.candidate.prTitle)).toEqual([
      'Parser accepts invalid empty dates',
      'Revised title',
    ]);
    expect(loaded.publications[0]?.approval).toBeNull();
    expect(loaded.publications[1]?.approval).not.toBeNull();
  });

  it('tells a run that never reached Stage 10 from one whose candidate was never approved', () => {
    const never = parseRunRecord(asV8(fixture.record));
    const shown = recordWith(fixture.record, {
      publications: [publicationFor(fixture.record, false)],
    });

    expect(never.publications).toEqual([]);
    expect(shown.publications).toHaveLength(1);
    expect(shown.publications[0]?.approval).toBeNull();
  });

  it('refuses a stored approval that names some other candidate of this run', () => {
    const onDisk = publicationFor(fixture.record);
    const approval = approvePublication({
      candidate: candidateOf(
        candidateInput({ runId: fixture.record.runId, patchIdentity: OTHER_PATCH_IDENTITY }),
      ),
      approvedAt: '2026-09-27T09:00:00.000Z',
    });

    const smuggled = {
      ...recordWith(fixture.record, { publications: [onDisk] }),
      publications: [{ candidate: onDisk.candidate, approval }],
    };

    expect(capture(() => parseRunRecord(smuggled)).kind).toBe('validation');
  });

  it('refuses a version from before the supported window, and says which one', () => {
    const old = { ...asV6(fixture.record), schemaVersion: 5 };
    const error = capture(() => parseRunRecord(old));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/version 5|schemaVersion/i);
    expect(RUN_SCHEMA_VERSIONS_SUPPORTED).toContain(6);
    expect(RUN_SCHEMA_VERSIONS_SUPPORTED).toContain(7);
    expect(RUN_SCHEMA_VERSIONS_SUPPORTED).toContain(8);
  });

  it('refuses a future version rather than guessing what it meant', () => {
    for (const version of [RUN_SCHEMA_VERSION + 1, 99, 'eight', null]) {
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

  it('reads a v8 record without rewriting the bytes on disk', async () => {
    const runs = await runsDirectory('mergesutra-v8-');
    const store = createFileRunStore(runs);
    const text = JSON.stringify(asV8(fixture.record), null, 2) + '\n';
    const file = await seedRunFile(runs, fixture.record.runId, text);

    const loaded = await store.load(fixture.record.runId);

    expect(loaded.publications).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('saves and reloads the candidate a human approved, which is what Stage 11 needs', async () => {
    const runs = await runsDirectory('mergesutra-published-');
    const store = createFileRunStore(runs);
    const approved = recordWith(fixture.record, {
      stage: 'pr',
      outcome: 'PR_APPROVED_LOCAL',
      publications: [publicationFor(fixture.record)],
    });

    const file = await store.save(approved);
    const loaded = await store.load(approved.runId);

    expect(loaded.publications).toEqual(approved.publications);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      schemaVersion: RUN_SCHEMA_VERSION,
    });
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

  it('saves and reloads a run that has been repaired, which is what a resume needs', async () => {
    const runs = await runsDirectory('mergesutra-repaired-');
    const store = createFileRunStore(runs);
    const repaired = recordWith(fixture.record, {
      stage: 'repair',
      outcome: 'REPAIR_APPLIED',
      repairExecutions: [executionFor(fixture.record)],
    });

    await store.save(repaired);
    const loaded = await store.load(repaired.runId);

    expect(loaded.repairExecutions).toEqual(repaired.repairExecutions);
    expect(
      JSON.parse(await readFile(path.join(runs, `${repaired.runId}.json`), 'utf8')),
    ).toMatchObject({ schemaVersion: RUN_SCHEMA_VERSION });
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

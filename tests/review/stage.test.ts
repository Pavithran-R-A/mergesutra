import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { CompletionRequest } from '../../src/bharatcode/types.js';
import { AppError } from '../../src/core/errors.js';
import {
  REPAIR_PLAN_SCHEMA_VERSION,
  parseRepairPlan,
  type RepairPlan,
} from '../../src/repair/plan.js';
import { runReviewStage } from '../../src/review/stage.js';
import { parseRunRecord } from '../../src/state/run-record.js';
import { describePatch } from '../../src/verify/patch.js';
import { snapshotTree } from '../helpers/fixture.js';
import { memoryRunStore } from '../helpers/github.js';
import {
  cleanUp,
  hasGit,
  NOW,
  recordWith,
  REVIEW_ACTION_MARKER,
  REVIEW_SECRET_VALUE,
  REVIEW_TRANSCRIPT_MARKER,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';
import { errorFrom, put } from '../helpers/verifyRun.js';

/**
 * `mergesutra review`'s stage — the wiring, not the reviewer.
 *
 * The context suite proves what a reviewer is shown, the engine suite proves how
 * an answer is bound to a patch, and the disposition suite proves who decides
 * what a finding is worth. This file proves the one thing none of them can:
 * that a stage which reads a genuine run record, asks one question and writes the
 * answer down never touches the bytes it was asked about.
 *
 * That last clause is the whole danger of Stage 9. A review that can "helpfully"
 * fix what it finds would make the reviewer the author of the next patch, and
 * every receipt below it would describe a diff nobody reviewed. So the tests
 * here are written around two provable facts: the patch identity is the same
 * before and after, and Stage 7's run is deep-equal to the one that was loaded.
 * A plan may be frozen — a plan is a sentence — but nothing may change.
 *
 * Every model answer is derived from the prompt it was actually sent, including
 * the reference ids it cites. A fixture that hard-coded `CTX-001` would pass
 * while the real reviewer was being shown a manifest that named nothing of the
 * sort.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

/**
 * One genuine, verified run per test.
 *
 * The stage's contract is that it reads persisted state, so the test has to
 * write the state it claims exists: `reviewFixture` builds the verified record in
 * memory, and the store still holds the earlier implement-stage one. Saving it is
 * the difference between testing a review of a verified run and testing the
 * refusal path eleven times.
 */
async function aRun(): Promise<ReviewFixture> {
  const fixture = await reviewFixture(made);
  await fixture.prepared.store.save(fixture.record);
  return fixture;
}

const WIRE = (call: CompletionRequest) =>
  call.messages.map((message) => message.content).join('\n');

/**
 * A reviewer that reads the page it was given.
 *
 * `beforeAnswer` is how the staleness test moves the bytes while the request is
 * in flight — the only way to prove the stage re-measures instead of trusting.
 */
function reviewer(
  make: (wire: string) => Record<string, unknown>,
  options: {
    beforeAnswer?: (wire: string) => Promise<void>;
    model?: string;
    failure?: unknown;
  } = {},
): { client: BharatCodeClient; calls: CompletionRequest[]; wires: string[] } {
  const calls: CompletionRequest[] = [];
  const wires: string[] = [];
  const client: BharatCodeClient = {
    async complete(request) {
      calls.push(request);
      const wire = WIRE(request);
      wires.push(wire);
      if (options.failure) throw options.failure;
      await options.beforeAnswer?.(wire);
      return {
        text: JSON.stringify(make(wire)),
        model: options.model ?? 'bharatcode-review-model',
        finishReason: 'stop',
        usage: { promptTokens: 4_200, completionTokens: 320, totalTokens: 4_520 },
      };
    },
    async listModels() {
      throw new Error('a review stage may not enumerate models');
    },
    async completeStructured() {
      throw new Error('a review stage may not ask for structured output');
    },
    async healthCheck() {
      throw new Error('a review stage may not probe the service');
    },
  };
  return { client, calls, wires };
}

/** The id MergeSutra issued for that path, read off the page the reviewer got. */
function refFor(wire: string, kind: 'PATCH' | 'CRITERION' | 'RECEIPT', target: string): string {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const field = kind === 'PATCH' ? 'file' : kind === 'CRITERION' ? 'criterionId' : 'gateId';
  const found = new RegExp(`(CTX-\\d{3}) type: ${kind} ${field}: ${escaped}\\b`).exec(wire);
  if (!found?.[1]) throw new Error(`the reviewed page names no ${kind} reference for ${target}`);
  return found[1];
}

const finding = (
  wire: string,
  criterion: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  severity: 'HIGH',
  category: 'CORRECTNESS',
  statement: 'An impossible day can still reach a Date on one input shape.',
  impact: 'A caller stores the wrong day and never hears about it.',
  evidence: 'The parser builds a Date straight from the unvalidated string.',
  file: 'src/parse.ts',
  criterionIds: [criterion],
  contextRefs: [refFor(wire, 'PATCH', 'src/parse.ts'), refFor(wire, 'CRITERION', criterion)],
  proposedAction: 'Change src/parse.ts to reject the day before constructing a Date.',
  confidence: 'HIGH',
  ...over,
});

const reviewOf = (
  wire: string,
  criterion: string,
  findings: readonly Record<string, unknown>[],
  summary = 'The parser rejects impossible days; one input shape still slips through.',
): Record<string, unknown> => ({ summary, findings });

/** A prior cycle's plan, so the next one can be refused for being too far along. */
function priorPlan(fixture: ReviewFixture, cycle: number): RepairPlan {
  return parseRepairPlan({
    schemaVersion: REPAIR_PLAN_SCHEMA_VERSION,
    runId: fixture.record.runId,
    reviewCycle: cycle,
    repairCycle: cycle,
    reviewedPatchIdentity: fixture.patch.identity,
    findings: [
      {
        findingId: 'RF-001',
        criterionIds: [fixture.criteria[0] ?? 'AC-1'],
        intendedChange: 'Change src/parse.ts to reject the day before constructing a Date.',
        expectedFiles: ['src/parse.ts'],
        expectedChecks: ['VG-001'],
      },
    ],
    criteria: [fixture.criteria[0] ?? 'AC-1'],
    expectedFiles: ['src/parse.ts'],
    expectedChecks: ['VG-001'],
    createdAt: NOW.toISOString(),
  });
}

function notVerified(fixture: ReviewFixture) {
  const store = memoryRunStore();
  const record = recordWith(fixture.record, {
    verification: null,
    verificationPlan: null,
    evidence: null,
    executionConsent: null,
    stage: 'implement',
    outcome: 'IMPLEMENTED_BY_MODEL',
  });
  void store.save(record);
  return { store, record };
}

describe.skipIf(!AVAILABLE)('what the review stage writes, and what it leaves alone', () => {
  it('files the review into the record, bound to the patch it was shown', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const model = reviewer((wire) => reviewOf(wire, criterion, [finding(wire, criterion)]));

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(stage.attempt.status).toBe('REVIEWED');
    expect(stage.record.stage).toBe('review');
    expect(stage.record.outcome).toBe('REVIEW_RECORDED');
    expect(stage.review).not.toBeNull();
    expect(stage.record.review).not.toBeNull();

    // Both identities are the same digest, and it is the one on disk.
    expect(stage.review?.reviewedPatchIdentity).toBe(fixture.patch.identity);
    expect(stage.review?.currentPatchIdentity).toBe(fixture.patch.identity);
    expect(stage.review?.patchPrecondition.status).toBe('MATCHED');
    expect(stage.review?.baseSha).toBe(fixture.base);
    expect(stage.review?.modelId).toBe('bharatcode-review-model');
    expect(stage.review?.attempts).toBe(1);
    expect(stage.review?.untrusted).toBe(true);

    const [stored] = stage.review?.findings ?? [];
    expect(stored?.id).toBe('RF-001');
    expect(stored?.disposition).toBe('VALID_REPAIR_CANDIDATE');
    expect(stored?.contextRefs).toContain(refFor(model.wires[0] ?? '', 'PATCH', 'src/parse.ts'));

    // A reader who loads the file gets the same document, not a prettier one.
    const reloaded = parseRunRecord(JSON.parse(JSON.stringify(stage.record)));
    expect(reloaded.review?.findings).toEqual(stage.review?.findings);
    expect(reloaded.outcome).toBe('REVIEW_RECORDED');
  });

  it('refuses a run whose gates have never been measured', async () => {
    const fixture = await aRun();
    const { store, record } = notVerified(fixture);
    const model = reviewer(() => reviewOf('', 'AC-1', []));

    const error = await errorFrom(() =>
      runReviewStage({ runId: record.runId }, { store, now: () => NOW, client: model.client }),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error?.kind).toBe('validation');
    expect(error?.message).toMatch(/verif/i);
    expect(model.calls).toHaveLength(0);
  });

  it('changes no byte of the workspace and no word of the verification', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const before = await snapshotTree(fixture.workspace);
    const identityBefore = (
      await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })
    ).identity;
    const model = reviewer((wire) => reviewOf(wire, criterion, [finding(wire, criterion)]));

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(await snapshotTree(fixture.workspace)).toEqual(before);
    const identityAfter = (
      await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })
    ).identity;
    expect(identityAfter).toBe(identityBefore);
    expect(stage.record.verification).toEqual(fixture.record.verification);
    expect(stage.record.evidence).toEqual(fixture.record.evidence);
    expect(stage.record.executionConsent).toEqual(fixture.record.executionConsent);
    expect(stage.record.acceptanceContract).toEqual(fixture.record.acceptanceContract);
  });

  it('marks the review stale when the bytes move while the reviewer is answering', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const model = reviewer((wire) => reviewOf(wire, criterion, [finding(wire, criterion)]), {
      beforeAnswer: async () => {
        const current = await readFile(path.join(fixture.workspace, 'src/parse.ts'), 'utf8');
        await put(
          fixture.workspace,
          'src/parse.ts',
          `${current}\n// moved while the reviewer was answering\n`,
        );
      },
    });

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    const moved = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    expect(moved.identity).not.toBe(fixture.patch.identity);
    expect(stage.attempt.status).toBe('STALE');
    expect(stage.record.outcome).toBe('REVIEW_STALE');
    expect(stage.record.repairPlan).toBeNull();
    expect(stage.repairPlan).toBeNull();
    expect(stage.review?.currentPatchIdentity).toBe(moved.identity);
    expect(stage.review?.patchPrecondition.status).toBe('STALE');
    for (const findingRecord of stage.review?.findings ?? []) {
      expect(findingRecord.disposition).toBe('STALE');
    }
    // A stale review is on the record, and it says so in the limitations too.
    expect(stage.record.limitations.join('\n')).toMatch(/REVIEW-STALE/);
  });

  it('freezes a repair plan for a candidate without touching a byte', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const before = (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base }))
      .identity;
    const model = reviewer((wire) => reviewOf(wire, criterion, [finding(wire, criterion)]));

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(stage.repairPlan).not.toBeNull();
    expect(stage.record.repairPlan).toEqual(stage.repairPlan);
    expect(stage.repairPlan?.reviewedPatchIdentity).toBe(fixture.patch.identity);
    expect(stage.repairPlan?.reviewCycle).toBe(1);
    expect(stage.repairPlan?.repairCycle).toBe(1);
    expect(stage.repairPlan?.expectedFiles).toEqual(['src/parse.ts']);
    expect(stage.repairPlan?.expectedChecks).toEqual(['VG-001']);
    expect(stage.repairPlan?.criteria).toEqual([criterion]);
    expect(stage.repairPlan?.findings[0]?.findingId).toBe('RF-001');
    // The plan is the reviewer's words as a description of work, nothing more.
    expect(stage.repairPlan?.findings[0]?.intendedChange).toBe(
      'Change src/parse.ts to reject the day before constructing a Date.',
    );

    const after = (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base }))
      .identity;
    expect(after).toBe(before);
  });

  it('files a review that found nothing as a review, not as a clean result', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const model = reviewer((wire) =>
      reviewOf(wire, criterion, [], 'Nothing in this patch contradicts the contract.'),
    );

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(stage.review?.findings).toEqual([]);
    expect(stage.record.repairPlan).toBeNull();
    expect(stage.record.outcome).toBe('REVIEW_RECORDED');
    expect(stage.record.limitations.join('\n')).toMatch(/filed no findings/);
    expect(
      `${stage.review?.summary ?? ''} ${stage.record.nextStage} ${stage.record.outcome}`,
    ).not.toMatch(/APPROVED|CONTRIBUTION_READY|no defects/i);
  });

  it('routes a human-only finding to a person and freezes no plan', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const model = reviewer((wire) =>
      reviewOf(wire, criterion, [
        finding(wire, criterion, {
          severity: 'BLOCKER',
          category: 'SECURITY',
          statement: 'A credential is committed in this patch and reaches every future reader.',
          impact: 'Anyone who clones the repository inherits a live-looking secret.',
          proposedAction: 'Ask a human to rotate it; Change src/parse.ts is not the fix.',
        }),
      ]),
    );

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(stage.review?.findings[0]?.disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(stage.record.repairPlan).toBeNull();
    expect(stage.record.outcome).toBe('REVIEW_NEEDS_HUMAN');
    expect(stage.attempt.status).toBe('REVIEWED');
  });

  it('stops planning once the cycles are spent, and says why', async () => {
    const fixture = await reviewFixture(made);
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const store = memoryRunStore();
    const carried = recordWith(fixture.record, { repairPlan: priorPlan(fixture, 3) });
    void store.save(carried);
    const model = reviewer((wire) => reviewOf(wire, criterion, [finding(wire, criterion)]));

    const stage = await runReviewStage(
      { runId: carried.runId },
      { store, now: () => NOW, client: model.client },
    );

    expect(stage.repairPlan).toBeNull();
    expect(stage.record.outcome).toBe('REVIEW_NEEDS_HUMAN');
    // The bound names the cycle it stopped, rather than quietly trying again.
    expect(stage.record.limitations.join('\n')).toMatch(/Review cycle 4 and repair cycle 4/);
    expect(stage.record.limitations.join('\n')).toMatch(/REVIEW-PLAN-REFUSED/);
    expect(
      await describePatch({ workspace: fixture.workspace, baseSha: fixture.base }),
    ).toMatchObject({ identity: fixture.patch.identity });
  });

  it('keeps the run readable when the reviewer cannot be reached', async () => {
    const fixture = await aRun();
    const model = reviewer(() => reviewOf('', 'AC-1', []), {
      failure: new AppError({
        kind: 'network',
        message: 'fetch failed: connection reset by peer',
        remediation: 'Check the network and retry.',
      }),
    });

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(stage.attempt.status).toBe('MODEL_UNAVAILABLE');
    expect(stage.review).toBeNull();
    expect(stage.record.review).toBeNull();
    expect(stage.record.repairPlan).toBeNull();
    expect(stage.record.outcome).toBe('REVIEW_INCONCLUSIVE');
    expect(stage.record.limitations.join('\n')).toMatch(/REVIEW-NOT-RUN/);
    expect(stage.record.verification).toEqual(fixture.record.verification);
    expect(parseRunRecord(JSON.parse(JSON.stringify(stage.record))).stage).toBe('review');
  });

  it('records a cancellation without pretending a reviewer was consulted', async () => {
    const fixture = await aRun();
    const model = reviewer(() => reviewOf('', 'AC-1', []));

    const stage = await runReviewStage(
      { runId: fixture.record.runId, signal: AbortSignal.abort() },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    expect(model.calls).toHaveLength(0);
    expect(stage.record.outcome).toBe('REVIEW_CANCELLED');
    expect(stage.record.review).toBeNull();
    expect(stage.record.repairPlan).toBeNull();
    expect(stage.record.limitations.join('\n')).toMatch(/cancel/i);
  });

  it('does not file a review it cannot bind to the bytes on disk', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const model = reviewer((wire) => reviewOf(wire, criterion, [finding(wire, criterion)]));

    const stage = await runReviewStage(
      { runId: fixture.record.runId },
      {
        store: fixture.prepared.store,
        now: () => NOW,
        client: model.client,
        currentPatchIdentity: async () => null,
      },
    );

    expect(stage.attempt.patchPrecondition).toBe('UNMEASURABLE');
    expect(stage.review).toBeNull();
    expect(stage.record.review).toBeNull();
    expect(stage.record.repairPlan).toBeNull();
    expect(stage.record.outcome).toBe('REVIEW_STALE');
    expect(stage.record.limitations.join('\n')).toMatch(/REVIEW-UNBOUND/);
  });

  it('carries the reviewer was shown, never the loop’s own account', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const model = reviewer((wire) => reviewOf(wire, criterion, []));

    await runReviewStage(
      { runId: fixture.record.runId },
      { store: fixture.prepared.store, now: () => NOW, client: model.client },
    );

    const wire = model.wires[0] ?? '';
    expect(wire).not.toContain(REVIEW_TRANSCRIPT_MARKER);
    expect(wire).not.toContain(REVIEW_ACTION_MARKER);
    expect(wire).not.toContain(REVIEW_SECRET_VALUE);
    // What it *was* shown, so a finding had something to point at: the manifest,
    // the receipts, and the bytes themselves.
    expect(wire).toContain('REFERENCE MANIFEST');
    expect(wire).toContain(fixture.patch.identity.slice(0, 16));
  });

  it('reviews the newest run that has verification, skipping one that does not', async () => {
    const fixture = await aRun();
    const criterion = fixture.criteria[0] ?? 'AC-1';
    const store = memoryRunStore();
    void store.save(fixture.record);
    const unverified = recordWith(fixture.record, {
      runId: 'run-20260926T000000Z-fffff1',
      createdAt: '2026-09-26T00:00:00.000Z',
      verification: null,
      verificationPlan: null,
      evidence: null,
    });
    void store.save(unverified);
    const model = reviewer((wire) => reviewOf(wire, criterion, []));

    const stage = await runReviewStage({}, { store, now: () => NOW, client: model.client });

    expect(stage.record.runId).toBe(fixture.record.runId);
    expect(stage.workspace).toBe(fixture.workspace);
  });
});

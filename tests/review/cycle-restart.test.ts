import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { CompletionRequest } from '../../src/bharatcode/types.js';
import { MAX_REVIEW_CYCLES_CEILING } from '../../src/repair/bounds.js';
import { createFileRunStore } from '../../src/state/run-store.js';
import { runReviewStage } from '../../src/review/stage.js';
import { describePatch } from '../../src/verify/patch.js';
import { cleanUp, hasGit, NOW, reviewFixture, type ReviewFixture } from '../helpers/review.js';

/**
 * Where the review-cycle count lives when the process does not (§14, S12-19).
 *
 * `src/review/stage.ts:276` derives the next cycle from `source.repairPlan`, and a
 * test in the stage's own suite proves the refusal by writing a plan with
 * `reviewCycle: 3` into an in-memory store. Neither of those is the claim §14 asks
 * for. The claim is that the count survives the thing a person actually does —
 * close the terminal and type the command again — which needs the number to be
 * produced by the previous entry and read back off a disk, four times in a row,
 * with no hand-written plan anywhere in the sequence.
 *
 * It also needs the ceiling to be the ceiling when a caller asks for more. The CLI
 * rejects `--max-review-cycles 9` at the flag, so the path left open is a module
 * caller passing a raised `limits` object; every entry below does exactly that, and
 * the plan that stops the run names 3, not 500.
 */

vi.setConfig({ testTimeout: 180_000 });

const AVAILABLE = await hasGit();
const made: string[] = [];

afterEach(async () => {
  await cleanUp(made);
  made.length = 0;
});

const WIRE = (call: CompletionRequest) =>
  call.messages.map((message) => message.content).join('\n');

/** The id MergeSutra issued for that path, read off the page the reviewer got. */
function refFor(wire: string, kind: 'PATCH' | 'CRITERION', target: string): string {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const field = kind === 'PATCH' ? 'file' : 'criterionId';
  const found = new RegExp(`(CTX-\\d{3}) type: ${kind} ${field}: ${escaped}\\b`).exec(wire);
  if (!found?.[1]) throw new Error(`the reviewed page names no ${kind} reference for ${target}`);
  return found[1];
}

/**
 * A reviewer that files the same true candidate every time it is asked.
 *
 * One candidate is enough for the count to move, and it has to be a candidate a
 * disposition can validate: the refs are read off the wire the model was actually
 * sent, so a plan can be frozen rather than thrown away as ungrounded.
 */
function reviewer(criterion: string, file: string): BharatCodeClient {
  return {
    async complete(request) {
      const wire = WIRE(request);
      return {
        text: JSON.stringify({
          summary: 'One gap against the contract, on the parser.',
          findings: [
            {
              severity: 'HIGH',
              category: 'CORRECTNESS',
              statement: 'An impossible day can still reach a Date on one input shape.',
              impact: 'A caller stores the wrong day and never hears about it.',
              evidence: 'The parser builds a Date straight from the unvalidated string.',
              file,
              criterionIds: [criterion],
              contextRefs: [refFor(wire, 'PATCH', file), refFor(wire, 'CRITERION', criterion)],
              proposedAction: `Change ${file} to reject the day before constructing a Date.`,
              confidence: 'HIGH',
            },
          ],
        }),
        model: 'bharatcode-review-model',
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
}

describe.skipIf(!AVAILABLE)('a review entered again', () => {
  it('counts its cycles from what the run filed, and stops at the ceiling a caller cannot raise', async () => {
    const fixture: ReviewFixture = await reviewFixture(made);
    const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-review-restart-store-'));
    made.push(root);
    const store = createFileRunStore(root);
    await store.save(fixture.record);

    const criterion = fixture.criteria[0] ?? 'AC-1';
    // Asked for at every entry: a raised budget is not a scope, and the ceiling is what
    // a plan is measured against however the caller spells the number.
    const raised = { maxReviewCycles: 500, maxRepairCycles: 500, maxFindingsPerRepair: 500 };
    const seen: number[] = [];
    for (let entry = 1; entry <= MAX_REVIEW_CYCLES_CEILING + 1; entry += 1) {
      const stage = await runReviewStage(
        { runId: fixture.record.runId },
        { store, now: () => NOW, client: reviewer(criterion, 'src/parse.ts'), limits: raised },
      );
      const onDisk = await store.load(fixture.record.runId);
      const plan = onDisk.repairPlan;
      if (entry <= MAX_REVIEW_CYCLES_CEILING) {
        expect(plan?.reviewCycle).toBe(entry);
        expect(plan?.repairCycle).toBe(entry);
        // What the entry handed its caller is what the disk carries: a plan cannot be
        // passed around a restart without being filed by the one that froze it.
        expect(stage.repairPlan).toEqual(plan);
        seen.push(entry);
      } else {
        // Past the ceiling nothing is frozen: a plan is what authorises an edit.
        expect(plan).toBeNull();
        expect(stage.repairPlan).toBeNull();
        expect(onDisk.outcome).toBe('REVIEW_NEEDS_HUMAN');
        expect(onDisk.limitations.join('\n')).toMatch(/REVIEW-PLAN-REFUSED/);
        expect(onDisk.limitations.join('\n')).toContain(
          `Review cycle ${String(entry)} and repair cycle ${String(entry)}`,
        );
        expect(onDisk.limitations.join('\n')).toContain(
          `this build's limits of ${String(MAX_REVIEW_CYCLES_CEILING)} and`,
        );
      }
    }
    expect(seen).toEqual([1, 2, 3]);

    // A review reads; it does not edit. The bytes are the ones Stage 7 measured.
    expect(
      (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })).identity,
    ).toBe(fixture.patch.identity);
  });
});

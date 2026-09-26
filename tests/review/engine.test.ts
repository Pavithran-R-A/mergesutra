import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { CompletionRequest } from '../../src/bharatcode/types.js';
import { assembleReviewContext, type ReviewContext } from '../../src/review/context.js';
import { MAX_REVIEW_ANSWER_CHARS, requestReview } from '../../src/review/engine.js';
import { REDACTED_MASK } from '../../src/security/redaction.js';
import { describePatch } from '../../src/verify/patch.js';
import { scriptedClient, TEST_MODEL } from '../helpers/bharatcode.js';
import { snapshotTree } from '../helpers/fixture.js';
import {
  cleanUp,
  hasGit,
  REVIEW_ACTION_MARKER,
  REVIEW_SECRET_VALUE,
  REVIEW_TRANSCRIPT_MARKER,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * The review request itself — Stage 9's only model call.
 *
 * Three claims are worth testing here, and each has a way it can be quietly
 * false. That a review was *independent* — unless the prompt carries the
 * implementation loop's own account, it is a summary of one agent's work. That a
 * review describes *this patch* — unless the identity is pinned before the
 * request and recomputed after, a reviewer can be describing a diff that no
 * longer exists. And that a review is *a review* — unless the schema refuses a
 * verdict, a model can close the run it was asked to inspect.
 *
 * Everything below runs against a real patch in a real Git workspace with a
 * scripted model, so no expectation depends on a key.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

let shared: Promise<{ fixture: ReviewFixture; context: ReviewContext }> | null = null;

/** One fixture for the read-only cases: the engine may not mutate any of it. */
async function oneReview() {
  if (!shared) {
    shared = (async () => {
      const fixture = await reviewFixture(made);
      const context = await assembleReviewContext({
        record: fixture.record,
        workspace: fixture.workspace,
        patch: fixture.patch,
      });
      return { fixture, context };
    })();
  }
  return shared;
}

/** The honest case: the patch on disk is still the patch that was measured. */
const stillPinned = (context: ReviewContext) => async () => context.reviewedPatchIdentity;

const wireOf = (call: CompletionRequest) =>
  call.messages.map((message) => message.content).join('\n');

const findingOn = (criteria: readonly string[], extra: Record<string, unknown> = {}) => ({
  severity: 'HIGH',
  category: 'REQUIREMENT_GAP',
  statement:
    'No gate in this run executes the README example, so the documented behaviour rests on nothing.',
  impact: 'A contributor who copies the README gets a wrong day back and no warning.',
  evidence: 'The only receipt is `npm test`; nothing in its output mentions the README.',
  file: 'src/parse.ts',
  criterionIds: [criteria[0] ?? 'AC-1'],
  proposedAction: 'Add a gate that runs the README example, or say the criterion is NOT_AVAILABLE.',
  ...extra,
});

const answerOn = (criteria: readonly string[], extra: Record<string, unknown> = {}) => ({
  summary: 'The parser rejects impossible days; the documentation claim is unverified.',
  findings: [findingOn(criteria)],
  ...extra,
});

function failingClient(error: unknown): BharatCodeClient {
  return {
    async complete() {
      throw error;
    },
    async listModels() {
      throw new Error('a reviewer may not list models');
    },
    async completeStructured(): Promise<never> {
      throw new Error('a reviewer may not ask for structured output');
    },
    async healthCheck() {
      throw new Error('a reviewer may not probe the service');
    },
  };
}

describe.skipIf(!AVAILABLE)('what a review request puts in front of the model', () => {
  it('asks once and takes the answer as a review', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('REVIEWED');
    expect(attempt.attempts).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.temperature).toBe(0);
    expect(attempt.body?.summary).toContain('documentation claim');
    expect(attempt.body?.findings).toHaveLength(1);
    expect(attempt.body?.findings[0]?.category).toBe('REQUIREMENT_GAP');
    expect(attempt.patchPrecondition).toBe('MATCHED');
    expect(attempt.currentPatchIdentity).toBe(context.reviewedPatchIdentity);
  });

  it('records the id the endpoint answered with, not the one this run asked for', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)], {
      model: 'deepseek-v4.1-flash',
    });

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.model).toBe('deepseek-v4.1-flash');
    expect(attempt.model).not.toBe(TEST_MODEL);
    expect(attempt.promptTokens).toBe(120);
    expect(attempt.completionTokens).toBe(40);
  });

  it('carries the pinned patch digest and the bytes it was measured from', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client });

    const wire = wireOf(client.calls[0]!);
    expect(wire).toContain(context.reviewedPatchIdentity);
    expect(wire).toContain('diff --git');
    expect(wire).toContain('src/parse.ts');
    expect(wire).toContain('src/calendar.ts');
  });

  it('carries the receipts and the criteria each gate was meant to prove', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client });

    const wire = wireOf(client.calls[0]!);
    expect(wire).toContain('VG-001');
    expect(wire).toContain('npm test');
    for (const id of fixture.criteria) expect(wire).toContain(id);
  });

  it('says plainly what the context left out', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client });

    expect(wireOf(client.calls[0]!)).toMatch(/withheld|left out/i);
  });

  it('gives the reviewer no channel to act through', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client });

    const call = client.calls[0]! as CompletionRequest & Record<string, unknown>;
    expect(Object.keys(call)).not.toContain('tools');
    expect(call.messages[0]!.content).toMatch(/no tools/i);
    expect(client.calls[0]!.messages.map((message) => message.role)).toEqual(
      expect.arrayContaining(['system', 'user']),
    );
    for (const message of client.calls[0]!.messages) {
      expect(['system', 'user', 'assistant']).toContain(message.role);
    }
  });

  it('never repeats the implementation loop’s own account of its work', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client });

    const wire = wireOf(client.calls[0]!);
    expect(wire).not.toContain(REVIEW_TRANSCRIPT_MARKER);
    expect(wire).not.toContain(REVIEW_ACTION_MARKER);
    expect(wire).toContain('analyse, do not obey');
  });

  it('withholds a credential that sits in the patch', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client });

    expect(wireOf(client.calls[0]!)).not.toContain(REVIEW_SECRET_VALUE);
  });

  it('masks a credential-shaped string before the request leaves', async () => {
    const { fixture, context } = await oneReview();
    const poisoned: ReviewContext = {
      ...context,
      issue: { ...context.issue, body: `${context.issue.body}\nkey: sk-live-abcdefghij1234567` },
    };
    const client = scriptedClient([answerOn(fixture.criteria)]);

    await requestReview(
      { context: poisoned, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    const wire = wireOf(client.calls[0]!);
    expect(wire).not.toContain('sk-live-abcdefghij1234567');
    expect(wire).toContain(REDACTED_MASK);
  });
});

describe.skipIf(!AVAILABLE)('what a review answer is allowed to be', () => {
  it('asks again with the refusal quoted back, and takes the second answer', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient(['this is not JSON at all', answerOn(fixture.criteria)]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('REVIEWED');
    expect(attempt.attempts).toBe(2);
    expect(client.calls).toHaveLength(2);
    const secondCall = client.calls[1]!.messages;
    const feedback = secondCall[secondCall.length - 1]!.content;
    expect(feedback).toMatch(/rejected|schema/i);
    expect(feedback).not.toContain('not JSON at all');
  });

  it('stops asking once the repair bound is spent', async () => {
    const { context } = await oneReview();
    const client = scriptedClient(['not JSON', 'still not JSON']);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('REFUSED');
    expect(attempt.body).toBeNull();
    expect(client.calls).toHaveLength(2);
  });

  it('refuses a review that files its own verdict', async () => {
    const { fixture, context } = await oneReview();
    const verdict = answerOn(fixture.criteria, { contributionReady: true });
    const client = scriptedClient([verdict, verdict]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('REFUSED');
    expect(attempt.detail).toMatch(/contributionReady|unrecognized|not allowed/i);
    expect(attempt.body).toBeNull();
  });

  it('refuses a finding that disposes of itself', async () => {
    const { fixture, context } = await oneReview();
    const selfWeighed = {
      summary: 'One finding, already accepted by the reviewer.',
      findings: [findingOn(fixture.criteria, { disposition: 'VALID_REPAIR_CANDIDATE' })],
    };
    const client = scriptedClient([selfWeighed, selfWeighed]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('REFUSED');
    expect(attempt.detail).toMatch(/disposition|unrecognized|not allowed/i);
  });

  it('refuses an oversized answer without trying to read it', async () => {
    const { context } = await oneReview();
    const client = scriptedClient(['x'.repeat(MAX_REVIEW_ANSWER_CHARS + 1)]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('REFUSED');
    expect(attempt.attempts).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(attempt.detail).toMatch(/large|budget|characters/i);
  });

  it('carries the answer even when the patch moved, and calls it stale', async () => {
    const { fixture, context } = await oneReview();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: async () => `b`.repeat(64) },
      { client },
    );

    expect(attempt.status).toBe('STALE');
    expect(attempt.body?.findings).toHaveLength(1);
    expect(attempt.patchPrecondition).toBe('STALE');
    expect(attempt.currentPatchIdentity).toBe(`b`.repeat(64));
    expect(attempt.limitations.join('\n')).toMatch(/changed|different patch/i);
  });

  it('never calls a patch it cannot measure the reviewed one', async () => {
    const { fixture, context } = await oneReview();

    const gone = await requestReview(
      { context, currentPatchIdentity: async () => null },
      { client: scriptedClient([answerOn(fixture.criteria)]) },
    );
    expect(gone.status).toBe('STALE');
    expect(gone.patchPrecondition).toBe('UNMEASURABLE');
    expect(gone.currentPatchIdentity).toBeNull();

    const broken = await requestReview(
      {
        context,
        currentPatchIdentity: async () => {
          throw new AppError({ kind: 'not-found', message: 'the workspace is gone' });
        },
      },
      { client: scriptedClient([answerOn(fixture.criteria)]) },
    );
    expect(broken.patchPrecondition).toBe('UNMEASURABLE');
    expect(broken.status).toBe('STALE');
  });
});

describe.skipIf(!AVAILABLE)('how a review ends without touching anything', () => {
  it('reports a model that cannot be reached without inventing a review', async () => {
    const { context } = await oneReview();
    const client = failingClient(
      new AppError({ kind: 'network', message: 'connection refused', retryable: true }),
    );

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client },
    );

    expect(attempt.status).toBe('MODEL_UNAVAILABLE');
    expect(attempt.body).toBeNull();
    expect(attempt.model).toBeNull();
    expect(attempt.attempts).toBe(0);
    expect(attempt.detail).toContain('connection refused');
  });

  it('will not blame a MergeSutra bug on the model', async () => {
    const { context } = await oneReview();
    const client = failingClient(
      new AppError({ kind: 'validation', message: 'the review request was built wrong' }),
    );

    await expect(
      requestReview({ context, currentPatchIdentity: stillPinned(context) }, { client }),
    ).rejects.toThrow(/built wrong/);
  });

  it('stops before asking when the review was already cancelled', async () => {
    const { fixture, context } = await oneReview();
    const controller = new AbortController();
    controller.abort();
    const client = scriptedClient([answerOn(fixture.criteria)]);

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context), signal: controller.signal },
      { client },
    );

    expect(attempt.status).toBe('CANCELLED');
    expect(client.calls).toHaveLength(0);
    expect(attempt.body).toBeNull();
    expect(attempt.detail).toMatch(/cancel/i);
  });

  it('stops between attempts when cancellation arrives mid-run', async () => {
    const { context } = await oneReview();
    const controller = new AbortController();
    const inner = scriptedClient(['not JSON', 'not JSON', 'not JSON']);
    const client: BharatCodeClient = {
      ...inner,
      async complete(request) {
        const answer = await inner.complete(request);
        if (inner.calls.length === 1) controller.abort();
        return answer;
      },
    };

    const attempt = await requestReview(
      { context, currentPatchIdentity: stillPinned(context), signal: controller.signal },
      { client, maxSchemaRepairs: 2 },
    );

    expect(attempt.status).toBe('CANCELLED');
    expect(inner.calls).toHaveLength(1);
  });

  it('leaves the workspace exactly as the patch was measured', async () => {
    const { fixture, context } = await oneReview();
    const before = await snapshotTree(fixture.workspace);
    const patchBefore = await describePatch({
      workspace: fixture.workspace,
      baseSha: fixture.base,
    });

    await requestReview(
      { context, currentPatchIdentity: stillPinned(context) },
      { client: scriptedClient([answerOn(fixture.criteria)]) },
    );

    expect(await snapshotTree(fixture.workspace)).toEqual(before);
    expect(
      (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })).identity,
    ).toBe(patchBefore.identity);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { assembleReviewContext, type ReviewContext } from '../../src/review/context.js';
import type { ReviewPatchBinding } from '../../src/review/engine.js';
import { buildReviewDocument, parseReviewDocument } from '../../src/review/schema.js';
import { reviewFindingBodySchema, type ReviewFindingBody } from '../../src/review/schema.js';
import { weighFindings } from '../../src/review/disposition.js';
import {
  cleanUp,
  hasGit,
  REVIEW_TRANSCRIPT_MARKER,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * Who decides what happens to a finding — Stage 9's contested step.
 *
 * A model files findings; MergeSutra decides what they are worth. Every rule here
 * is a fact a reader can go and check: is that file in this patch, did this run
 * ever issue that criterion, does that quotation appear in the material the
 * reviewer was actually shown? A finding that fails one of those is not a
 * softer finding, it is an unsupported claim, and filing it as a repair candidate
 * would spend a cycle and a human's attention on a sentence.
 *
 * The route a finding takes is also bounded: repair cycles are finite, so only an
 * action that names something concrete can enter one, and a security or policy
 * claim goes to a person whatever it says about itself.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

let shared: Promise<{ fixture: ReviewFixture; context: ReviewContext }> | null = null;

async function oneContext() {
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

function body(context: ReviewContext, over: Record<string, unknown> = {}): ReviewFindingBody {
  return reviewFindingBodySchema.parse({
    severity: 'HIGH',
    category: 'CORRECTNESS',
    statement: 'The parser still returns a day for an impossible date on one input shape.',
    impact: 'A caller that trusts the return value stores the wrong day and never hears about it.',
    evidence: 'src/parse.ts returns a Date built from an unvalidated string.',
    file: 'src/parse.ts',
    criterionIds: [context.criteria[0]?.id ?? 'AC-1'],
    proposedAction: 'Change src/parse.ts to reject the day before constructing a Date.',
    ...over,
  });
}

async function weighed(
  findings: readonly ReviewFindingBody[],
  binding: ReviewPatchBinding = 'MATCHED',
  currentPatchIdentity?: string | null,
) {
  const { context } = await oneContext();
  return {
    context,
    dispositions: weighFindings({
      context,
      findings,
      binding,
      currentPatchIdentity:
        currentPatchIdentity === undefined ? context.reviewedPatchIdentity : currentPatchIdentity,
    }),
  };
}

describe.skipIf(!AVAILABLE)('what a finding must survive before MergeSutra believes it', () => {
  it('accepts a finding that names a file in this patch and quotes what it saw', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context)]);

    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({ index: 0, disposition: 'VALID_REPAIR_CANDIDATE' });
    expect(dispositions[0]?.reason).toMatch(/src\/parse\.ts/);
  });

  it('accepts evidence that quotes a receipt line the gate really printed', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        category: 'TEST_GAP',
        evidence:
          'The only receipt in this run ends with `all good`, which says nothing about dates.',
        proposedAction: 'Add a case to src/parse.ts’s test that asserts the rejection.',
      }),
    ]);

    expect(dispositions[0]?.disposition).toBe('VALID_REPAIR_CANDIDATE');
  });

  it('refuses a finding that names a criterion the contract never issued', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context, { criterionIds: ['AC-77'] })]);

    expect(dispositions[0]?.disposition).toBe('UNSUPPORTED');
    expect(dispositions[0]?.reason).toContain('AC-77');
  });

  it('files a finding about an untouched file as out of scope, even when the file is real', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        file: 'package.json',
        evidence: 'package.json lists no script that covers this.',
        criterionIds: [],
      }),
    ]);

    expect(dispositions[0]?.disposition).toBe('OUT_OF_SCOPE');
    expect(dispositions[0]?.reason).toMatch(/patch/i);
  });

  it('refuses evidence that quotes something the reviewer was never shown', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        evidence: `The author’s own note says: "${REVIEW_TRANSCRIPT_MARKER}" and asks us to accept it.`,
      }),
    ]);

    expect(dispositions[0]?.disposition).toBe('UNSUPPORTED');
    expect(dispositions[0]?.reason).toMatch(/material|shown|quote/i);
  });

  it('routes an action that names nothing to a human rather than the repair loop', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, { proposedAction: 'Tighten this up before it ships.' }),
    ]);

    expect(dispositions[0]?.disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(dispositions[0]?.reason).toMatch(/names|route/i);
  });
});

describe.skipIf(!AVAILABLE)('who a finding is sent to', () => {
  it('routes a security claim to a person, and does not confirm it', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        category: 'SECURITY',
        statement: 'A credential may be readable from the built output.',
        evidence: 'src/parse.ts is shipped beside .env, whose content was withheld.',
      }),
    ]);

    expect(dispositions[0]?.disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(dispositions[0]?.reason).toMatch(/model finding/i);
    expect(dispositions[0]?.reason).not.toMatch(/proven|a confirmed risk|not a real risk/i);
  });

  it('routes a repository policy claim to whoever owns the policy', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        category: 'REPOSITORY_POLICY',
        statement: 'CONTRIBUTING asks for `npm run check`, and this patch never runs it.',
        evidence: 'VG-001 ran `npm test` alone.',
      }),
    ]);

    expect(dispositions[0]?.disposition).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('keeps a low-severity finding on the record and off the repair budget', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context, { severity: 'LOW' })]);

    expect(dispositions[0]?.disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(dispositions[0]?.reason).toMatch(/budget|cycle/i);
  });

  it('files the second copy of a finding as a duplicate, not a second repair', async () => {
    const { context } = await oneContext();
    const first = body(context);
    const restated = body(context, {
      statement: '  the parser still returns a day for an impossible date on one input shape. ',
    });
    const { dispositions } = await weighed([first, restated]);

    expect(dispositions.map((entry) => entry.disposition)).toEqual([
      'VALID_REPAIR_CANDIDATE',
      'DUPLICATE',
    ]);
    expect(dispositions[1]?.reason).toMatch(/duplicate of/i);
  });

  it('weighs every finding, in the order it arrived', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context),
      body(context, { severity: 'MEDIUM', statement: 'The deletion of README.md is unexplained.' }),
      body(context, { category: 'SECURITY', statement: 'Something may leak.' }),
    ]);

    expect(dispositions.map((entry) => entry.index)).toEqual([0, 1, 2]);
    for (const entry of dispositions) expect(entry.reason.trim().length).toBeGreaterThan(10);
  });
});

describe.skipIf(!AVAILABLE)('what the findings are bound to', () => {
  it('marks every finding stale when the patch moved while it was being read', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context)], 'STALE', 'b'.repeat(64));

    expect(dispositions[0]?.disposition).toBe('STALE');
    expect(dispositions[0]?.reason).toMatch(/changed|different patch/i);
  });

  it('binds nothing when the current patch could not be measured', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context)], 'UNMEASURABLE', null);

    expect(dispositions[0]?.disposition).toBe('STALE');
    expect(dispositions[0]?.reason).toMatch(/not measured|cannot/i);
  });

  it('hands the record a document it can validate', async () => {
    const { context } = await oneContext();
    const findings = [body(context), body(context, { severity: 'LOW' })];
    const { dispositions } = await weighed(findings);

    const document = buildReviewDocument({
      runId: context.runId,
      baseSha: context.baseSha,
      reviewedPatchIdentity: context.reviewedPatchIdentity,
      currentPatchIdentity: context.reviewedPatchIdentity,
      modelId: 'answered-model-id',
      reviewedAt: '2026-09-26T09:00:00.000Z',
      attempts: 1,
      body: { summary: 'One repairable gap and one worth a human.', findings },
      dispositions,
    });

    expect(parseReviewDocument(document).findings.map((finding) => finding.disposition)).toEqual([
      'VALID_REPAIR_CANDIDATE',
      'NEEDS_HUMAN_REVIEW',
    ]);
    expect(document.patchPrecondition.status).toBe('MATCHED');
  });

  it('cannot produce a repair candidate for a patch that has moved', async () => {
    const { context } = await oneContext();
    const findings = [body(context)];
    const { dispositions } = await weighed(findings, 'STALE', 'c'.repeat(64));

    const document = buildReviewDocument({
      runId: context.runId,
      baseSha: context.baseSha,
      reviewedPatchIdentity: context.reviewedPatchIdentity,
      currentPatchIdentity: 'c'.repeat(64),
      modelId: 'answered-model-id',
      reviewedAt: '2026-09-26T09:00:00.000Z',
      attempts: 1,
      body: { summary: 'A review of a patch that no longer exists.', findings },
      dispositions,
    });

    expect(document.patchPrecondition.status).toBe('STALE');
    expect(
      document.findings.some((finding) => finding.disposition === 'VALID_REPAIR_CANDIDATE'),
    ).toBe(false);
  });
});

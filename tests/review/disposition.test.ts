import { afterAll, describe, expect, it } from 'vitest';
import { assembleReviewContext, type ReviewContext } from '../../src/review/context.js';
import type { ReviewContextManifest } from '../../src/review/manifest.js';
import type { ReviewPatchBinding } from '../../src/review/engine.js';
import { buildReviewDocument, parseReviewDocument } from '../../src/review/schema.js';
import {
  reviewFindingBodySchema,
  type ReviewFindingBody,
  type ReviewDisposition,
} from '../../src/review/schema.js';
import { weighFindings } from '../../src/review/disposition.js';
import { planTouching } from '../helpers/implement.js';
import {
  cleanUp,
  hasGit,
  recordWith,
  REVIEW_TRANSCRIPT_MARKER,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * Who decides what happens to a finding — Stage 9's contested step.
 *
 * A model files findings; MergeSutra decides what they are worth. Every rule here
 * is a fact a reader can go and check against the manifest this stage authored:
 * does that reference id exist, does it point where the finding says it points,
 * was that file's content actually on the page, does this run owe anything about
 * it? A finding that fails one of those is not a softer finding, it is an
 * unsupported claim, and filing it as a repair candidate would spend a bounded
 * cycle and a human's attention on a sentence.
 *
 * The route is separately bounded: repair cycles are finite, so only a finding
 * that names a file a repair could actually be aimed at enters one, and a
 * security or policy claim goes to a person whatever it says about itself.
 *
 * The two cases that look like loopholes and are not: a file the *patch* left out
 * can still be a genuine defect, so a plan-named file the reviewer was shown is a
 * legal anchor — while a path nobody showed the reviewer is never one, however
 * well the finding reads.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

const OMITTED = '.github/workflows/ci.yml';

interface DispositionCase {
  readonly movePatchAfterVerification?: boolean;
  readonly maxFileBytes?: number;
}

const contexts = new Map<string, Promise<{ fixture: ReviewFixture; context: ReviewContext }>>();

async function oneContext(testCase: DispositionCase = {}) {
  const key = JSON.stringify(testCase);
  let shared = contexts.get(key);
  if (!shared) {
    shared = (async () => {
      const fixture = await reviewFixture(made, {
        ...(testCase.movePatchAfterVerification ? { movePatchAfterVerification: true } : {}),
      });
      const record = recordWith(fixture.record, {
        plan: planTouching(['src/parse.ts', 'src/calendar.ts', OMITTED]),
      });
      const context = await assembleReviewContext({
        record,
        workspace: fixture.workspace,
        patch: fixture.patch,
        ...(testCase.maxFileBytes ? { limits: { maxFileBytes: testCase.maxFileBytes } } : {}),
      });
      return { fixture, context };
    })();
    contexts.set(key, shared);
  }
  return shared;
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

function body(context: ReviewContext, over: Record<string, unknown> = {}): ReviewFindingBody {
  const criterion = context.criteria[0]?.id ?? 'AC-1';
  return reviewFindingBodySchema.parse({
    severity: 'HIGH',
    category: 'CORRECTNESS',
    statement: 'The parser still returns a day for an impossible date on one input shape.',
    impact: 'A caller that trusts the return value stores the wrong day and never hears about it.',
    evidence: 'src/parse.ts returns a Date built from an unvalidated string.',
    file: 'src/parse.ts',
    criterionIds: [criterion],
    contextRefs: [refTo(context, 'src/parse.ts'), criterionRef(context, criterion)],
    proposedAction: 'Change src/parse.ts to reject the day before constructing a Date.',
    ...over,
  });
}

function weighIn(
  context: ReviewContext,
  findings: readonly ReviewFindingBody[],
  binding: ReviewPatchBinding = 'MATCHED',
  currentPatchIdentity?: string | null,
  manifest?: ReviewContextManifest,
) {
  return weighFindings({
    context,
    findings,
    binding,
    currentPatchIdentity:
      currentPatchIdentity === undefined ? context.reviewedPatchIdentity : currentPatchIdentity,
    ...(manifest ? { manifest } : {}),
  });
}

async function weighed(
  findings: readonly ReviewFindingBody[],
  binding: ReviewPatchBinding = 'MATCHED',
  currentPatchIdentity?: string | null,
  manifest?: ReviewContextManifest,
) {
  const { context } = await oneContext();
  return {
    context,
    dispositions: weighIn(context, findings, binding, currentPatchIdentity, manifest),
  };
}

function only(dispositions: readonly { disposition: ReviewDisposition; reason: string }[]) {
  expect(dispositions).toHaveLength(1);
  const first = dispositions[0];
  if (!first) throw new Error('no disposition');
  return first;
}

describe.skipIf(!AVAILABLE)('what a finding must survive before MergeSutra believes it', () => {
  it('accepts a finding that cites the reference for a file in this patch', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context)]);

    expect(only(dispositions).disposition).toBe('VALID_REPAIR_CANDIDATE');
    expect(only(dispositions).reason).toMatch(/src\/parse\.ts/);
  });

  it('accepts a finding that cites the receipt it read rather than quoting it', async () => {
    const { context } = await oneContext();
    const gate = context.verification.gates[0];
    const { dispositions } = await weighed([
      body(context, {
        category: 'TEST_GAP',
        evidence: 'The one receipt this run produced says nothing about dates.',
        contextRefs: [
          refTo(context, 'src/parse.ts'),
          receiptRef(context, gate?.gateId ?? 'VG-001'),
        ],
        proposedAction: 'Add a case to src/parse.ts’s test that asserts the rejection.',
      }),
    ]);

    expect(only(dispositions).disposition).toBe('VALID_REPAIR_CANDIDATE');
  });

  it('accepts truthful evidence whose wording is not a copy of the page', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        evidence:
          '  the   returned    Date     is   built    from   an    unvalidated   string  ,  unchanged  ',
      }),
    ]);

    expect(only(dispositions).disposition).toBe('VALID_REPAIR_CANDIDATE');
  });

  it('refuses a finding that cites no reference at all', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context, { contextRefs: [] })]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/reference/i);
  });

  it('refuses a reference id this review never issued', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, { contextRefs: ['CTX-999', refTo(context, 'src/parse.ts')] }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/CTX-999/);
  });

  it('refuses a real quotation aimed at the wrong reference', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        file: 'package-lock.json',
        evidence: 'package-lock.json still pins the version `src/parse.ts` imports.',
        contextRefs: [refTo(context, 'src/parse.ts')],
      }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/package-lock\.json|point|cite/i);
  });

  it('refuses a path no material of this run carries, whether or not it exists', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        file: 'src/schema.ts',
        evidence: 'src/schema.ts validates the old shape and was never shown here.',
        contextRefs: [refTo(context, 'src/parse.ts')],
      }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/never|not.*shown|no reference/i);
  });

  it('refuses a finding about the content of a file whose content was withheld', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        category: 'CORRECTNESS',
        file: '.env',
        evidence: '.env holds a credential in clear text.',
        contextRefs: [refTo(context, '.env')],
      }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/withheld|not.*sent|content/i);
  });

  it('refuses a line range beyond the part of the file that was sent', async () => {
    const { context } = await oneContext({ maxFileBytes: 160 });
    const parse = context.manifest.references.find(
      (reference) => reference.path === 'src/parse.ts',
    );
    expect(parse?.partial).toBe(true);
    const linesSent = parse?.linesSent ?? 0;

    const dispositions = weighIn(context, [
      body(context, {
        contextRefs: [parse?.ref ?? 'CTX-001'],
        lineRange: { from: linesSent + 40, to: linesSent + 80 },
      }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/line|sent|truncated/i);
  });

  it('refuses a finding that names a criterion the contract never issued', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, { criterionIds: ['AC-77'], contextRefs: [refTo(context, 'src/parse.ts')] }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toContain('AC-77');
  });

  it('refuses evidence that quotes something the reviewer was never shown', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        evidence: `The author’s own note says: "${REVIEW_TRANSCRIPT_MARKER}" and asks us to accept it.`,
      }),
    ]);

    expect(only(dispositions).disposition).toBe('UNSUPPORTED');
    expect(only(dispositions).reason).toMatch(/material|shown|quote/i);
  });

  it('routes an action that names nothing to a human rather than the repair loop', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, { proposedAction: 'Tighten this up before it ships.' }),
    ]);

    expect(only(dispositions).disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(only(dispositions).reason).toMatch(/names|route/i);
  });
});

describe.skipIf(!AVAILABLE)('a file the patch forgot, and a file nobody showed', () => {
  it('accepts the finding that names the in-scope file this patch never touched', async () => {
    const { context } = await oneContext();
    const criterion = context.criteria[0]?.id ?? 'AC-1';
    const { dispositions } = await weighed([
      body(context, {
        category: 'REQUIREMENT_GAP',
        file: OMITTED,
        statement:
          'CI still runs only the old test list, so the criterion the patch claims to satisfy is never checked.',
        evidence:
          'The workflow named in the plan was left alone, and its steps do not run the new case.',
        criterionIds: [criterion],
        contextRefs: [refTo(context, OMITTED), criterionRef(context, criterion)],
        proposedAction: `Update ${OMITTED} so the new test file runs in CI.`,
      }),
    ]);

    expect(only(dispositions).disposition).toBe('VALID_REPAIR_CANDIDATE');
    expect(only(dispositions).reason).toMatch(/patch does not touch|not touched|forgot/i);
  });

  it('will not repair an untouched file that nothing in the contract asks about', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        file: OMITTED,
        criterionIds: [],
        contextRefs: [refTo(context, OMITTED)],
        proposedAction: `Rewrite ${OMITTED} to be shorter.`,
      }),
    ]);

    expect(only(dispositions).disposition).toBe('OUT_OF_SCOPE');
    expect(only(dispositions).reason).toMatch(/criterion|contract|owes/i);
  });

  it('keeps a policy file that was named but never sent off the repair route', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([
      body(context, {
        file: 'package.json',
        evidence: 'package.json declares a check script this run never ran.',
        contextRefs: [refTo(context, 'package.json')],
      }),
    ]);

    expect(only(dispositions).disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(only(dispositions).reason).toMatch(/content .*not|never sent|listed/i);
  });

  it('will not weigh a finding whose file is outside the repository at all', async () => {
    const { context } = await oneContext();

    expect(() =>
      body(context, {
        file: '../../etc/passwd',
        evidence: 'outside the repository.',
        contextRefs: [refTo(context, 'src/parse.ts')],
      }),
    ).toThrow(/repository-relative/i);
  });

  it('will not let a finding carry a reference it invented as a path', async () => {
    const { context } = await oneContext();

    expect(() => body(context, { contextRefs: ['../../etc/passwd'] })).toThrow(/CTX-/);
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

    expect(only(dispositions).disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(only(dispositions).reason).toMatch(/model finding/i);
    expect(only(dispositions).reason).not.toMatch(/proven|a confirmed risk|not a real risk/i);
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

    expect(only(dispositions).disposition).toBe('NEEDS_HUMAN_REVIEW');
  });

  it('keeps a low-severity finding on the record and off the repair budget', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context, { severity: 'LOW' })]);

    expect(only(dispositions).disposition).toBe('NEEDS_HUMAN_REVIEW');
    expect(only(dispositions).reason).toMatch(/budget|cycle/i);
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

    expect(only(dispositions).disposition).toBe('STALE');
    expect(only(dispositions).reason).toMatch(/changed|different patch/i);
  });

  it('binds nothing when the current patch could not be measured', async () => {
    const { context } = await oneContext();
    const { dispositions } = await weighed([body(context)], 'UNMEASURABLE', null);

    expect(only(dispositions).disposition).toBe('STALE');
    expect(only(dispositions).reason).toMatch(/not measured|cannot/i);
  });

  it('refuses to weigh a finding against a manifest from a different patch', async () => {
    const { context } = await oneContext();
    const other: ReviewContextManifest = {
      ...context.manifest,
      reviewedPatchIdentity: 'd'.repeat(64),
    };
    const { dispositions } = await weighed([body(context)], 'MATCHED', undefined, other);

    expect(only(dispositions).disposition).toBe('STALE');
    expect(only(dispositions).reason).toMatch(/manifest|different patch/i);
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

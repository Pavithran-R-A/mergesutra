import { describe, expect, it } from 'vitest';
import {
  REVIEW_CATEGORIES,
  REVIEW_SEVERITIES,
  buildReviewDocument,
  findingKey,
  parseReviewBody,
  parseReviewDocument,
  type ReviewDocumentInput,
} from '../../src/review/schema.js';

/**
 * The review protocol — Stage 9.
 *
 * A reviewer's answer is the second model-written artifact in this product, and
 * it is more dangerous than the first: a plan that is wrong gets checked by
 * gates, while a review is the thing a reader consults when the gates were
 * silent. So the protocol is built to be incapable of the two errors a review
 * can make — deciding its own case, and describing a patch it never saw.
 *
 * Hence the shape: `reviewBodySchema` is what the model may say (a finding with
 * an anchor and a proposed repair, never a status), and `reviewDocumentSchema`
 * is what MergeSutra stores after it has added the facts the model does not get
 * to assert — which patch was pinned when the request went out, which patch is
 * on disk now, which id each finding carries, and what became of it.
 */

function finding(over: Record<string, unknown> = {}) {
  return {
    severity: 'HIGH',
    category: 'REQUIREMENT_GAP',
    statement: 'parseDate accepts 2026-02-30, which the contract says must be rejected.',
    impact: 'A caller reading a calendar date gets a valid-looking wrong day.',
    evidence: 'src/date.ts line 41 validates the parts independently, never as a pair.',
    file: 'src/date.ts',
    lineRange: { from: 38, to: 44 },
    criterionIds: ['AC-2'],
    proposedAction: 'Validate the day against the month, and cover 2026-02-30 in the test file.',
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return { summary: 'One gap around day-of-month validation.', findings: [finding()], ...over };
}

function documentInput(over: Partial<ReviewDocumentInput> = {}): ReviewDocumentInput {
  return {
    runId: 'run-20260926T090000z-rev001',
    baseSha: 'a'.repeat(40),
    reviewedPatchIdentity: 'b'.repeat(64),
    currentPatchIdentity: 'b'.repeat(64),
    modelId: 'bharatcode-test-model',
    reviewedAt: '2026-09-26T09:00:00.000Z',
    attempts: 1,
    body: parseReviewBody(body()),
    dispositions: [
      { index: 0, disposition: 'VALID_REPAIR_CANDIDATE', reason: 'file and AC-2 exist' },
    ],
    ...over,
  };
}

describe('what a reviewer is allowed to say', () => {
  it('accepts a finding that names its anchor and its repair', () => {
    const parsed = parseReviewBody(body());

    expect(parsed.findings[0]?.severity).toBe('HIGH');
    expect(parsed.findings[0]?.criterionIds).toEqual(['AC-2']);
  });

  it('accepts a review that found nothing, and records that as no findings', () => {
    const parsed = parseReviewBody(body({ findings: [] }));

    expect(parsed.findings).toEqual([]);
    expect(parsed.summary).toBe('One gap around day-of-month validation.');
  });

  it('refuses a finding that carries a status, because that verdict is not its to file', () => {
    expect(() => parseReviewBody(body({ findings: [finding({ status: 'PASS' })] }))).toThrowError();
  });

  it('refuses a review body that concludes the contribution is ready', () => {
    expect(() =>
      parseReviewBody(body({ contributionReady: true } as Record<string, unknown>)),
    ).toThrowError();
  });

  it('refuses a severity it was not given words for', () => {
    const error = firstError(() =>
      parseReviewBody(body({ findings: [finding({ severity: 'CRITICAL' })] })),
    );

    expect(error).toMatch(/severity/i);
    expect(REVIEW_SEVERITIES).toEqual(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']);
  });

  it('refuses a category the model invented', () => {
    expect(() =>
      parseReviewBody(body({ findings: [finding({ category: 'VIBE' })] })),
    ).toThrowError();
    expect(REVIEW_CATEGORIES).toContain('TEST_GAP');
  });

  it('refuses a finding with nothing to check it against', () => {
    const unanchored = finding({
      file: undefined,
      lineRange: undefined,
      criterionIds: undefined,
    });

    const error = firstError(() => parseReviewBody(body({ findings: [unanchored] })));

    expect(error, 'a finding must name a file or a criterion').toMatch(/file|criterion/i);
  });

  it('refuses a finding whose evidence is an empty gesture', () => {
    expect(() => parseReviewBody(body({ findings: [finding({ evidence: '  ' })] }))).toThrowError();
  });

  it('refuses a finding that points outside the repository', () => {
    expect(() =>
      parseReviewBody(body({ findings: [finding({ file: '../../etc/passwd' })] })),
    ).toThrowError();
  });

  it('refuses a line range that runs backwards', () => {
    expect(() =>
      parseReviewBody(body({ findings: [finding({ lineRange: { from: 44, to: 38 } })] })),
    ).toThrowError();
  });

  it('refuses a criterion id from another contract', () => {
    expect(() =>
      parseReviewBody(body({ findings: [finding({ criterionIds: ['C-9'] })] })),
    ).toThrowError();
  });

  it('refuses a numeric confidence, because a score would be read as a measurement', () => {
    expect(() =>
      parseReviewBody(body({ findings: [finding({ confidence: 0.93 })] })),
    ).toThrowError();
  });

  it('records a qualitative confidence without letting it stand for the anchor', () => {
    const parsed = parseReviewBody(body({ findings: [finding({ confidence: 'MEDIUM' })] }));

    expect(parsed.findings[0]?.confidence).toBe('MEDIUM');
  });

  it('refuses a finding that names itself', () => {
    expect(() => parseReviewBody(body({ findings: [finding({ id: 'RF-007' })] }))).toThrowError();
  });
});

describe('what MergeSutra stores about a review', () => {
  it('numbers the findings in the order they arrived, whatever the model called them', () => {
    const document = buildReviewDocument(
      documentInput({
        body: parseReviewBody(
          body({
            findings: [
              finding(),
              finding({
                severity: 'LOW',
                category: 'MAINTAINABILITY',
                statement: 'The month table is duplicated in two modules.',
              }),
            ],
          }),
        ),
        dispositions: [
          { index: 0, disposition: 'VALID_REPAIR_CANDIDATE', reason: 'anchored' },
          { index: 1, disposition: 'NEEDS_HUMAN_REVIEW', reason: 'an architectural trade-off' },
        ],
      }),
    );

    expect(document.findings.map((entry) => entry.id)).toEqual(['RF-001', 'RF-002']);
  });

  it('names the patch it examined and the patch that exists now, in the same document', () => {
    const document = parseReviewDocument(buildReviewDocument(documentInput()));

    expect(document.reviewedPatchIdentity).toBe('b'.repeat(64));
    expect(document.currentPatchIdentity).toBe('b'.repeat(64));
    expect(document.patchPrecondition.status).toBe('MATCHED');
  });

  it('calls a review of a moved workspace stale instead of quiet', () => {
    const document = buildReviewDocument(documentInput({ currentPatchIdentity: 'c'.repeat(64) }));

    expect(document.patchPrecondition.status).toBe('STALE');
    expect(document.patchPrecondition.reason).toMatch(/changed|moved|stale/i);
  });

  it('refuses a finding whose disposition MergeSutra never issues', () => {
    const stored = buildReviewDocument(documentInput()) as unknown as {
      findings: Record<string, unknown>[];
    };
    stored.findings[0]!.disposition = 'IGNORED';

    expect(() => parseReviewDocument(stored)).toThrowError();
  });

  it('refuses a review that records no disposition for a finding it recorded', () => {
    expect(() =>
      buildReviewDocument(
        documentInput({
          body: parseReviewBody(body({ findings: [finding(), finding({ severity: 'LOW' })] })),
          dispositions: [{ index: 0, disposition: 'UNSUPPORTED', reason: 'no such file' }],
        }),
      ),
    ).toThrowError(/RF-002|second|disposition/i);
  });

  it('keeps a review document free of readiness vocabulary', () => {
    const stored = buildReviewDocument(documentInput()) as unknown as Record<string, unknown>;
    stored.contributionReady = true;

    expect(() => parseReviewDocument(stored)).toThrowError();
  });

  it('persists the model id actually used rather than the one advertised', () => {
    const document = buildReviewDocument(documentInput({ modelId: 'deepseek-v4.1-flash' }));

    expect(document.modelId).toBe('deepseek-v4.1-flash');
    expect(parseReviewDocument(document).attempts).toBe(1);
  });

  it('refuses a review of a patch it cannot name', () => {
    expect(() =>
      buildReviewDocument(documentInput({ reviewedPatchIdentity: 'not-a-digest' })),
    ).toThrowError();
  });
});

describe('recognising a finding that has already been weighed', () => {
  it('keys a finding by what it says, not by the number it was given', () => {
    const first = buildReviewDocument(documentInput());
    const second = buildReviewDocument(
      documentInput({
        body: parseReviewBody(
          body({
            findings: [
              finding({
                statement:
                  '  parseDate accepts 2026-02-30, which the contract says must be rejected. ',
              }),
            ],
          }),
        ),
      }),
    );

    expect(findingKey(first.findings[0]!)).toBe(findingKey(second.findings[0]!));
  });

  it('does not collapse a different complaint about the same file', () => {
    const parsed = parseReviewBody(
      body({
        findings: [
          finding(),
          finding({ statement: 'The same function throws RangeError on year 0.' }),
        ],
      }),
    );
    const document = buildReviewDocument(
      documentInput({
        body: parsed,
        dispositions: [
          { index: 0, disposition: 'VALID_REPAIR_CANDIDATE', reason: 'anchored' },
          { index: 1, disposition: 'VALID_REPAIR_CANDIDATE', reason: 'anchored' },
        ],
      }),
    );

    expect(findingKey(document.findings[0]!)).not.toBe(findingKey(document.findings[1]!));
  });

  it('separates the same words filed at a different severity', () => {
    const low = buildReviewDocument(
      documentInput({
        body: parseReviewBody(body({ findings: [finding({ severity: 'LOW' })] })),
        dispositions: [{ index: 0, disposition: 'OUT_OF_SCOPE', reason: 'cosmetic' }],
      }),
    );
    const blocker = buildReviewDocument(documentInput());

    expect(findingKey(low.findings[0]!)).not.toBe(findingKey(blocker.findings[0]!));
  });
});

function firstError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the schema to refuse, and it accepted');
}

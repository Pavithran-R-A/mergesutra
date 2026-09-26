import { afterAll, describe, expect, it } from 'vitest';
import {
  assembleReviewContext,
  MAX_REVIEW_CONTEXT_BYTES,
  MAX_REVIEW_FILE_BYTES,
  REVIEW_CONTEXT_SCHEMA_VERSION,
  type ReviewContext,
  type ReviewContextLimits,
} from '../../src/review/context.js';
import { createRunRecord, type RunRecord } from '../../src/state/run-record.js';
import { TEST_MODEL } from '../helpers/bharatcode.js';
import {
  cleanUp,
  hasGit,
  REVIEW_ACTION_MARKER,
  REVIEW_LIMITATION,
  REVIEW_SECRET_VALUE,
  REVIEW_TRANSCRIPT_MARKER,
  reviewFixture,
} from '../helpers/review.js';

/**
 * The review context — Stage 9, and the part of Stage 9 that decides whether the
 * rest of it means anything.
 *
 * A review is only independent if the reviewer was handed the work and not the
 * author's opinion of it. Give it the implementation transcript and it inherits
 * that run's conclusions; give it the credential sitting in the patch and it
 * leaks one; give it a silent byte budget and it will confidently describe a
 * file it never saw. Every expectation below rules out one of those.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

interface ContextCase {
  readonly movePatchAfterVerification?: boolean;
  readonly limits?: Partial<ReviewContextLimits>;
}

async function contextFor(testCase: ContextCase = {}) {
  const fixture = await reviewFixture(made, {
    ...(testCase.movePatchAfterVerification ? { movePatchAfterVerification: true } : {}),
  });
  const context = await assembleReviewContext({
    record: fixture.record,
    workspace: fixture.workspace,
    patch: fixture.patch,
    ...(testCase.limits ? { limits: testCase.limits } : {}),
  });
  return { fixture, context };
}

describe.skipIf(!AVAILABLE)('what a review context is made of', () => {
  it('names the issue and every criterion the run was held to', async () => {
    const { fixture, context } = await contextFor();

    expect(context.issue.canonical).toBe(fixture.record.issueRef?.canonical);
    expect(context.issue.title).toBe('Parser accepts impossible dates');
    expect(context.issue.body).toContain('Impossible days are rejected');
    expect(context.criteria.map((criterion) => criterion.id)).toEqual([...fixture.criteria]);
  });

  it('carries the plan as one model intent, with the model that wrote it attached', async () => {
    const { context } = await contextFor();

    expect(context.plan?.summary.length).toBeGreaterThan(0);
    expect(context.plan?.model).toBe(TEST_MODEL);
    expect(context.plan?.filesToTouch).toContain('src/parse.ts');
    expect(context.plan?.untrusted).toBe(true);
  });

  it('shows each gate, the command it ran and how it ended', async () => {
    const { context } = await contextFor();

    expect(context.verification?.result).toBe('PASS');
    expect(context.verification?.gates[0]?.argv).toEqual(['npm', 'test']);
    expect(context.verification?.gates[0]?.result).toBe('PASS');
    expect(context.verification?.gates[0]?.exitCode).toBe(0);
  });

  it('reports the workspace the receipts were gathered in', async () => {
    const { fixture, context } = await contextFor();

    expect(context.verification?.workspace).toBe(fixture.workspace);
    expect(context.baseSha).toBe(fixture.base);
    expect(context.reviewedPatchIdentity).toBe(fixture.patch.identity);
  });

  it('carries, for each criterion, exactly what the evidence mapper was willing to say', async () => {
    const { fixture, context } = await contextFor();
    const fromRecord =
      fixture.record.evidence?.criteria.map((entry) => `${entry.criterionId}:${entry.status}`) ??
      [];
    expect(fromRecord.length).toBeGreaterThan(0);

    expect(
      context.criteria.map((criterion) => `${criterion.id}:${criterion.evidenceStatus}`),
    ).toEqual(fromRecord);
  });

  it('shows the diff of a file the patch modified', async () => {
    const { context } = await contextFor();
    const modified = fileFor(context, 'src/parse.ts');

    expect(modified.change).toBe('MODIFIED');
    expect(modified.presentation).toBe('DIFF');
    expect(modified.text).toContain('+');
    expect(modified.text).toContain('throw new Error("empty")');
  });

  it('shows a new untracked file whole, and says that it is new', async () => {
    const { context } = await contextFor();
    const added = fileFor(context, 'src/calendar.ts');

    expect(added.change).toBe('ADDED');
    expect(added.tracked).toBe(false);
    expect(added.presentation).toBe('FULL_CONTENT');
    expect(added.text).toContain('LEAP_NOTES');
    expect(added.reason).toMatch(/untracked|new/i);
  });

  it('lists a deleted file as deleted rather than showing nothing and saying nothing', async () => {
    const { context } = await contextFor();
    const deleted = fileFor(context, 'README.md');

    expect(deleted.change).toBe('DELETED');
    expect(deleted.presentation).toBe('DELETED');
    expect(deleted.text).toBe('');
    expect(deleted.reason).toMatch(/deleted|removed/i);
  });

  it('carries the caveats the earlier stages left, so nothing looks cleaner than it is', async () => {
    const { context } = await contextFor();

    expect(context.limitations).toContain(REVIEW_LIMITATION);
  });

  it('says which patch it describes, and under which version of this module', async () => {
    const { context } = await contextFor();

    expect(context.schemaVersion).toBe(REVIEW_CONTEXT_SCHEMA_VERSION);
    expect(context.bytes).toBeGreaterThan(0);
    expect(context.limits.maxFileBytes).toBe(MAX_REVIEW_FILE_BYTES);
    expect(context.limits.maxTotalBytes).toBe(MAX_REVIEW_CONTEXT_BYTES);
  });
});

describe.skipIf(!AVAILABLE)('what a review context must not contain', () => {
  it('withholds the loop’s claim that it finished, because that is the thing under review', async () => {
    const { context } = await contextFor();

    expect(JSON.stringify(context)).not.toContain(REVIEW_TRANSCRIPT_MARKER);
    expect(context).not.toHaveProperty('implementation');
  });

  it('withholds the action log, which records attempts rather than bytes', async () => {
    const { context } = await contextFor();

    expect(JSON.stringify(context)).not.toContain(REVIEW_ACTION_MARKER);
  });

  it('states, in data, what it left out and why', async () => {
    const { context } = await contextFor();
    const excluded = context.excluded.join('\n');

    expect(excluded).toMatch(/transcript|action log/i);
    expect(excluded).toMatch(/finish|claim/i);
  });

  it('lists a credential in the patch without letting its bytes near a model', async () => {
    const { context } = await contextFor();
    const secret = fileFor(context, '.env');

    expect(secret.presentation).toBe('WITHHELD');
    expect(secret.text).toBe('');
    expect(secret.reason).toMatch(/credential|environment/i);
    expect(JSON.stringify(context)).not.toContain(REVIEW_SECRET_VALUE);
  });

  it('refuses to send binary content to the reviewer as if it were source', async () => {
    const { context } = await contextFor();
    const binary = fileFor(context, 'assets/blob.dat');

    expect(binary.presentation).toBe('WITHHELD');
    expect(binary.text).toBe('');
    expect(binary.reason).toMatch(/binary/i);
  });
});

describe.skipIf(!AVAILABLE)('how a review context is bounded', () => {
  it('stops at the file budget and names what it left out', async () => {
    const { context } = await contextFor({ limits: { maxFiles: 1 } });
    const contentBearing = (presentation: string) =>
      presentation === 'DIFF' || presentation === 'FULL_CONTENT';

    const sent = context.files.filter((file) => contentBearing(file.presentation));
    expect(sent).toHaveLength(1);
    expect(context.skipped.length).toBeGreaterThan(0);
    expect(context.skipped.every((entry) => entry.reason.length > 0)).toBe(true);
    expect(context.skipped.map((entry) => entry.reason).join(' ')).toMatch(/budget|limit/i);
  });

  it('marks a file it could not send whole instead of sending a prefix quietly', async () => {
    const { context } = await contextFor({ limits: { maxFileBytes: 40 } });
    const modified = fileFor(context, 'src/parse.ts');

    expect(modified.truncated).toBe(true);
    expect(modified.text).toMatch(/truncated/i);
  });

  it('keeps the total budget and lands every patch file in exactly one list', async () => {
    const { fixture, context } = await contextFor({ limits: { maxTotalBytes: 64 } });

    expect(context.bytes).toBeLessThanOrEqual(64);
    expect(context.files.length + context.skipped.length).toBe(fixture.patch.files.length);
  });
});

describe.skipIf(!AVAILABLE)('what a review context refuses to describe', () => {
  it('refuses a run that has no Acceptance Contract to review against', async () => {
    const { fixture } = await contextFor();
    const bare = createRunRecord({
      ...withoutDocuments(fixture.record),
      acceptanceContract: null,
    });

    const error = await failure(
      assembleReviewContext({ record: bare, workspace: fixture.workspace, patch: fixture.patch }),
    );
    expect(error.message).toMatch(/Acceptance Contract/i);
  });

  it('refuses a run that has not been verified, because there would be no receipts to weigh', async () => {
    const { fixture } = await contextFor();
    const bare = createRunRecord({ ...withoutDocuments(fixture.record), verification: null });

    const error = await failure(
      assembleReviewContext({ record: bare, workspace: fixture.workspace, patch: fixture.patch }),
    );
    expect(error.message).toMatch(/verif/i);
    expect(error.remediation).toMatch(/mergesutra verify/i);
  });

  it('refuses a patch measured from a different base than this run recorded', async () => {
    const { fixture } = await contextFor();

    const error = await failure(
      assembleReviewContext({
        record: fixture.record,
        workspace: fixture.workspace,
        patch: { ...fixture.patch, baseSha: 'c'.repeat(40) },
      }),
    );
    expect(error.message).toMatch(/base/i);
  });

  it('refuses a patch identity that is not a digest, because that is not a name', async () => {
    const { fixture } = await contextFor();

    const error = await failure(
      assembleReviewContext({
        record: fixture.record,
        workspace: fixture.workspace,
        patch: { ...fixture.patch, identity: 'working-copy' },
      }),
    );
    expect(error.message).toMatch(/digest/i);
  });

  it('says the Stage 7 receipts are stale when the patch has already moved', async () => {
    const { fixture, context } = await contextFor({ movePatchAfterVerification: true });

    expect(context.verification?.currency).toBe('STALE');
    expect(context.verification?.currencyReason).toMatch(/different patch|stale|no longer/i);
    expect(context.verification?.patchIdentity).toBe(fixture.verifiedIdentity);
    expect(context.reviewedPatchIdentity).not.toBe(fixture.verifiedIdentity);
  });
});

function fileFor(context: ReviewContext, relativePath: string) {
  const found = context.files.find((file) => file.path === relativePath);
  if (!found) throw new Error(`the context never mentioned ${relativePath}`);
  return found;
}

/** The record with Stage 4-7's documents stripped, so a boundary can be tested. */
function withoutDocuments(record: RunRecord): Parameters<typeof createRunRecord>[0] {
  return {
    runId: record.runId,
    createdAt: record.createdAt,
    stage: record.stage,
    outcome: record.outcome,
    issueRef: record.issueRef,
    issue: record.issue,
    repository: record.repository,
    base: record.base,
    local: record.local,
    contract: record.contract,
    acceptanceContract: record.acceptanceContract,
    plan: record.plan,
    implementation: record.implementation,
    verificationPlan: record.verificationPlan,
    verification: record.verification,
    executionConsent: record.executionConsent,
    evidence: record.evidence,
    checks: record.checks,
    limitations: record.limitations,
    nextStage: record.nextStage,
  };
}

async function failure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
  } catch (error) {
    return error as AppFailure;
  }
  throw new Error('expected the context to refuse');
}

interface AppFailure {
  readonly message: string;
  readonly remediation?: string;
}

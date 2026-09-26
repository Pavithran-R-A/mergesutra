import { afterAll, describe, expect, it } from 'vitest';
import { assembleReviewContext, type ReviewContext } from '../../src/review/context.js';
import {
  MAX_REVIEW_SCOPE_TOTAL_BYTES,
  REVIEW_REFERENCE_KINDS,
  type ReviewReference,
} from '../../src/review/manifest.js';
import { reviewMaterial } from '../../src/review/prompt.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { planTouching } from '../helpers/implement.js';
import {
  cleanUp,
  hasGit,
  recordWith,
  REVIEW_SECRET_VALUE,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * Who owns the names a finding may point at — Stage 9's provenance rule.
 *
 * A reviewer with no tools can only repeat what it was shown, so the checkable
 * version of "this finding is grounded" is "this finding cites material
 * MergeSutra itself put on the page, under an id MergeSutra assigned". If the
 * reviewer could name a file to gain standing, every path it hallucinated would
 * become a repair target, and the stage would have handed the model the authority
 * the confined reader exists to withhold.
 *
 * So the manifest is authored here and only here: one reference per patch file,
 * per criterion, per receipt, per policy file the repository contract was read
 * from, and per file the plan said it would touch and the patch left alone. That
 * last kind is the reason the manifest exists at all — the most useful thing a
 * second reader can catch is a file that is *missing*, and a missing file is by
 * definition not in the diff.
 *
 * Nothing in a reference grants reach. The listed policy files are named, not
 * sent; a withheld file is recorded as withheld with no lines; and the count of
 * lines actually sent is stored so a citation past the truncation point can be
 * refused rather than admired.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

/** A plan that also promised the CI workflow, which the patch never touches. */
const PROMISED = ['src/parse.ts', 'src/calendar.ts', '.github/workflows/ci.yml'];
const OMITTED = '.github/workflows/ci.yml';

let shared: Promise<{ fixture: ReviewFixture; context: ReviewContext }> | null = null;

async function oneManifest() {
  if (!shared) {
    shared = (async () => {
      const fixture = await reviewFixture(made);
      const record = recordWith(fixture.record, {
        plan: planTouching(PROMISED),
      });
      const context = await assembleReviewContext({
        record,
        workspace: fixture.workspace,
        patch: fixture.patch,
      });
      return { fixture, context };
    })();
  }
  return shared;
}

function refsOfKind(context: ReviewContext, kind: string): ReviewReference[] {
  return context.manifest.references.filter((reference) => reference.kind === kind);
}

function refFor(context: ReviewContext, path: string): ReviewReference {
  const found = context.manifest.references.find((reference) => reference.path === path);
  if (!found) throw new Error(`the manifest carries no reference for ${path}`);
  return found;
}

describe.skipIf(!AVAILABLE)('who authors the references a finding may cite', () => {
  it('gives every file of the patch its own reference, and no file it does not have', async () => {
    const { fixture, context } = await oneManifest();

    const paths = refsOfKind(context, 'PATCH').map((reference) => reference.path);
    expect(paths).toEqual(fixture.patch.files.map((file) => file.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('numbers references so pointing at one names exactly one piece of material', async () => {
    const { context } = await oneManifest();
    const ids = context.manifest.references.map((reference) => reference.ref);

    expect(ids.every((id) => /^CTX-\d{3}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('CTX-001');
  });

  it('binds the manifest to the patch it describes, so it cannot answer for another', async () => {
    const { fixture, context } = await oneManifest();

    expect(context.manifest.reviewedPatchIdentity).toBe(fixture.patch.identity);
    expect(context.manifest.runId).toBe(fixture.record.runId);
  });

  it('records how many lines the reviewer was given of a file it could not send whole', async () => {
    const { context } = await oneManifest();
    const modified = refFor(context, 'src/parse.ts');

    expect(modified.kind).toBe('PATCH');
    expect(modified.linesSent).toBeGreaterThan(0);
    expect(modified.partial).toBe(false);
  });

  it('says a withheld file was withheld, with no lines behind it', async () => {
    const { context } = await oneManifest();
    const secret = refFor(context, '.env');

    expect(secret.presentation).toBe('WITHHELD');
    expect(secret.linesSent).toBe(0);
    expect(secret.detail).toMatch(/credential|withheld/i);
    expect(JSON.stringify(context.manifest)).not.toContain(REVIEW_SECRET_VALUE);
  });

  it('lists each obligation of the Acceptance Contract as a reference', async () => {
    const { fixture, context } = await oneManifest();

    expect(refsOfKind(context, 'CRITERION').map((reference) => reference.criterionId)).toEqual([
      ...fixture.criteria,
    ]);
  });

  it('lists each receipt the gates produced as a reference', async () => {
    const { context } = await oneManifest();

    expect(refsOfKind(context, 'RECEIPT').map((reference) => reference.gateId)).toEqual(
      context.verification.gates.map((gate) => gate.gateId),
    );
  });

  it('names the repository files the gates were read from without sending their bytes', async () => {
    const { context } = await oneManifest();
    const policy = refsOfKind(context, 'POLICY');

    expect(policy.length).toBeGreaterThan(0);
    expect(policy.every((reference) => reference.presentation === 'LISTED')).toBe(true);
    expect(policy.every((reference) => reference.linesSent === 0)).toBe(true);
    expect(policy.map((reference) => reference.path)).toContain('package.json');
  });

  it('uses only the reference kinds this module defines', async () => {
    const { context } = await oneManifest();

    for (const reference of context.manifest.references) {
      expect(REVIEW_REFERENCE_KINDS).toContain(reference.kind);
    }
  });
});

describe.skipIf(!AVAILABLE)('the file the patch forgot', () => {
  it('gives a plan-named file the patch never touched a reference of its own', async () => {
    const { context } = await oneManifest();
    const omitted = refFor(context, OMITTED);

    expect(omitted.kind).toBe('SOURCE');
    expect(omitted.origin).toBe('PLAN');
    expect(omitted.linesSent).toBeGreaterThan(0);
    expect(omitted.detail).toMatch(/plan/i);
  });

  it('shows that file’s bytes to the reviewer, so a citation of them can be true', async () => {
    const { context } = await oneManifest();
    const material = reviewMaterial(context);

    expect(material).toContain(OMITTED);
    expect(material).toMatch(/run ci|npm run format:check|actions\/checkout/i);
  });

  it('does not list a promised file twice, once as patch and once as source', async () => {
    const { context } = await oneManifest();
    const forParse = context.manifest.references.filter(
      (reference) => reference.path === 'src/parse.ts',
    );

    expect(forParse).toHaveLength(1);
    expect(forParse[0]?.kind).toBe('PATCH');
  });

  it('refuses to reference a file the repository does not have, however confidently the plan named it', async () => {
    const fixture = await reviewFixture(made);
    const record = recordWith(fixture.record, {
      plan: planTouching(['src/parse.ts', 'src/never-written.ts']),
    });
    const context = await assembleReviewContext({
      record,
      workspace: fixture.workspace,
      patch: fixture.patch,
    });

    expect(
      context.manifest.references.some((reference) => reference.path === 'src/never-written.ts'),
    ).toBe(false);
    expect(context.manifest.limitations.join('\n')).toMatch(/src\/never-written\.ts/);
  });

  it('keeps the extra reading inside its own budget', async () => {
    const { context } = await oneManifest();
    const sent = refsOfKind(context, 'SOURCE').reduce(
      (total, reference) => total + reference.linesSent,
      0,
    );

    expect(sent).toBeGreaterThan(0);
    expect(
      context.scope.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0),
    ).toBeLessThanOrEqual(MAX_REVIEW_SCOPE_TOTAL_BYTES);
  });
});

describe.skipIf(!AVAILABLE)('what the reviewer is told about the references', () => {
  it('puts every reference id on the page the model reads', async () => {
    const { context } = await oneManifest();
    const material = reviewMaterial(context);

    for (const reference of context.manifest.references) {
      expect(material).toContain(reference.ref);
    }
    expect(material).toMatch(/REFERENCE MANIFEST/i);
  });

  it('tells the reviewer that a quotation does not take the place of a reference', async () => {
    const { context } = await oneManifest();

    expect(reviewMaterial(context)).toMatch(/cite|reference id/i);
  });

  it('survives a record with no plan, which is a run with no promised files', async () => {
    const fixture = await reviewFixture(made);
    const bare: RunRecord = recordWith(fixture.record, { plan: null });
    const context = await assembleReviewContext({
      record: bare,
      workspace: fixture.workspace,
      patch: fixture.patch,
    });

    expect(refsOfKind(context, 'SOURCE')).toEqual([]);
    expect(refsOfKind(context, 'PATCH').length).toBeGreaterThan(0);
  });
});

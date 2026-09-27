import { describe, expect, it } from 'vitest';
import { candidateOf, type PublicationCandidate } from '../../src/pr/candidate.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import {
  approvePublication,
  decidePublication,
  parsePublicationApproval,
  PUBLICATION_ACTIONS,
} from '../../src/pr/approval.js';
import { candidateInput, OTHER_PATCH_IDENTITY } from '../helpers/publication.js';

/**
 * The only capability a human can grant Stage 10 — and what it does not grant.
 *
 * An approval is five fields: which run, which candidate by digest, when, and the
 * one action it opens. Everything a publisher might want to be told — which files,
 * which branch, whether to merge, whether to skip this check — is absent, because
 * each of those would be a scope nobody read. So the tests below are mostly
 * attempts to smuggle such a field in, and the rest is the digest comparison that
 * decides whether the yes still means what was said.
 */

function candidateFor(
  overrides: Partial<Parameters<typeof candidateInput>[0]> = {},
): PublicationCandidate {
  return candidateOf(candidateInput(overrides));
}

describe('writing the approval a human gives', () => {
  it('names the candidate it was written for, and the one action it opens', () => {
    const candidate = candidateFor();

    expect(approvePublication({ candidate, approvedAt: '2026-09-25T10:15:00.000Z' })).toEqual({
      schemaVersion: 1,
      runId: 'run-20260925T000000Z-pack001',
      publicationDigest: publicationDigestOf(candidate),
      approvedAt: '2026-09-25T10:15:00.000Z',
      action: 'CREATE_PULL_REQUEST',
    });
  });

  it('derives the digest from the candidate, so nobody approves a page they never built', () => {
    const candidate = candidateFor();
    const other = candidateFor({
      draft: { title: 'A different title', body: '## Summary\n\nBody.\n' },
    });
    const approval = approvePublication({
      candidate,
      approvedAt: '2026-09-25T10:15:00.000Z',
    });

    expect(approval.publicationDigest).toBe(publicationDigestOf(candidate));
    expect(approval.publicationDigest).not.toBe(publicationDigestOf(other));
  });

  it('carries no scope of its own, because the candidate is the scope', () => {
    const approval = approvePublication({
      candidate: candidateFor(),
      approvedAt: '2026-09-25T10:15:00.000Z',
    });

    expect(Object.keys(approval).sort()).toEqual([
      'action',
      'approvedAt',
      'publicationDigest',
      'runId',
      'schemaVersion',
    ]);
  });

  it('authorises opening a pull request, and that is the whole list', () => {
    expect(PUBLICATION_ACTIONS).toEqual(['CREATE_PULL_REQUEST']);
  });
});

describe('what an approval cannot say', () => {
  const given = () =>
    approvePublication({ candidate: candidateFor(), approvedAt: '2026-09-25T10:15:00.000Z' });

  it.each([
    'APPROVE_ALL',
    'PUBLISH_ANYTHING',
    'MERGE_PULL_REQUEST',
    'CREATE_PULL_REQUEST_AND_MERGE',
    'FORCE_PUSH',
    'approve',
  ])('refuses the action %s, which is not this stage to grant', (action) => {
    expect(() => parsePublicationApproval({ ...given(), action })).toThrow(/action/i);
  });

  it('refuses a document that merely claims to be approved', () => {
    expect(() => parsePublicationApproval({ approved: true })).toThrow(
      /approved|publicationDigest|shape|strict/i,
    );
  });

  it('refuses an approval that names every candidate with a wildcard', () => {
    expect(() => parsePublicationApproval({ ...given(), publicationDigest: '*' })).toThrow(
      /publicationDigest/i,
    );
  });

  it('refuses an approval a model is said to have recommended', () => {
    expect(() => parsePublicationApproval({ ...given(), recommendedBy: 'bharatcode' })).toThrow(
      /recommendedBy/i,
    );
  });
});

describe('deciding whether a publication is authorised', () => {
  it('reports what is missing, and how to say it, when nobody has approved', () => {
    const candidate = candidateFor();

    const decision = decidePublication({ candidate, approval: null });

    expect(decision).toMatchObject({
      status: 'ABSENT',
      allowed: false,
      requiresApproval: true,
      expectedDigest: publicationDigestOf(candidate),
      givenDigest: null,
    });
    expect(decision.reason).toContain('mergesutra pr run-20260925T000000Z-pack001');
    expect(decision.reason).toContain(publicationDigestOf(candidate));
  });

  it('allows the one case where a human approved exactly this candidate', () => {
    const candidate = candidateFor();
    const approval = approvePublication({
      candidate,
      approvedAt: '2026-09-25T10:15:00.000Z',
    });

    const decision = decidePublication({ candidate, approval });

    expect(decision).toMatchObject({
      status: 'MATCHED',
      allowed: true,
      requiresApproval: false,
      givenDigest: approval.publicationDigest,
    });
    expect(decision.reason).toContain('2026-09-25T10:15:00.000Z');
  });

  it('accepts a digest a terminal printed in uppercase, because a human pastes it', () => {
    const candidate = candidateFor();
    const approval = approvePublication({
      candidate,
      approvedAt: '2026-09-25T10:15:00.000Z',
    });

    const decision = decidePublication({
      candidate,
      approval: { ...approval, publicationDigest: approval.publicationDigest.toUpperCase() },
    });

    expect(decision.status).toBe('MATCHED');
  });

  it('goes stale when the page changed after the yes, even by one word of the title', () => {
    const approval = approvePublication({
      candidate: candidateFor(),
      approvedAt: '2026-09-25T10:15:00.000Z',
    });
    const edited = candidateFor({
      draft: { title: 'Parser rejects invalid empty dates', body: '## Summary\n\nBody.\n' },
    });

    const decision = decidePublication({ candidate: edited, approval });

    expect(decision.status).toBe('STALE');
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.givenDigest).toBe(approval.publicationDigest);
    expect(decision.expectedDigest).toBe(publicationDigestOf(edited));
    expect(decision.reason).toMatch(/different/i);
  });

  it('goes stale when the bytes moved under a page nobody re-read', () => {
    const approval = approvePublication({
      candidate: candidateFor(),
      approvedAt: '2026-09-25T10:15:00.000Z',
    });

    const moved = candidateFor({ patchIdentity: OTHER_PATCH_IDENTITY });

    expect(decidePublication({ candidate: moved, approval }).status).toBe('STALE');
  });

  it('refuses to carry an approval written for another run', () => {
    const approval = approvePublication({
      candidate: candidateFor(),
      approvedAt: '2026-09-25T10:15:00.000Z',
    });
    const elsewhere = candidateFor({ runId: 'run-20261001T000000Z-pack002' });

    const decision = decidePublication({ candidate: elsewhere, approval });

    expect(decision.status).toBe('STALE');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/other run/i);
  });
});

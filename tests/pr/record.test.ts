import { describe, expect, it } from 'vitest';
import { type AppError } from '../../src/core/errors.js';
import { approvePublication } from '../../src/pr/approval.js';
import { candidateOf, parsePublicationCandidate } from '../../src/pr/candidate.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { buildPublicationRecord, parsePublicationRecord } from '../../src/pr/record.js';
import type { PublicationRecord } from '../../src/pr/record.js';
import { candidateInput } from '../helpers/publication.js';

/**
 * What Stage 10 stores about a publication: the proposal, and the yes.
 *
 * These are two documents kept beside each other rather than one document with an
 * `approved` flag, because they have different authors. The candidate is what this
 * build assembled from facts a run already had; the approval is what a human said
 * about one digest of it. Merged into one object, the pair would read as a single
 * statement — "this is approved" — which is exactly the sentence Stage 10 is not
 * allowed to write about itself.
 *
 * So the tests below are mostly about absence. There is no field for a pull request
 * URL, because nothing has opened one; no field for a verdict, because a candidate
 * is a proposal rather than a judgement; and no duplicated digest, because a second
 * copy of a digest is a second thing that can disagree with the first. The one
 * present-tense check is the pairing rule: an approval that names some other
 * candidate's digest may not be filed beside this candidate, which is how a stale
 * yes would otherwise survive into the record and be read as a current one.
 */

function publicationRecord(overrides: Record<string, unknown> = {}): PublicationRecord {
  const candidate = candidateOf(candidateInput());
  return buildPublicationRecord({
    candidate,
    approval: approvePublication({ candidate, approvedAt: '2026-09-27T09:00:00.000Z' }),
    ...overrides,
  });
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

describe('the publication Stage 10 records', () => {
  it('holds the candidate and the approval as the two documents they are', () => {
    const record = publicationRecord();

    expect(Object.keys(record).sort()).toEqual(['approval', 'candidate']);
    expect(record.candidate.prTitle).toBe('Parser accepts invalid empty dates');
    expect(record.approval?.action).toBe('CREATE_PULL_REQUEST');
  });

  it('records a candidate nobody has approved as having no approval, not an empty one', () => {
    const candidate = candidateOf(candidateInput());

    const record = buildPublicationRecord({ candidate });

    expect(record.approval).toBeNull();
    expect(record.candidate).toEqual(candidate);
  });

  it('keeps the candidate exactly as its builder wrote it, through JSON', () => {
    const record = publicationRecord();

    const loaded = parsePublicationRecord(JSON.parse(JSON.stringify(record)));

    expect(loaded).toEqual(record);
    expect(() => parsePublicationCandidate(loaded.candidate)).not.toThrow();
  });

  it('refuses to file an approval that names some other candidate', () => {
    const shown = candidateOf(candidateInput());
    const onScreenNow = candidateOf(
      candidateInput({ draft: { title: 'A title the human never read', body: 'Body.\n' } }),
    );
    const approval = approvePublication({
      candidate: shown,
      approvedAt: '2026-09-27T09:00:00.000Z',
    });

    const error = capture(() => buildPublicationRecord({ candidate: onScreenNow, approval }));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/digest|approval/i);
  });

  it('restates the digest nowhere, so one approval cannot disagree with itself', () => {
    const text = JSON.stringify(publicationRecord());

    expect(text.match(/publicationDigest/g)).toHaveLength(1);
    expect(text).toContain(publicationDigestOf(candidateOf(candidateInput())).slice(0, 12));
  });

  it('has nowhere to write that a pull request exists, or that anything passed', () => {
    for (const smuggled of [
      { published: true },
      { prUrl: 'https://github.com/projectbharat/datekit/pull/1' },
      { contributionReady: true },
      { approved: true },
      { mergeApproved: true },
    ]) {
      const error = capture(() => parsePublicationRecord({ ...publicationRecord(), ...smuggled }));
      expect(error.kind, JSON.stringify(smuggled)).toBe('validation');
    }
  });

  it('refuses an approval whose action reaches past opening a pull request', () => {
    const record = {
      ...publicationRecord(),
      approval: { ...publicationRecord().approval, action: 'MERGE_PULL_REQUEST' },
    };

    expect(capture(() => parsePublicationRecord(record)).kind).toBe('validation');
  });

  it('refuses a candidate the candidate schema itself refuses', () => {
    const record = {
      ...publicationRecord(),
      candidate: { ...publicationRecord().candidate, patchIdentity: 'not-a-measurement' },
    };

    const error = capture(() => parsePublicationRecord(record));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/patch identity|candidate/i);
  });
});

import { describe, expect, it } from 'vitest';
import { type AppError } from '../../src/core/errors.js';
import { approvePublication } from '../../src/pr/approval.js';
import { candidateOf, parsePublicationCandidate } from '../../src/pr/candidate.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { buildPublicationRecord, parsePublicationRecord } from '../../src/pr/record.js';
import type { PublicationRecord } from '../../src/pr/record.js';
import { candidateInput } from '../helpers/publication.js';

/**
 * What Stage 10 stores about a publication: the proposal, the yes, and — only when a
 * remote answered — the draft it opened.
 *
 * These are separate documents kept beside each other rather than one document with
 * an `approved` flag, because they have different authors and answer different
 * questions. The candidate is what this build assembled from facts a run already had;
 * the approval is what a human said about one digest of it; the result is what a
 * transport reported after sending it. Merged into one object, they would read as a
 * single statement — "this is approved and published" — which is exactly the
 * sentence Stage 10 is not allowed to write about itself.
 *
 * So the tests below are mostly about absence. A result has no field for a merge, a
 * review or a verdict, because merging is a human act in GitHub; it may name only a
 * draft pull request, and only when an approval beside it authorises one; and there
 * is no duplicated digest, because a second copy of a digest is a second thing that
 * can disagree with the first. The pairing rule is the one present-tense check: an
 * approval that names some other candidate's digest may not be filed beside this
 * candidate, which is how a stale yes would otherwise survive into the record and be
 * read as a current one.
 */

const DRAFT_RESULT = {
  url: 'https://github.com/projectbharat/datekit/pull/7',
  number: 7,
  draft: true as const,
  publishedAt: '2026-09-27T10:00:00.000Z',
};

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
  it('holds the candidate, the approval and the result as separate documents', () => {
    const record = publicationRecord();

    expect(Object.keys(record).sort()).toEqual(['approval', 'candidate', 'result']);
    expect(record.candidate.prTitle).toBe('Parser accepts invalid empty dates');
    expect(record.approval?.action).toBe('CREATE_PULL_REQUEST');
    expect(record.result).toBeNull();
  });

  it('refuses a filed candidate whose body was rewritten beside its old hash', () => {
    const record = publicationRecord();
    const rewritten = {
      ...record,
      candidate: { ...record.candidate, prBody: 'A body the approval never covered.\n' },
    };

    expect(() => parsePublicationRecord(rewritten)).toThrow(/body|digest|hash/i);
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

  it('has no top-level field for a claim of publication, a verdict or a readiness', () => {
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

  it('records a draft beside the approval that authorised it, and nothing about its fate', () => {
    const record = publicationRecord({ result: DRAFT_RESULT });

    const loaded = parsePublicationRecord(JSON.parse(JSON.stringify(record)));

    expect(loaded.result).toEqual(DRAFT_RESULT);
    expect(Object.keys(loaded.result ?? {}).sort()).toEqual([
      'draft',
      'number',
      'publishedAt',
      'url',
    ]);
  });

  it('refuses a result with no approval beside it', () => {
    const error = capture(() =>
      parsePublicationRecord({ ...publicationRecord(), approval: null, result: DRAFT_RESULT }),
    );

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/no approval|approval/i);
  });

  it('refuses a result that is not a draft pull request GitHub could have returned', () => {
    for (const invalid of [
      { ...DRAFT_RESULT, draft: false },
      { ...DRAFT_RESULT, url: 'file:///etc/passwd' },
      { ...DRAFT_RESULT, number: 0 },
    ]) {
      const error = capture(() =>
        parsePublicationRecord({ ...publicationRecord(), result: invalid }),
      );
      expect(error.kind, JSON.stringify(invalid)).toBe('validation');
    }
  });

  it('gives a result nowhere to say merged, reviewed or approved', () => {
    for (const smuggled of [
      { merged: true },
      { state: 'MERGED' },
      { mergeCommitSha: 'e'.repeat(40) },
      { approved: true },
    ]) {
      const error = capture(() =>
        parsePublicationRecord({
          ...publicationRecord(),
          result: { ...DRAFT_RESULT, ...smuggled },
        }),
      );
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

  it('reads a publication filed before hosts were bound, and does not invent one', () => {
    // A record from an earlier build holds a version-1 candidate and the approval that
    // names it. Reading it must succeed and must not add a host: a record is history,
    // so the only honest answer for a page that never bound one is that it has none.
    const current = candidateOf(candidateInput());
    const { repositoryHost: _unbound, ...rest } = current;
    const legacy = { ...rest, schemaVersion: 1 } as PublicationRecord['candidate'];
    const approval = approvePublication({
      candidate: legacy,
      approvedAt: '2026-09-27T09:00:00.000Z',
    });

    const loaded = parsePublicationRecord(
      JSON.parse(JSON.stringify(buildPublicationRecord({ candidate: legacy, approval }))),
    );

    expect(loaded.candidate.schemaVersion).toBe(1);
    expect('repositoryHost' in loaded.candidate).toBe(false);
    expect(loaded.approval?.publicationDigest).toBe(publicationDigestOf(legacy));
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

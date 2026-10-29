import { describe, expect, it } from 'vitest';
import { candidateOf, parsePublicationCandidate } from '../../src/pr/candidate.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import {
  BASE_SHA,
  candidateInput,
  OTHER_PATCH_IDENTITY,
  PACK_IDENTITY,
  PATCH_IDENTITY,
  REVIEWED_PATCH,
} from '../helpers/publication.js';

/**
 * The one document a human approves — Stage 10.
 *
 * A candidate is the pull request page plus every fact the publication would act
 * on, frozen into one strict object, and the digest is the name of that object.
 * The tests below are therefore mostly about the digest's edges: what must change
 * it (anything a publisher would obey) and what must not (the clock it was built
 * at, which would make an approval expire for no reason).
 */

describe('building the candidate', () => {
  it('carries every fact a publication would obey, under its own schema version', () => {
    const candidate = candidateOf(candidateInput());

    expect(candidate).toMatchObject({
      schemaVersion: 2,
      runId: 'run-20260925T000000Z-pack001',
      repository: 'projectbharat/datekit',
      repositoryHost: 'github.com',
      baseSha: BASE_SHA,
      patchIdentity: PATCH_IDENTITY,
      targetBranch: 'main',
      proposedBranch: 'mergesutra/run-20260925T000000Z-pack001',
      prTitle: 'Parser accepts invalid empty dates',
      evidencePackIdentity: PACK_IDENTITY,
    });
  });

  it('holds the body and a digest of it, so a change of wording is a change of candidate', () => {
    const candidate = candidateOf(candidateInput());

    expect(candidate.prBody).toBe('## Summary\n\nBody.\n');
    expect(candidate.prBodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.prBodySha256).not.toBe(candidate.prBody);
  });

  it('refuses a body whose stored hash was not computed from that body', () => {
    const candidate = candidateOf(candidateInput());
    const rewritten = {
      ...candidate,
      prBody: '## Summary\n\nA body the approval never covered.\n',
    };

    expect(() => parsePublicationCandidate(rewritten)).toThrow(/body|digest|hash/i);
    expect(() => publicationDigestOf(rewritten)).toThrow(/body|digest|hash/i);
  });

  it('keeps which issue it came from, and whether it claims to close it', () => {
    const candidate = candidateOf(candidateInput());

    expect(candidate.issueCanonical).toBe('projectbharat/datekit#123');
    expect(candidate.closesIssue).toBe(false);
  });

  it('preserves every limitation the run recorded, in the order they were written', () => {
    const candidate = candidateOf(
      candidateInput({
        limitations: ['First caveat.', 'Second caveat.'],
      }),
    );

    expect(candidate.knownLimitations).toEqual(['First caveat.', 'Second caveat.']);
  });

  it('copies the review it was built after, rather than restating its verdict', () => {
    const candidate = candidateOf(candidateInput());

    expect(candidate.reviewCycle).toBe(1);
    expect(candidate.reviewedPatchIdentity).toBe(REVIEWED_PATCH);
    expect(candidate.reviewSummary).toBe('1 finding, 0 unresolved');
  });

  it('refuses to build where no patch has been measured, because there is nothing to bind to', () => {
    expect(() => candidateOf(candidateInput({ patchIdentity: null }))).toThrow(/patch/i);
  });

  it('refuses to build where no evidence pack has been rendered, because a reviewer would have nothing to read', () => {
    expect(() => candidateOf(candidateInput({ evidencePackIdentity: null }))).toThrow(
      /evidence pack/i,
    );
  });

  it('refuses to build over a run that never verified anything', () => {
    expect(() => candidateOf(candidateInput({ verificationSummary: null }))).toThrow(/verif/i);
  });

  it('refuses to build over a run that was never independently reviewed', () => {
    expect(() => candidateOf(candidateInput({ review: null }))).toThrow(/review/i);
  });

  it('names no issue and closes nothing when the run came from a repository with no issue', () => {
    const candidate = candidateOf(candidateInput({ issue: null }));

    expect(candidate.issueCanonical).toBeNull();
    expect(candidate.closesIssue).toBe(false);
    expect(publicationDigestOf(candidate)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a proposed branch name no publisher will ever run', () => {
    expect(() => candidateOf(candidateInput({ proposedBranch: 'fix;echo pwn' }))).toThrow(
      /source branch/i,
    );
  });

  it('refuses a target branch that is a ref path rather than a branch', () => {
    expect(() =>
      candidateOf(
        candidateInput({
          target: {
            host: 'github.com',
            fullName: 'projectbharat/datekit',
            branch: 'refs/heads/main',
          },
        }),
      ),
    ).toThrow(/target branch/i);
  });

  it('takes no field a caller may type into it', () => {
    const built = candidateOf(candidateInput()) as unknown as Record<string, unknown>;

    expect(Object.keys(built).sort()).toEqual(
      [
        'baseSha',
        'closesIssue',
        'createdAt',
        'evidencePackIdentity',
        'issueCanonical',
        'knownLimitations',
        'patchIdentity',
        'prBody',
        'prBodySha256',
        'prTitle',
        'proposedBranch',
        'repository',
        'repositoryHost',
        'reviewCycle',
        'reviewSummary',
        'reviewedPatchIdentity',
        'runId',
        'schemaVersion',
        'targetBranch',
        'verificationSummary',
      ].sort(),
    );
  });

  it('refuses a document that carries a field nobody defined', () => {
    const extra = { ...candidateOf(candidateInput()), approved: true } as unknown;

    expect(() => parsePublicationCandidate(extra)).toThrow(/approved|shape|strict/i);
  });

  it('names the repository host, because owner and name are not an address', () => {
    const candidate = candidateOf(candidateInput());

    expect(candidate.repositoryHost).toBe('github.com');
  });

  it('refuses a repository host that could never be spoken to', () => {
    expect(() =>
      candidateOf(
        candidateInput({
          target: {
            host: 'ghe example.com/acme/payments',
            fullName: 'acme/payments',
            branch: 'main',
          },
        }),
      ),
    ).toThrow(/host/i);
  });

  it('refuses a version-1 candidate that suddenly carries a host', () => {
    const versioned = { ...candidateOf(candidateInput()), schemaVersion: 1 } as unknown;

    expect(() => parsePublicationCandidate(versioned)).toThrow(/host|version/i);
  });

  it('refuses a version-2 candidate that names no host', () => {
    // The field is optional on the shape because a version-1 document has none, so
    // the version-2 requirement lives in the refinement. Without it a page could be
    // recorded, approved and published with no destination in its bytes, which is
    // the defect this version exists to close.
    const { repositoryHost: _unbound, ...rest } = candidateOf(candidateInput());

    expect(() => parsePublicationCandidate({ ...rest, schemaVersion: 2 })).toThrow(
      /repository host/i,
    );
  });
});

describe('the digest a human approves', () => {
  it('names the same candidate the same way, however often it is hashed', () => {
    const candidate = candidateOf(candidateInput());

    expect(publicationDigestOf(candidate)).toBe(publicationDigestOf(candidate));
    expect(publicationDigestOf(candidate)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('survives a rebuild of the same state, because an approval must not expire on a clock', () => {
    const before = candidateOf(candidateInput({ createdAt: '2026-09-25T00:00:00.000Z' }));
    const after = candidateOf(candidateInput({ createdAt: '2026-11-30T23:59:59.000Z' }));

    expect(publicationDigestOf(after)).toBe(publicationDigestOf(before));
  });

  it('changes when the title changes, because the title is what a reviewer reads', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({ draft: { title: 'A different title', body: '## Summary\n\nBody.\n' } }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the body changes, even by one character', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({
          draft: { title: 'Parser accepts invalid empty dates', body: '## Summary\n\nBody!\n' },
        }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the bytes change', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(candidateInput({ patchIdentity: OTHER_PATCH_IDENTITY })),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the target branch changes', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({
          target: { host: 'github.com', fullName: 'projectbharat/datekit', branch: 'release' },
        }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the repository changes, even on the same branch of it', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({
          target: { host: 'github.com', fullName: 'someone-else/datekit', branch: 'main' },
        }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the repository host changes, because that is where it would be sent', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({
          target: { host: 'ghe.example.com', fullName: 'projectbharat/datekit', branch: 'main' },
        }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the review behind it changes', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({
          review: {
            cycle: 2,
            reviewedPatchIdentity: REVIEWED_PATCH,
            summary: '1 finding, 0 unresolved',
          },
        }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the evidence pack a reviewer was shown changes', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(candidateInput({ evidencePackIdentity: REVIEWED_PATCH })),
    );

    expect(after).not.toBe(before);
  });

  it('changes when the page says it will close the issue rather than merely relate', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(
      candidateOf(
        candidateInput({
          issue: { canonical: 'projectbharat/datekit#123', number: 123, closes: true },
        }),
      ),
    );

    expect(after).not.toBe(before);
  });

  it('changes when a caveat disappears, because a quieter page is a different page', () => {
    const before = publicationDigestOf(candidateOf(candidateInput()));
    const after = publicationDigestOf(candidateOf(candidateInput({ limitations: [] })));

    expect(after).not.toBe(before);
  });

  it('refuses to hash a document that is not a candidate', () => {
    const forged = { ...candidateOf(candidateInput()), patchIdentity: 'not-a-digest' };

    expect(() => publicationDigestOf(forged as never)).toThrow(/patch/i);
  });

  it('keeps a candidate recorded before hosts were bound at the digest its approval names', () => {
    // A stored candidate from an earlier build has no host and schema version 1.
    // Its approval names this number; changing it would silently void a yes that a
    // person really gave, so the legacy line set is pinned here rather than derived.
    const current = candidateOf(candidateInput()) as unknown as Record<string, unknown>;
    const { repositoryHost: _unused, ...decided } = current;
    const legacy = { ...decided, schemaVersion: 1 };

    expect(publicationDigestOf(legacy as never)).toBe(
      '5cc91fb000ab1e96e1780f20f927246ac5fd651ec01af790ceb175b913cafca9',
    );
  });
});

import type { CandidateInput } from '../../src/pr/candidate.js';

/**
 * A candidate's worth of recorded state, for the Stage 10 suites that need one
 * without re-typing nineteen fields.
 *
 * The digests here are made-up hex, not measured from anything: a test that cared
 * whether a patch identity was real would be testing `describePatch`, and the
 * shapes are checked by the candidate schema anyway. What matters is that they are
 * *distinct*, so a test that says "the digest moved" cannot pass by coincidence.
 */

export const PATCH_IDENTITY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const OTHER_PATCH_IDENTITY =
  'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012';
export const PACK_IDENTITY = 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012ff';
export const REVIEWED_PATCH = 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012ff00';
export const BASE_SHA = '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182';
export const RUN_ID = 'run-20260925T000000Z-pack001';

export function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    runId: RUN_ID,
    createdAt: '2026-09-25T00:00:00.000Z',
    issue: { canonical: 'projectbharat/datekit#123', number: 123, closes: false },
    target: { fullName: 'projectbharat/datekit', branch: 'main' },
    proposedBranch: `mergesutra/${RUN_ID}`,
    baseSha: BASE_SHA,
    patchIdentity: PATCH_IDENTITY,
    draft: {
      title: 'Parser accepts invalid empty dates',
      body: '## Summary\n\nBody.\n',
    },
    evidencePackIdentity: PACK_IDENTITY,
    verificationSummary: 'PASS — 2 gates ran, 1 did not',
    review: {
      cycle: 1,
      reviewedPatchIdentity: REVIEWED_PATCH,
      summary: '1 finding, 0 unresolved',
    },
    limitations: ['A gate was offered and nobody consented to it.'],
    ...overrides,
  };
}

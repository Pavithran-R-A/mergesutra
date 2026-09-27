import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/security/digest.js';
import {
  lifecycleStaleness,
  LIFECYCLE_ARTIFACTS,
  type LifecycleArtifact,
  type LifecycleFacts,
} from '../../src/lifecycle/staleness.js';

/**
 * The staleness graph, alone.
 *
 * Every stage that can go out of date compares two digests today, and each one
 * does it in its own words. This module owns the *relationships*: which recorded
 * artifact is judged by which observed fact, and what may be said when a fact
 * cannot be observed at all. It decides nothing about whether a run is good, and
 * it never reads a record — the caller brings the digests it found.
 *
 * `recorded: null` is the answer to "was this ever written down", and it is not
 * the same answer as "this went stale". A tool that conflates the two can report
 * that a review expired on a run that never had one.
 */

const PATCH_A = sha256Hex('patch A');
const PATCH_B = sha256Hex('patch B');
const PACK_ONE = sha256Hex('pack one');
const PACK_TWO = sha256Hex('pack two');
const SCOPE_ONE = sha256Hex('scope one');
const SCOPE_TWO = sha256Hex('scope two');
const CANDIDATE_ONE = sha256Hex('candidate one');
const CANDIDATE_TWO = sha256Hex('candidate two');
const PLAN_ONE = sha256Hex('repair plan one');
const PLAN_TWO = sha256Hex('repair plan two');

/** Nothing recorded and nothing observable: the shape every test starts from. */
function facts(overrides: Partial<LifecycleFacts> = {}): LifecycleFacts {
  return {
    verification: { recorded: PATCH_A, current: PATCH_A },
    evidence: { recorded: PATCH_A, current: PATCH_A },
    review: { recorded: PATCH_A, current: PATCH_A },
    repairPlan: { recorded: PATCH_A, current: PATCH_A },
    executionConsent: { recorded: SCOPE_ONE, current: SCOPE_ONE },
    pack: { recorded: PACK_ONE, current: PACK_ONE },
    candidate: { recorded: CANDIDATE_ONE, current: CANDIDATE_ONE },
    publicationApproval: { recorded: CANDIDATE_ONE, current: CANDIDATE_ONE },
    repairApproval: { recorded: PLAN_ONE, current: PLAN_ONE },
    ...overrides,
  };
}

function state(artifact: LifecycleArtifact, overrides: Partial<LifecycleFacts>) {
  return lifecycleStaleness(facts(overrides)).states[artifact];
}

describe('what the graph knows about', () => {
  it('names exactly the artifacts a lifecycle can leave behind', () => {
    expect([...LIFECYCLE_ARTIFACTS].sort()).toEqual(
      [
        'candidate',
        'evidence',
        'executionConsent',
        'pack',
        'publicationApproval',
        'repairApproval',
        'repairPlan',
        'review',
        'verification',
      ].sort(),
    );
  });

  it('answers for every artifact it claims to know, and no others', () => {
    const verdict = lifecycleStaleness(facts());
    expect(Object.keys(verdict.states).sort()).toEqual([...LIFECYCLE_ARTIFACTS].sort());
  });

  it('calls every recorded fact that still matches what is here now current', () => {
    const verdict = lifecycleStaleness(facts());
    for (const artifact of LIFECYCLE_ARTIFACTS) {
      expect(verdict.states[artifact], artifact).toBe('CURRENT');
    }
  });
});

describe('a patch that moved', () => {
  it('marks the verification that names the older patch stale', () => {
    expect(state('verification', { verification: { recorded: PATCH_A, current: PATCH_B } })).toBe(
      'STALE',
    );
  });

  it('marks the evidence the verification produced stale beside it', () => {
    expect(state('evidence', { evidence: { recorded: PATCH_A, current: PATCH_B } })).toBe('STALE');
  });

  it('marks a review stale when the bytes it read are not the bytes now', () => {
    expect(state('review', { review: { recorded: PATCH_A, current: PATCH_B } })).toBe('STALE');
  });

  it('marks a repair plan stale because the review it was frozen from is stale', () => {
    expect(state('repairPlan', { repairPlan: { recorded: PATCH_A, current: PATCH_B } })).toBe(
      'STALE',
    );
  });

  it('carries the two digests into the reason instead of writing a vaguer sentence', () => {
    const row = lifecycleStaleness(
      facts({ verification: { recorded: PATCH_A, current: PATCH_B } }),
    ).rows.find((each) => each.artifact === 'verification');
    expect(row?.reason).toContain(PATCH_A.slice(0, 12));
    expect(row?.reason).toContain(PATCH_B.slice(0, 12));
  });
});

describe('a fact that cannot be observed', () => {
  it('refuses to call a stale-or-current unknown current', () => {
    expect(state('verification', { verification: { recorded: PATCH_A, current: null } })).toBe(
      'UNMEASURABLE',
    );
  });

  it('does not treat a patch it cannot measure as an unchanged patch', () => {
    const verdict = lifecycleStaleness(
      facts({
        verification: { recorded: PATCH_A, current: null },
        evidence: { recorded: PATCH_A, current: null },
        review: { recorded: PATCH_A, current: null },
      }),
    );
    expect(verdict.states.verification).toBe('UNMEASURABLE');
    expect(verdict.states.evidence).toBe('UNMEASURABLE');
    expect(verdict.states.review).toBe('UNMEASURABLE');
  });

  it('calls a missing evidence pack unmeasurable rather than absent when one was recorded', () => {
    expect(state('pack', { pack: { recorded: PACK_ONE, current: null } })).toBe('UNMEASURABLE');
  });
});

describe('a fact that was never recorded', () => {
  it('calls an artifact with nothing behind it absent, not stale', () => {
    expect(state('review', { review: { recorded: null, current: PATCH_A } })).toBe('ABSENT');
  });

  it('calls an approval that was never given absent even when the page is measurable', () => {
    expect(
      state('publicationApproval', {
        publicationApproval: { recorded: null, current: CANDIDATE_ONE },
      }),
    ).toBe('ABSENT');
  });

  it('does not let an absent upstream artifact make a present one look stale', () => {
    const verdict = lifecycleStaleness(
      facts({
        review: { recorded: null, current: PATCH_A },
        repairPlan: { recorded: null, current: PATCH_A },
      }),
    );
    expect(verdict.states.review).toBe('ABSENT');
    expect(verdict.states.repairPlan).toBe('ABSENT');
  });
});

describe('the arrows in the graph', () => {
  it('expires the candidate when the pack it was written from is not the pack on disk', () => {
    expect(
      state('candidate', {
        pack: { recorded: PACK_ONE, current: PACK_TWO },
      }),
    ).toBe('STALE');
  });

  it('expires the publication approval with the candidate it was given for', () => {
    expect(
      state('publicationApproval', {
        verification: { recorded: PATCH_A, current: PATCH_B },
      }),
    ).toBe('STALE');
  });

  it('expires the approval two steps down when the pack moved, without being told twice', () => {
    expect(
      state('publicationApproval', {
        pack: { recorded: PACK_ONE, current: null },
      }),
    ).toBe('UNMEASURABLE');
  });

  it('expires the approval on the patch alone even while the page on disk still matches', () => {
    expect(
      state('publicationApproval', {
        verification: { recorded: PATCH_A, current: PATCH_B },
        evidence: { recorded: PATCH_A, current: PATCH_B },
        review: { recorded: PATCH_A, current: PATCH_B },
        pack: { recorded: PACK_ONE, current: PACK_ONE },
        candidate: { recorded: CANDIDATE_ONE, current: CANDIDATE_ONE },
      }),
    ).toBe('STALE');
  });

  it('does not let an unmeasurable patch turn a matched consent into a stale one', () => {
    expect(
      state('executionConsent', {
        verification: { recorded: PATCH_A, current: null },
      }),
    ).toBe('CURRENT');
  });

  it('does not follow an arrow backwards from the pack to the patch it renders', () => {
    expect(
      state('pack', {
        pack: { recorded: PACK_ONE, current: PACK_ONE },
        verification: { recorded: PATCH_A, current: PATCH_B },
      }),
    ).toBe('CURRENT');
  });
});

describe('the bindings that are not about the patch', () => {
  it('expires execution consent when the verification plan it was given for moved', () => {
    expect(
      state('executionConsent', {
        executionConsent: { recorded: SCOPE_ONE, current: SCOPE_TWO },
      }),
    ).toBe('STALE');
  });

  it('leaves consent alone while the scope it names is the scope now', () => {
    expect(state('executionConsent', {})).toBe('CURRENT');
  });

  it('expires the publication approval when the candidate it was given for changed', () => {
    expect(
      state('publicationApproval', {
        candidate: { recorded: CANDIDATE_ONE, current: CANDIDATE_TWO },
        publicationApproval: { recorded: CANDIDATE_ONE, current: CANDIDATE_TWO },
      }),
    ).toBe('STALE');
  });

  it('expires the repair approval when the repair plan it names is not the plan now', () => {
    expect(
      state('repairApproval', {
        repairApproval: { recorded: PLAN_ONE, current: PLAN_TWO },
      }),
    ).toBe('STALE');
  });

  it('takes the pack identity into the candidate it is written from', () => {
    expect(
      state('candidate', {
        pack: { recorded: PACK_ONE, current: PACK_TWO },
        candidate: { recorded: CANDIDATE_ONE, current: CANDIDATE_TWO },
      }),
    ).toBe('STALE');
  });
});

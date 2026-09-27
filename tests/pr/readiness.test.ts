import { describe, expect, it } from 'vitest';
import { READINESS_CHECK_IDS, readinessOf, type ReadinessFacts } from '../../src/pr/readiness.js';

/**
 * The eight facts a publication may be based on — Stage 10.
 *
 * The stage brief is unusually specific here, and about what the resulting word
 * must not imply, so the tests below are those facts one at a time plus the two
 * claims this module must never make: that a page has no defects, and that anybody
 * other than a human said yes.
 *
 * Each check reads exactly the fact named in its own condition. Freshness is not
 * decided here — the stage measures the patch immediately before asking, and hands
 * the comparison over as `current`, so this module cannot quietly re-interpret
 * Stage 7's or Stage 9's verdicts. The one comparison it does make is between two
 * identities it was given: the pack's patch and the patch on disk now.
 */

const CURRENT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OLDER = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012';
const PACK = 'c3d4e5f60718293a4b5c6d7e8f9012ff00a1b2c3d4e5f60718293a4b5c6d7e8f9';

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    patchIdentity: CURRENT,
    verification: { patchIdentity: CURRENT, current: true, result: 'PASS' },
    review: { current: true, findings: [] },
    repairOutcomes: [],
    evidencePack: { identity: PACK, patchIdentity: CURRENT },
    approval: 'MATCHED',
    ...overrides,
  };
}

function blockingOf(overrides: Partial<ReadinessFacts>): string[] {
  return readinessOf(facts(overrides)).blocking.map((check) => check.id);
}

describe('the ready state', () => {
  it('is what all eight facts add up to', () => {
    const report = readinessOf(facts());

    expect(report.readiness).toBe('HUMAN_APPROVED_FOR_PR');
    expect(report.blocking).toEqual([]);
    expect(report.checks).toHaveLength(READINESS_CHECK_IDS.length);
  });

  it('does not require a repair cycle when the review found nothing to repair', () => {
    expect(readinessOf(facts()).readiness).toBe('HUMAN_APPROVED_FOR_PR');
  });

  it('carries the identities it compared, so a screen can show what was checked', () => {
    expect(readinessOf(facts()).basedOn).toMatchObject({
      patchIdentity: CURRENT,
      evidencePackIdentity: PACK,
    });
  });
});

describe('the facts that hold a publication back', () => {
  it('refuses when no patch has been measured, because nothing can then be current', () => {
    const report = readinessOf(facts({ patchIdentity: null }));

    expect(report.readiness).toBe('NOT_READY_FOR_PUBLICATION');
    expect(report.blocking[0]?.id).toBe('patch-measured');
    expect(report.blocking[0]?.detail).toMatch(/patch/i);
  });

  it('refuses when the recorded verification is not about these bytes', () => {
    expect(
      blockingOf({ verification: { patchIdentity: OLDER, current: false, result: 'PASS' } }),
    ).toContain('verification-current');
  });

  it('refuses when the verification did not pass, whatever a reviewer said after it', () => {
    const report = readinessOf(
      facts({ verification: { patchIdentity: CURRENT, current: true, result: 'FAIL' } }),
    );

    expect(report.blocking.map((check) => check.id)).toEqual(['verification-passed']);
    expect(report.blocking[0]?.detail).toContain('FAIL');
  });

  it('refuses when the review was written against different bytes', () => {
    expect(blockingOf({ review: { current: false, findings: [] } })).toEqual(['review-current']);
  });

  it('refuses while a BLOCKER is still marked a repair candidate', () => {
    const report = readinessOf(
      facts({
        review: {
          current: true,
          findings: [{ severity: 'BLOCKER', disposition: 'VALID_REPAIR_CANDIDATE' }],
        },
      }),
    );

    expect(report.blocking.map((check) => check.id)).toEqual(['no-repair-candidate-left']);
    expect(report.blocking[0]?.detail).toMatch(/BLOCKER/i);
  });

  it('refuses while a HIGH is still marked a repair candidate', () => {
    expect(
      blockingOf({
        review: {
          current: true,
          findings: [{ severity: 'HIGH', disposition: 'VALID_REPAIR_CANDIDATE' }],
        },
      }),
    ).toContain('no-repair-candidate-left');
  });

  it('leaves a MEDIUM repair candidate to the human who was shown it', () => {
    expect(
      readinessOf(
        facts({
          review: {
            current: true,
            findings: [{ severity: 'MEDIUM', disposition: 'VALID_REPAIR_CANDIDATE' }],
          },
        }),
      ).readiness,
    ).toBe('HUMAN_APPROVED_FOR_PR');
  });

  it('leaves a BLOCKER routed to a human to that human', () => {
    expect(
      readinessOf(
        facts({
          review: {
            current: true,
            findings: [{ severity: 'BLOCKER', disposition: 'NEEDS_HUMAN_REVIEW' }],
          },
        }),
      ).readiness,
    ).toBe('HUMAN_APPROVED_FOR_PR');
  });

  it('refuses when a repair cycle edited outside the scope it was approved for', () => {
    const report = readinessOf(
      facts({ repairOutcomes: ['WITHIN_PLANNED_SCOPE', 'OUTSIDE_PLANNED_SCOPE'] }),
    );

    expect(report.blocking.map((check) => check.id)).toEqual(['no-scope-violation']);
    expect(report.blocking[0]?.detail).toMatch(/outside/i);
  });

  it('does not read a repair that left no trace as a scope violation', () => {
    expect(blockingOf({ repairOutcomes: ['REPAIR_LEFT_NO_TRACE'] })).toEqual([]);
  });

  it('refuses when the evidence pack a human read describes other bytes', () => {
    expect(blockingOf({ evidencePack: { identity: PACK, patchIdentity: OLDER } })).toEqual([
      'pack-current',
    ]);
  });

  it('refuses when no pack has been rendered at all', () => {
    const report = readinessOf(facts({ evidencePack: null }));

    expect(report.blocking.map((check) => check.id)).toEqual(['pack-current']);
    expect(report.blocking[0]?.detail).toMatch(/report/i);
  });

  it('refuses when nobody has approved yet', () => {
    expect(blockingOf({ approval: 'ABSENT' })).toEqual(['human-approved']);
  });

  it('refuses an approval written for a page that has since moved', () => {
    const report = readinessOf(facts({ approval: 'STALE' }));

    expect(report.blocking.map((check) => check.id)).toEqual(['human-approved']);
    expect(report.blocking[0]?.detail).toMatch(/approv/i);
  });
});

describe('what the report says, and what it never says', () => {
  it('names every fact that failed, in the order it checks them', () => {
    expect(
      blockingOf({
        verification: { patchIdentity: OLDER, current: false, result: 'FAIL' },
        approval: 'ABSENT',
      }),
    ).toEqual(['verification-current', 'verification-passed', 'human-approved']);
  });

  it('never claims the contribution itself is ready, or that nothing is wrong with it', () => {
    const text = JSON.stringify(readinessOf(facts())).toLowerCase();

    for (const claim of [
      'contribution_ready',
      'production ready',
      'no defects',
      'all tests passed',
      'ai approved',
      'merge',
      'ship',
    ]) {
      expect(text).not.toContain(claim);
    }
  });

  it('states a passing verification as the recorded verdict, not as a general claim', () => {
    const passed = readinessOf(facts()).checks.find((check) => check.id === 'verification-passed');

    expect(passed?.detail).toMatch(/recorded|verdict/i);
    expect(passed?.detail).not.toMatch(/all tests/i);
  });
});

import type { PublicationApprovalStatus } from './approval.js';

/**
 * Whether a publication may be called ready — Stage 10's eight facts.
 *
 * Stages 0–9R could not express this concept at all, and the first stage that can
 * should be the one that says least with it. So readiness here is the conjunction
 * of eight named facts, each read from a document an earlier stage already wrote,
 * and nothing else. The word chosen is `HUMAN_APPROVED_FOR_PR` rather than the
 * briefer's `CONTRIBUTION_READY`, because it names the act that produced it: this
 * state exists only because a person approved this page, and it stops meaning
 * anything the moment the page moves.
 *
 * What it does not say, in order of how tempting each one is:
 *
 * - It is not a claim that the code is good. A review that found nothing, and gates
 *   that passed, are evidence about the questions those stages asked.
 * - It is not a claim that no defect remains. Stage 9's reviewer is a model reading
 *   a diff in one pass; plenty of wrong code has never been flagged.
 * - It is not a claim about GitHub. Nothing here knows whether a pull request was
 *   accepted, and this build has no way to ask.
 * - It is not a reason to skip reading the page. The eighth fact is a human's yes,
 *   and if that yes was given carelessly the state is exactly as true and exactly as
 *   useless as the yes.
 *
 * Two of the eight are also deliberately narrower than they might look. A finding
 * routed to a human — even a BLOCKER — does not hold the publication back, because
 * the human it was routed to is the same person approving the page, and treating
 * their own decision as an unresolved blocker would be a way of overriding it. And
 * a repair that left no trace is not a scope violation; it is a repair that did
 * nothing, which the current review of the current bytes will already have caught.
 *
 * This module decides nothing about the world. It reads seven facts about recorded
 * evidence plus the status of an approval, and prints a reason for every one,
 * passing or failing, so a screen can show what was checked rather than only what
 * went wrong.
 */

export const READINESS_OUTCOMES = ['HUMAN_APPROVED_FOR_PR', 'NOT_READY_FOR_PUBLICATION'] as const;

export type PublicationReadiness = (typeof READINESS_OUTCOMES)[number];

/** Ordered: cheapest fact first, so the top of a failure list is the missing stage. */
export const READINESS_CHECK_IDS = [
  'patch-measured',
  'verification-current',
  'verification-passed',
  'review-current',
  'no-repair-candidate-left',
  'no-scope-violation',
  'pack-current',
  'human-approved',
] as const;

export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

export interface ReadinessFindingFact {
  readonly severity: string;
  readonly disposition: string;
}

export interface ReadinessFacts {
  /** The patch measured immediately before this question was asked. */
  readonly patchIdentity: string | null;
  readonly verification: {
    readonly patchIdentity: string | null;
    /** Stage 7's own precondition, compared to the fresh measurement by the stage. */
    readonly current: boolean;
    readonly result: string;
  } | null;
  readonly review: {
    readonly current: boolean;
    readonly findings: readonly ReadinessFindingFact[];
  } | null;
  /** One entry per recorded repair cycle, from Stage 9R's scope guard. */
  readonly repairOutcomes: readonly string[];
  readonly evidencePack: {
    readonly identity: string;
    readonly patchIdentity: string | null;
  } | null;
  readonly approval: PublicationApprovalStatus;
}

export interface ReadinessCheck {
  readonly id: ReadinessCheckId;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ReadinessReport {
  readonly readiness: PublicationReadiness;
  readonly checks: readonly ReadinessCheck[];
  readonly blocking: readonly ReadinessCheck[];
  readonly basedOn: {
    readonly patchIdentity: string | null;
    readonly evidencePackIdentity: string | null;
  };
}

const BLOCKING_SEVERITIES = ['BLOCKER', 'HIGH'] as const;
const REPAIR_CANDIDATE = 'VALID_REPAIR_CANDIDATE';
const OUTSIDE_SCOPE = 'OUTSIDE_PLANNED_SCOPE';

/** The eight conditions, evaluated in order, each with a printable reason. */
export function readinessOf(facts: ReadinessFacts): ReadinessReport {
  const current = facts.patchIdentity;
  const checks: ReadinessCheck[] = [
    check('patch-measured', current !== null, {
      passed: `The patch on disk is ${short(current)}.`,
      failed:
        'No patch identity has been measured for these bytes, so nothing below can be checked against them.',
    }),

    check(
      'verification-current',
      facts.verification !== null &&
        facts.verification.current &&
        facts.verification.patchIdentity !== null,
      facts.verification === null
        ? {
            passed: '',
            failed: 'No deterministic verification is recorded for this run.',
          }
        : {
            passed: `The verification on record is for ${short(facts.verification.patchIdentity)}, which is the patch now.`,
            failed: `The verification on record is for ${short(facts.verification.patchIdentity)} and the patch now is ${short(current)}, so it describes bytes that have moved.`,
          },
    ),

    check(
      'verification-passed',
      facts.verification !== null && facts.verification.result === 'PASS',
      facts.verification === null
        ? {
            passed: '',
            failed:
              'No deterministic verification is recorded, so there is no verdict to point at.',
          }
        : {
            passed: 'The recorded verdict is PASS, which covers the gates this run actually ran.',
            failed: `The recorded verdict is ${facts.verification.result}, not PASS.`,
          },
    ),

    check('review-current', facts.review !== null && facts.review.current, {
      passed: 'The independent review on record was written against the patch now.',
      failed:
        facts.review === null
          ? 'No independent review is recorded for this run, so the only reader of these bytes wrote them.'
          : 'The independent review on record was written against different bytes, so it is not a review of this page.',
    }),

    candidateCheck(facts.review),

    scopeCheck(facts.repairOutcomes),

    packCheck(facts.evidencePack, current),

    check('human-approved', facts.approval === 'MATCHED', {
      passed: 'A human approved this exact publication proposal.',
      failed:
        facts.approval === 'ABSENT'
          ? 'No approval has been given for this proposal, so nothing is ready to publish.'
          : 'The approval on this run names a different proposal, so it is not a yes to this one.',
    }),
  ];

  const blocking = checks.filter((c) => !c.passed);
  return {
    readiness: blocking.length === 0 ? 'HUMAN_APPROVED_FOR_PR' : 'NOT_READY_FOR_PUBLICATION',
    checks,
    blocking,
    basedOn: {
      patchIdentity: current,
      evidencePackIdentity: facts.evidencePack?.identity ?? null,
    },
  };
}

function candidateCheck(review: ReadinessFacts['review']): ReadinessCheck {
  if (review === null) {
    return check('no-repair-candidate-left', false, {
      passed: '',
      failed: 'No independent review is recorded, so no finding has been dispositioned.',
    });
  }
  const left = review.findings.filter(
    (finding) =>
      finding.disposition === REPAIR_CANDIDATE &&
      (BLOCKING_SEVERITIES as readonly string[]).includes(finding.severity),
  );
  return check('no-repair-candidate-left', left.length === 0, {
    passed: 'Nothing at BLOCKER or HIGH is still marked a repair candidate.',
    failed:
      `${String(left.length)} ${plural(left.length, 'finding')} still marked a repair candidate ` +
      `at ${left.map((f) => f.severity).join(', ')}. Run \`mergesutra repair\`, or say so on the page.`,
  });
}

function scopeCheck(outcomes: readonly string[]): ReadinessCheck {
  const violations = outcomes.filter((outcome) => outcome === OUTSIDE_SCOPE);
  return check('no-scope-violation', violations.length === 0, {
    passed:
      outcomes.length === 0
        ? 'No repair cycle ran on this run, so no scope was ever crossed.'
        : `Every one of the ${String(outcomes.length)} recorded repair ${plural(outcomes.length, 'cycle')} stayed inside the scope it was approved for.`,
    failed:
      `${String(violations.length)} recorded repair ${plural(violations.length, 'cycle')} of ` +
      `${String(outcomes.length)} wrote outside the scope it was approved for, and that is not this ` +
      'stage’s problem to tidy. Review the worktree yourself, or start a clean run.',
  });
}

function packCheck(pack: ReadinessFacts['evidencePack'], current: string | null): ReadinessCheck {
  if (pack === null) {
    return check('pack-current', false, {
      passed: '',
      failed:
        'No evidence pack has been rendered, so a reviewer was shown claims with nothing behind them. Run `mergesutra report`.',
    });
  }
  const same = pack.patchIdentity !== null && pack.patchIdentity === current;
  return check('pack-current', same, {
    passed: `The evidence pack (${short(pack.identity)}) describes the patch now.`,
    failed: same
      ? ''
      : `The evidence pack on record describes ${short(pack.patchIdentity)} and the patch now is ${short(current)}. Re-render it with \`mergesutra report\`.`,
  });
}

function check(
  id: ReadinessCheckId,
  passed: boolean,
  wordings: { readonly passed: string; readonly failed: string },
): ReadinessCheck {
  return { id, passed, detail: passed ? wordings.passed : wordings.failed };
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** Twelve characters identifies a digest to a human; the report is not a log. */
function short(value: string | null): string {
  return value === null ? 'nothing measured' : `${value.slice(0, 12)}…`;
}

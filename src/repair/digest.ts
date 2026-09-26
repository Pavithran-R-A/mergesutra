import { AppError } from '../core/errors.js';
import { sha256Hex } from '../security/digest.js';
import { repairPlanSchema, type RepairPlan } from './plan.js';

/**
 * The digest of a frozen repair plan — Stage 9R's approval surface.
 *
 * A repair is the one thing in this product that edits a repository, and a human
 * has to be able to say yes to *it* rather than to a mood. So the yes names this
 * number, and this number is computed from the plan's scope: which run, which
 * cycles, which patch the findings described, which findings, which files, which
 * criteria, which gates, and what each item asked for. Nothing else is folded in.
 *
 * Two exclusions are deliberate. `createdAt` is absent, because a person who
 * approves a scope at 10:15 has approved that scope, not that minute — and a
 * digest that moved with the clock would make every approval expire on re-save
 * without any scope having changed. The model id and the reviewer's prose outside
 * the items are absent too: they describe how the plan was *arrived at*, and a
 * plan re-frozen from the same findings over the same bytes authorises the same
 * edit.
 *
 * Ordering is normalised everywhere, so two documents that name the same scope in
 * a different order produce the same digest. That is not tidiness: an approval
 * that broke when a list was re-sorted would train a human to reach for a bigger,
 * blunter flag instead.
 *
 * This function decides nothing. It has no notion of whether a plan *should* run,
 * and no field to record that anybody said yes — that is `consent.ts`, which
 * checks a digest against this one.
 */

export const REPAIR_PLAN_DIGEST_LABEL = 'mergesutra-repair-plan/1';

function linesOf(plan: RepairPlan): string[] {
  return [
    REPAIR_PLAN_DIGEST_LABEL,
    `run ${plan.runId}`,
    `cycles ${String(plan.reviewCycle)}/${String(plan.repairCycle)}`,
    `patch ${plan.reviewedPatchIdentity}`,
    `criteria ${[...plan.criteria].sort().join(',')}`,
    `files ${[...plan.expectedFiles].sort().join(',')}`,
    `checks ${[...plan.expectedChecks].sort().join(',')}`,
    ...plan.findings
      .map((item) =>
        [
          `finding ${item.findingId}`,
          `criteria ${[...item.criterionIds].sort().join(',')}`,
          `files ${[...item.expectedFiles].sort().join(',')}`,
          `checks ${[...item.expectedChecks].sort().join(',')}`,
          // Trimmed, not reflowed: the ask is the plan's, and a trailing space
          // is not a different job. The words still cannot move without moving
          // the digest.
          `ask ${item.intendedChange.trim()}`,
        ].join('\u0000'),
      )
      .sort(),
  ];
}

/**
 * The digest of one frozen plan.
 *
 * The input is validated here rather than trusted: this number is what a human's
 * yes will be pinned to, so a document with an extra field — a `status`, a
 * `verdict`, an `approved` — must fail loudly rather than be quietly digested on
 * the strength of the fields this file happens to know about.
 */
export function repairPlanDigest(plan: RepairPlan): string {
  const parsed = repairPlanSchema.safeParse(plan);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Cannot digest a repair plan: it is not a plan MergeSutra would freeze (${
        issue?.path.join('.') ?? 'document'
      }: ${issue?.message ?? 'invalid'}).`,
      remediation:
        'Digest the plan a review stage actually froze and stored, from `record.repairPlan`.',
      details: { reason: issue?.message ?? 'invalid' },
    });
  }
  return sha256Hex(linesOf(parsed.data).join('\n'));
}

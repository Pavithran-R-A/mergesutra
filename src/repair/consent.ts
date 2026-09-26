import { z } from 'zod';
import { AppError } from '../core/errors.js';
import type { RepairPlan } from './plan.js';
import { repairPlanDigest } from './digest.js';

/**
 * Whether a human has agreed to *this* repair — Stage 9R.
 *
 * A frozen `RepairPlan` is MergeSutra's own work order. Writing the order is not
 * the same act as being allowed to carry it out: the plan was built from a
 * review, the review came from a model, and neither of those is the person who
 * owns the repository. So the yes is its own capability, stored next to the plan
 * rather than inside it, and the only fact it can carry is the digest of the
 * scope it was given.
 *
 * There is deliberately no wildcard in this shape. No `--yes`, no `--force`, no
 * `approve-all`, no field that could read "whatever the model decides next" —
 * agreeing to everything is the one thing a repair stage may not be told, because
 * the set of files a repair touches is exactly what the approval exists to bound.
 *
 * The comparison is the whole decision, and it is a comparison rather than a
 * computation: same digest, the repair may run; different digest, the approval on
 * file is about some other job — a re-frozen plan, a later cycle, a retyped word.
 * Nothing is mutated here to find out which.
 */

/**
 * A human's yes to one frozen plan.
 *
 * No `schemaVersion`, for the same reason Stage 7's consent has none: it is
 * always stored inside a versioned document, and a second version number on a
 * nested object is a second thing that can disagree with its parent.
 */
export const repairApprovalSchema = z
  .object({
    /** The digest of the plan shown to the human — not the plan's prose. */
    planDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'an approval carries the 64-character digest of one plan'),
    approvedAt: z.string().min(1),
  })
  .strict();
export type RepairApproval = z.infer<typeof repairApprovalSchema>;

export const REPAIR_APPROVAL_STATUSES = ['MATCHED', 'ABSENT', 'STALE'] as const;
export type RepairApprovalStatus = (typeof REPAIR_APPROVAL_STATUSES)[number];

export interface RepairApprovalDecision {
  readonly status: RepairApprovalStatus;
  readonly allowed: boolean;
  /** True when the only thing missing is a human saying yes. */
  readonly requiresApproval: boolean;
  /** The digest this plan has right now, so the flag can be typed from it. */
  readonly expectedDigest: string;
  readonly givenDigest: string | null;
  readonly reason: string;
}

/**
 * Author an approval for a plan.
 *
 * The digest is derived, never accepted: a caller who could supply one could
 * approve a plan they had not read. Production reaches this only after the plan
 * has been shown to a person; tests call it directly, which is the one place a
 * yes may be manufactured.
 */
export function approveRepairPlan(input: { plan: RepairPlan; approvedAt: string }): RepairApproval {
  return { planDigest: repairPlanDigest(input.plan), approvedAt: input.approvedAt };
}

/** Validate an approval read back from disk. */
export function parseRepairApproval(value: unknown): RepairApproval {
  const parsed = repairApprovalSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to accept this repair approval: ${issue?.message ?? 'it is malformed'} (${issue?.path.join('.') ?? 'document'}).`,
      remediation:
        'An approval names the digest of exactly one frozen plan. There is no way to approve every repair at once.',
    });
  }
  return parsed.data;
}

/**
 * Decide whether a repair may run. Pure, and total: every path returns a reason a
 * report can print.
 *
 * Hex case is not compared, because a human pastes a digest out of a terminal and
 * some terminals print it uppercase. Everything else is compared exactly.
 */
export function decideRepairApproval(input: {
  plan: RepairPlan;
  approval?: RepairApproval | null;
}): RepairApprovalDecision {
  const expectedDigest = repairPlanDigest(input.plan);
  const approval = input.approval ?? null;

  if (approval === null) {
    return {
      status: 'ABSENT',
      allowed: false,
      requiresApproval: true,
      expectedDigest,
      givenDigest: null,
      reason:
        `No approval has been given for this repair plan, so no file will be written. ` +
        `Run \`mergesutra repair ${input.plan.runId} --approve-plan ${expectedDigest}\` ` +
        'once the plan and the files it names have been read.',
    };
  }

  const givenDigest = approval.planDigest;
  if (givenDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    return {
      status: 'STALE',
      allowed: false,
      requiresApproval: true,
      expectedDigest,
      givenDigest,
      reason:
        `The approval on this run is for a different plan: it names ` +
        `${givenDigest.slice(0, 12)} and the plan now to be repaired digests to ` +
        `${expectedDigest.slice(0, 12)}. A frozen plan is a scope, and an approval ` +
        'that does not match that scope is not a stale yes — it is a yes to some ' +
        'other job. An operator has to approve this one.',
    };
  }

  return {
    status: 'MATCHED',
    allowed: true,
    requiresApproval: false,
    expectedDigest,
    givenDigest,
    reason: `The operator approved this exact plan (${expectedDigest.slice(0, 12)}) at ${approval.approvedAt}.`,
  };
}

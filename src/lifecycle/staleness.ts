import { stalenessOf } from '../verify/patch.js';

/**
 * The lifecycle's staleness graph, as data and one function.
 *
 * Stages 7 to 10 each answer "is what I recorded still true?" in their own words:
 * verification compares patch identities, consent compares a scope digest, the
 * publication approval compares candidate digests, the repair approval compares a
 * plan digest. The comparisons are already correct and are reused here. What no
 * stage owns is the *set* of things that can go out of date and the fact that a
 * reader has to be told about all of them at once — which is what a status screen
 * and a resume plan both need, and what each command would otherwise re-derive.
 *
 * So this module fixes the vocabulary (`ABSENT` is not `STALE`, and `UNMEASURABLE`
 * is not `CURRENT`) and judges one recorded artifact against the one observable it
 * was bound to. It reads no record, no filesystem and no Git: the caller brings
 * the digests it managed to observe, and an observation that failed arrives as
 * `current: null` rather than as a guess. Deciding what to measure is Stage 11's
 * observation layer; deciding what a measurement *means* is here.
 */

export const LIFECYCLE_ARTIFACTS = [
  'verification',
  'evidence',
  'review',
  'repairPlan',
  'executionConsent',
  'pack',
  'candidate',
  'publicationApproval',
  'repairApproval',
] as const;

export type LifecycleArtifact = (typeof LIFECYCLE_ARTIFACTS)[number];

/**
 * `ABSENT` — nothing was ever recorded. `UNMEASURABLE` — something was recorded,
 * and the fact it was bound to cannot be observed now, so the tool refuses to say
 * either way. `CURRENT` / `STALE` — both sides are known and were compared.
 */
export type LifecycleState = 'CURRENT' | 'STALE' | 'UNMEASURABLE' | 'ABSENT';

/** One row of input: what was written down, and what is here now if that can be had. */
export interface LifecycleFact {
  readonly recorded: string | null;
  readonly current: string | null;
}

export type LifecycleFacts = Readonly<Record<LifecycleArtifact, LifecycleFact>>;

export interface LifecycleRow {
  readonly artifact: LifecycleArtifact;
  readonly state: LifecycleState;
  readonly recorded: string | null;
  readonly current: string | null;
  readonly reason: string;
}

export interface LifecycleVerdict {
  readonly states: Readonly<Record<LifecycleArtifact, LifecycleState>>;
  readonly rows: readonly LifecycleRow[];
}

/** What each artifact is judged against, in the words a human reads. */
const BINDINGS: Readonly<Record<LifecycleArtifact, { noun: string; boundTo: string }>> = {
  verification: { noun: 'verification', boundTo: 'the patch in the workspace' },
  evidence: { noun: 'evidence', boundTo: 'the patch in the workspace' },
  review: { noun: 'review', boundTo: 'the patch the reviewer read' },
  repairPlan: { noun: 'repair plan', boundTo: 'the patch in the workspace' },
  executionConsent: { noun: 'execution consent', boundTo: 'the verification plan scope' },
  pack: { noun: 'evidence pack', boundTo: 'the pack directory on disk' },
  candidate: { noun: 'PR candidate', boundTo: 'the patch in the workspace' },
  publicationApproval: { noun: 'publication approval', boundTo: 'the candidate now on the page' },
  repairApproval: { noun: 'repair approval', boundTo: 'the repair plan now on record' },
};

/**
 * The arrows: which artifact's currency is judged through which other one.
 *
 * This table is the reason the module exists. A run whose patch moved has not
 * only gone stale verification: the evidence drawn from it, the review that read
 * it and the plan frozen from that review are all about bytes that are gone.
 * Each of those rows can be measured on its own and still look correct —
 * the page on disk can match the page that was approved while the patch underneath
 * it has already moved twice — so a status screen that only ever compares each
 * row with its own fact would report a lifecycle as current when nothing in it
 * is. The arrows say which direction is allowed to travel: a moved patch
 * expires the page, an expired page does not retroactively move the patch.
 *
 * A repair plan ends a chain rather than starting one, and that is a fact about
 * what a plan is for. Its job was to change the bytes it describes, so a
 * workspace that no longer matches one is the plan having *worked* — which is
 * what its own row says, and not a defect the approval of it, or a page written
 * after it, should inherit. The page is judged through the review and the pack
 * instead, both of which are meant to describe the same bytes forever: a run that
 * repaired, re-verified and re-reviewed has a current review and a current page,
 * while a run whose files were edited behind everyone's back expires all the way
 * down.
 */
const DEPENDS_ON: Readonly<Record<LifecycleArtifact, readonly LifecycleArtifact[]>> = {
  verification: [],
  evidence: ['verification'],
  review: ['evidence'],
  repairPlan: ['review'],
  pack: [],
  candidate: ['pack', 'review'],
  publicationApproval: ['candidate'],
  executionConsent: [],
  repairApproval: [],
};

/** How much worse one state is than another, for folding an arrow into a row. */
const SEVERITY: Readonly<Record<LifecycleState, number>> = {
  CURRENT: 0,
  UNMEASURABLE: 1,
  STALE: 2,
  ABSENT: 3,
};

export function lifecycleStaleness(facts: LifecycleFacts): LifecycleVerdict {
  const resolved = new Map<LifecycleArtifact, LifecycleRow>();

  const rowForArtifact = (artifact: LifecycleArtifact): LifecycleRow => {
    const known = resolved.get(artifact);
    if (known) return known;
    const own = rowFor(artifact, facts[artifact]);
    // Filled before recursing so a cycle in the table above could not loop here.
    resolved.set(artifact, own);
    const widened = inherit(artifact, own, rowForArtifact);
    resolved.set(artifact, widened);
    return widened;
  };

  const rows = LIFECYCLE_ARTIFACTS.map(rowForArtifact);
  const states = {} as Record<LifecycleArtifact, LifecycleState>;
  for (const row of rows) states[row.artifact] = row.state;
  return { states, rows };
}

/**
 * Widen a row to the worst thing true about anything it is built from.
 *
 * An upstream that was never recorded is not a defect downstream — a run that
 * skipped repair still has a page and still has an approval — so `ABSENT` is the
 * one state that does not travel along an arrow. Resolution is recursive, so an
 * approval sees a patch that moved four arrows above it without the caller
 * having to say so.
 */
function inherit(
  artifact: LifecycleArtifact,
  row: LifecycleRow,
  resolve: (artifact: LifecycleArtifact) => LifecycleRow,
): LifecycleRow {
  if (row.state === 'ABSENT') return row;
  let widest = row;
  for (const upstream of DEPENDS_ON[artifact]) {
    const each = resolve(upstream);
    if (each.state === 'ABSENT') continue;
    if (SEVERITY[each.state] > SEVERITY[widest.state]) widest = each;
  }
  if (widest.state === row.state) return row;
  return {
    ...row,
    state: widest.state,
    reason:
      `${row.reason} It is also judged through the ${widest.artifact} it was built from: ` +
      widest.reason,
  };
}

function rowFor(artifact: LifecycleArtifact, fact: LifecycleFact): LifecycleRow {
  const binding = BINDINGS[artifact];
  const base = { artifact, recorded: fact.recorded, current: fact.current };

  if (fact.recorded === null) {
    return {
      ...base,
      state: 'ABSENT',
      reason: `No ${binding.noun} has been recorded for this run.`,
    };
  }
  if (fact.current === null) {
    return {
      ...base,
      state: 'UNMEASURABLE',
      reason:
        `A ${binding.noun} was recorded against ${short(fact.recorded)}, but ${binding.boundTo} ` +
        'cannot be measured now, so this tool cannot say whether it still holds.',
    };
  }

  const comparison = stalenessOf(fact.recorded, fact.current);
  if (comparison.status === 'CURRENT') {
    return {
      ...base,
      state: 'CURRENT',
      reason: `The ${binding.noun} names ${short(fact.recorded)}, which is what ${binding.boundTo} measures.`,
    };
  }
  return {
    ...base,
    state: 'STALE',
    reason:
      `The ${binding.noun} was recorded against ${short(fact.recorded)} and ` +
      `${binding.boundTo} now measures ${short(fact.current)}. It is kept for the record ` +
      'and does not count towards the result.',
  };
}

function short(digest: string): string {
  return digest.slice(0, 12);
}

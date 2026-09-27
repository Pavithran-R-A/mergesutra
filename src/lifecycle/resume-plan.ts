import { z } from 'zod';
import { sha256Hex } from '../security/digest.js';
import { RUN_STAGES } from '../state/run-record.js';
import { LIFECYCLE_COMMANDS } from './next-actions.js';
import { type SafeNextAction, type StatusSnapshot } from './snapshot.js';

/**
 * The plan `resume` would carry out, built before anything happens.
 *
 * §15 asks for this object to exist first and to be deterministic, and the reason
 * is the one failure mode every recovery tool shares: it decides what to do while
 * it is doing it, so a person reviewing a preview and a machine acting later are
 * not talking about the same run. Everything here is decided once, from a status
 * snapshot, by arithmetic — no model call, no command, no clock.
 *
 * The rules the decision follows, in the order it applies them:
 *
 * 1. **A blocked run has no plan.** When the workspace is gone, unreadable, or
 *    belongs to another history, every verb fails for that same reason, so the plan
 *    names the blocker and plans nothing. It never names a way around it: §35
 *    forbids recovery meaning a reset, a clean, a checkout or a rebuild, and those
 *    destroy the evidence a run is made of.
 * 2. **A loop that stopped early is what was interrupted.** If the implementation
 *    record says the loop ended any way other than the model asking to stop, the
 *    plan goes back into that loop rather than routing to verification of the
 *    half-finished patch — which would be the tool treating an unfinished loop as a
 *    finished one (§19). Re-entry needs budget left to re-enter *into*; a loop that
 *    ended on its bound is not a loop waiting for a fresh one, and the plan says the
 *    spent numbers instead of implying new ones.
 * 3. **Otherwise the plan is the first thing the run is genuinely offered.** The
 *    snapshot's suggestions already carry every precondition each stage checks
 *    before it runs, so a plan built from them cannot propose a command the stage
 *    would refuse. Where the offer needs a human's decision that does not exist —
 *    a repair plan nobody has approved, a page nobody has agreed to — the plan stops
 *    *at* that boundary and flags it, because §17 forbids `resume` from fabricating
 *    a consent, a repair approval or a publication approval.
 * 4. **When nothing is offered, the plan says so.** An approved page is the end of
 *    this build (there is no publisher to invent a next step for), a run with no
 *    Acceptance Contract has exactly one stage it has not reached, and anything else
 *    is a decision this tool will not make on a person's behalf.
 *
 * The `observedStateDigest` is what makes the preview mean something later. It is
 * hashed over the snapshot's facts with the one volatile field — when the
 * observation was taken — left out, so a re-read of unchanged bytes reproduces it
 * and moved bytes do not. That is the whole of §34's TOCTOU guard: an execution
 * compares a freshly built plan's digest against the one it was handed, and a run
 * that changed underneath is a different plan.
 */

export const RESUME_PLAN_SCHEMA_VERSION = 1;

/**
 * What a resume can decide to do, as a closed vocabulary.
 *
 * `*_APPROVAL_REQUIRED` are actions in the sense of *being at*: they name the
 * boundary the run is stopped at and carry no capability past it. So does
 * `AWAIT_HUMAN`. The important property of this list is that no member of it means
 * published, pushed, created or merged — there is no verb in this build that would
 * let it.
 */
export const RESUME_ACTIONS = [
  'DERIVE_ACCEPTANCE_CONTRACT',
  'CREATE_PLAN',
  'RUN_IMPLEMENTATION_LOOP',
  'CONTINUE_IMPLEMENTATION',
  'VERIFY_CURRENT_PATCH',
  'REVIEW_CURRENT_PATCH',
  'REPAIR_PLAN_APPROVAL_REQUIRED',
  'REGENERATE_EVIDENCE_PACK',
  'BUILD_PUBLICATION_CANDIDATE',
  'PUBLICATION_APPROVAL_REQUIRED',
  'AWAIT_HUMAN',
  'RECOVERY_BLOCKED',
  'NOTHING_TO_RESUME',
] as const;
export type ResumeAction = (typeof RESUME_ACTIONS)[number];

/** The shipped verbs a plan may name: `contract`, plus the seven lifecycle stages. */
export const RESUME_COMMANDS = ['contract', ...LIFECYCLE_COMMANDS] as const;
export type ResumeCommand = (typeof RESUME_COMMANDS)[number];

/**
 * What a transition costs, as capabilities rather than as minutes.
 *
 * `requiresCredential` is the configuration a model-needing action also needs, and
 * `requiresModel` is the request that gets spent: they are set together because the
 * only credential this build consumes is BharatCode's. A repository command is
 * `mutatesWorkspace` without being either — the gates are the repository's own code,
 * and running them is covered by `requiresExecutionConsent`, never granted here.
 */
const flagsSchema = z
  .object({
    stage: z.enum(RUN_STAGES).nullable(),
    command: z.enum(RESUME_COMMANDS).nullable(),
    requiresModel: z.boolean(),
    requiresCredential: z.boolean(),
    requiresExecutionConsent: z.boolean(),
    requiresRepairApproval: z.boolean(),
    requiresPublicationApproval: z.boolean(),
    mutatesWorkspace: z.boolean(),
  })
  .strict();

export const resumePlanSchema = z
  .object({
    schemaVersion: z.literal(RESUME_PLAN_SCHEMA_VERSION),
    runId: z.string().min(1),
    /** The facts this plan was read from, minus the moment they were read. */
    observedStateDigest: z.string().regex(/^[0-9a-f]{64}$/),
    /** The bytes here now, or `null` when this machine would not describe them. */
    currentPatchIdentity: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    action: z.enum(RESUME_ACTIONS),
    reason: z.string().min(1),
  })
  .strict()
  .merge(flagsSchema);
export type ResumePlan = z.infer<typeof resumePlanSchema>;

/**
 * What each action is made of, independent of which run it was chosen for.
 *
 * The pack row's stage is `null` on purpose: a pack is a rendering of the record,
 * and the record's stage vocabulary has no counter for it that this plan could
 * quote without inventing one.
 */
const PLAN: Record<ResumeAction, z.infer<typeof flagsSchema>> = {
  DERIVE_ACCEPTANCE_CONTRACT: costs({ stage: 'contract', command: 'contract' }),
  CREATE_PLAN: costs({
    requiresModel: true,
    requiresCredential: true,
    stage: 'plan',
    command: 'plan',
  }),
  RUN_IMPLEMENTATION_LOOP: costs({
    stage: 'implement',
    command: 'implement',
    requiresModel: true,
    requiresCredential: true,
    mutatesWorkspace: true,
  }),
  CONTINUE_IMPLEMENTATION: costs({
    stage: 'implement',
    command: 'implement',
    requiresModel: true,
    requiresCredential: true,
    mutatesWorkspace: true,
  }),
  VERIFY_CURRENT_PATCH: costs({
    stage: 'verify',
    command: 'verify',
    requiresExecutionConsent: true,
    mutatesWorkspace: true,
  }),
  REVIEW_CURRENT_PATCH: costs({
    stage: 'review',
    command: 'review',
    requiresModel: true,
    requiresCredential: true,
  }),
  REPAIR_PLAN_APPROVAL_REQUIRED: costs({
    stage: 'repair',
    command: 'repair',
    requiresModel: true,
    requiresCredential: true,
    requiresRepairApproval: true,
    mutatesWorkspace: true,
  }),
  REGENERATE_EVIDENCE_PACK: costs({ command: 'report' }),
  BUILD_PUBLICATION_CANDIDATE: costs({ stage: 'pr', command: 'pr' }),
  PUBLICATION_APPROVAL_REQUIRED: costs({
    stage: 'pr',
    command: 'pr',
    requiresPublicationApproval: true,
  }),
  AWAIT_HUMAN: costs({}),
  RECOVERY_BLOCKED: costs({}),
  NOTHING_TO_RESUME: costs({}),
};

/**
 * The plan for this snapshot, in the snapshot's own facts.
 *
 * Nothing is looked up from disk here: the snapshot already holds what the stages
 * recorded, what Git said about the workspace a moment ago, and what the currency
 * graph made of the pair. Taking that as the only input is what lets the same call
 * serve a preview and the revalidation immediately before an action.
 */
export function buildResumePlan(snapshot: StatusSnapshot): ResumePlan {
  const decision = decide(snapshot);
  return resumePlanSchema.parse({
    schemaVersion: RESUME_PLAN_SCHEMA_VERSION,
    runId: snapshot.runId,
    observedStateDigest: observedStateDigestOf(snapshot),
    currentPatchIdentity: snapshot.workspace.currentPatchIdentity,
    ...PLAN[decision.action],
    action: decision.action,
    reason: decision.reason,
  });
}

interface Decision {
  readonly action: ResumeAction;
  readonly reason: string;
}

function decide(snapshot: StatusSnapshot): Decision {
  if (snapshot.blockers.length > 0) {
    // §29: the blocker's own words are the reason, because the observation already
    // says what will not be done about it, and this file has nothing to add.
    return {
      action: 'RECOVERY_BLOCKED',
      reason:
        'Nothing is planned, because every stage this run could act on would fail for the same ' +
        `reason the status screen reports: ${snapshot.blockers.join(' ')}`,
    };
  }

  const stopped = stoppedLoopOf(snapshot);
  if (stopped) return stopped;

  const offer = snapshot.safeNextActions[0];
  if (offer) return fromOffer(snapshot, offer);

  if (snapshot.publication?.approvalState === 'CURRENT') {
    return {
      action: 'NOTHING_TO_RESUME',
      reason:
        'A human has approved the exact page this run holds, and the bytes it describes are ' +
        'still the bytes here. This build has no step that follows that agreement, so there is ' +
        'nothing for a resume to do — and no decision here can be read as one having been taken ' +
        'past it.',
    };
  }

  if (!snapshot.contract) {
    return {
      action: 'DERIVE_ACCEPTANCE_CONTRACT',
      reason:
        'This run has no Acceptance Contract on record, so nothing later has anything to be ' +
        'measured against. `mergesutra contract` derives the criteria from the repository and ' +
        'the issue: no model request, and no workspace touched.',
    };
  }

  return { action: 'AWAIT_HUMAN', reason: noOfferReason() };
}

/**
 * The interrupted-loop rule, read out of the loop's own record.
 *
 * `COMPLETED_BY_MODEL` means the model asked to stop, which is a claim Stage 7 gets
 * to check — that run is not interrupted, it is finished as far as the loop is
 * allowed to be. Anything else is a loop that stopped mid-work, and the only thing
 * that separates "continue it" from "ask a person" is whether the bounds it was
 * given still have room in them.
 */
function stoppedLoopOf(snapshot: StatusSnapshot): Decision | null {
  const loop = snapshot.implementation;
  if (!loop || loop.status === 'COMPLETED_BY_MODEL') return null;

  const spent = loop.budget;
  const bounds = {
    steps: spent.stepsUsed + spent.stepsLeft,
    writes: spent.writesUsed + spent.writesLeft,
    commands: spent.commandsUsed + spent.commandsLeft,
  };
  const hasRoom = spent.stepsLeft > 0 && spent.writesLeft > 0 && spent.commandsLeft > 0;

  if (loop.status === 'NEEDS_HUMAN_REVIEW') {
    return {
      action: 'AWAIT_HUMAN',
      reason:
        `The implementation loop stopped by saying it needs a person, which is the loop's own ` +
        'account and not something a resume can answer for. No command is planned over the top of ' +
        'that, and no model request is spent to ask the same question again.',
    };
  }

  if (hasRoom) {
    return {
      action: 'CONTINUE_IMPLEMENTATION',
      reason:
        `The loop named in this record stopped before the model said it was done, with ` +
        `${String(spent.stepsUsed)} of ${String(bounds.steps)} steps and ${String(spent.writesUsed)} ` +
        `of ${String(bounds.writes)} writes spent, and room in each bound for the rest. That loop, ` +
        'over the bytes that are here now, is what was interrupted — so verifying the unfinished ' +
        'patch would be answering a question the run has not asked yet.',
    };
  }

  return {
    action: 'AWAIT_HUMAN',
    reason:
      `The loop ended on the bound it was given: ${String(spent.stepsUsed)} of ` +
      `${String(bounds.steps)} steps, ${String(spent.writesUsed)} of ${String(bounds.writes)} writes ` +
      `and ${String(spent.commandsUsed)} of ${String(bounds.commands)} commands are spent. The bound ` +
      'is why the work stopped, and a plan here cannot hand out a larger one — that choice belongs ' +
      'to a person.',
  };
}

/**
 * The first thing the run is offered, translated.
 *
 * The offer is the whole argument — `next-actions.ts` gated it on every
 * precondition the stage checks — so this only names what kind of transition it is
 * and what is still outstanding. `pr` is the one that needs the snapshot: a page
 * that has not been built is a command to run, and a page sitting there unsigned is
 * a decision to wait for.
 */
function fromOffer(snapshot: StatusSnapshot, offer: SafeNextAction): Decision {
  if (offer.command === 'pr') {
    const page = snapshot.publication;
    if (page?.latest && page.state === 'CURRENT') {
      return {
        action: 'PUBLICATION_APPROVAL_REQUIRED',
        reason:
          `The page on record is the one built from these bytes, digest ${page.latest.digest.slice(
            0,
            12,
          )}, and no approval names that digest. \`mergesutra pr\` prints the page again for a reader ` +
          'to agree to; this build has no step past that agreement, and no part of this plan sends ' +
          'anything anywhere.',
      };
    }
    return {
      action: 'BUILD_PUBLICATION_CANDIDATE',
      reason:
        'Everything a page is assembled from is current for these bytes, and no candidate has been ' +
        'assembled from them yet. `mergesutra pr` builds the page from this run’s record and prints ' +
        'the digest a human then has to agree to.',
    };
  }

  const planned = OFFERED[offer.command];
  if (!planned) {
    // A suggestion outside this vocabulary is not a plan; saying so is cheaper than
    // guessing at what a verb this file has never heard of would go on to do.
    return { action: 'AWAIT_HUMAN', reason: noOfferReason() };
  }
  return planned;
}

/**
 * The six offers that translate one-for-one, with the reason each carries.
 *
 * Each sentence names the cost the plan's flags record, because §18 wants a model
 * request stated before it is spent and §17 wants an outstanding human decision
 * named as outstanding — a flag a screen could forget to print is not enough.
 */
const OFFERED: Record<string, Decision | undefined> = {
  plan: {
    action: 'CREATE_PLAN',
    reason:
      'An Acceptance Contract is on record and no plan has been drawn from it. `mergesutra plan` asks ' +
      'BharatCode for that plan: one model request, a plan document, and no workspace touched.',
  },
  implement: {
    action: 'RUN_IMPLEMENTATION_LOOP',
    reason:
      'A plan is on record and no implementation loop has run against it. `mergesutra implement` ' +
      'enters the bounded loop, spending model requests and writing files inside the workspace the ' +
      'plan names, up to the limits that loop is given.',
  },
  verify: {
    action: 'VERIFY_CURRENT_PATCH',
    reason:
      'The bytes in this workspace are not the ones the receipts on record describe, so what is owed ' +
      'is a fresh Stage 7 run over the patch that is here now. It spends no model request. The gates ' +
      'are this repository’s own commands, and each one a run asks to start needs consent for this ' +
      'scope first.',
  },
  review: {
    action: 'REVIEW_CURRENT_PATCH',
    reason:
      'These bytes carry verification that still describes them and no review of its own. `mergesutra ' +
      'review` shows a reviewer the diff beside the receipts that describe it and files the answer as ' +
      'its own document; it spends one model request.',
  },
  repair: {
    action: 'REPAIR_PLAN_APPROVAL_REQUIRED',
    reason:
      'A finding was weighed as something a repair cycle can act on, and the plan it names has not ' +
      'been approved by a human yet. That approval is the reader’s decision, so this plan stops at the ' +
      'boundary: no cycle runs, and no file is written, until somebody agrees to the digest `mergesutra ' +
      'repair` prints.',
  },
  report: {
    action: 'REGENERATE_EVIDENCE_PACK',
    reason:
      'The page a reviewer is handed is not on disk, or is not the one the record points at. ' +
      '`mergesutra report` renders it from this run’s record: no model request, no repository command, ' +
      'and nothing written outside the run’s own directory.',
  },
};

function noOfferReason(): string {
  return (
    'The record and the bytes here leave this run with no command that would be true to run next, ' +
    'so the next step is a person’s decision rather than this tool’s. Nothing here will pick a ' +
    'stage on the strength of a counter, and nothing here undoes the work that is on disk.'
  );
}

/**
 * The digest of the state this plan was read from.
 *
 * Canonicalised by hand rather than by hashing `JSON.stringify(snapshot)`: object
 * key order in a JSON document is not a fact about the run, and a digest that moved
 * because a field was written in a different order would be a preview that expires
 * for no reason. `observedAt` is the one field left out, because it records when the
 * question was asked — including it would mean every re-read invalidates the plan it
 * just produced, which is the property §34 is asking for and not its opposite.
 *
 * Everything else is hashed, including the suggestions: they are part of what the
 * preview was honest about, so a run that gained an offer between the preview and
 * the execution is a run this plan was not built for.
 */
function observedStateDigestOf(snapshot: StatusSnapshot): string {
  const { observedAt: _whenItWasRead, ...state } = snapshot;
  return sha256Hex(`${OBSERVED_STATE_LABEL}\n${canonicalJson(state)}`);
}

const OBSERVED_STATE_LABEL = 'mergesutra-observed-state/1';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort((left, right) =>
      left[0] < right[0] ? -1 : 1,
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function costs(over: Partial<z.infer<typeof flagsSchema>>): z.infer<typeof flagsSchema> {
  return flagsSchema.parse({
    stage: null,
    command: null,
    requiresModel: false,
    requiresCredential: false,
    requiresExecutionConsent: false,
    requiresRepairApproval: false,
    requiresPublicationApproval: false,
    mutatesWorkspace: false,
    ...over,
  });
}

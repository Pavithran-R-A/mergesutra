import {
  type NextActionRequirement,
  type SafeNextAction,
  type StatusSnapshot,
} from './snapshot.js';
import type { LifecycleArtifact } from './staleness.js';

/**
 * What a run may be told to do next, decided from the snapshot alone.
 *
 * This is the only place in Stage 11 that turns a measurement into a suggestion, so
 * it is written as if a suggestion were an action — because to the person reading a
 * status screen it is one. Four rules keep that honest:
 *
 * 1. **A command is offered because its preconditions hold now, not because the
 *    run's stage counter points at it.** Every one of the seven verbs below is
 *    gated on the graph's own row for the thing it produces: `review` is refused
 *    while the verification it would quote is stale, `repair` while the plan it
 *    would run is frozen against gone bytes or names a cycle this run has already
 *    carried out, `pr` while a finding still waits for
 *    that repair. A stage that would refuse the command on its own preconditions is
 *    never suggested past them.
 * 2. **A cost is named, in capabilities.** `requires` says whether running this
 *    spends a model call, runs something from the repository, needs a consent that
 *    does not exist yet, or only touches the run directory. `HUMAN_APPROVAL` marks
 *    the ones where the reader's yes is the missing thing, so a suggestion can never
 *    read as though that yes had already been given.
 * 3. **Nothing destructive is ever in the vocabulary.** The command set is closed,
 *    and no reason in this file names a reset, a clean-up, a branch operation or a
 *    publish — a status screen's suggestion must not be a route to undoing work,
 *    which is why recovering a budget belongs to `resume` and not to a re-run of
 *    `implement`.
 * 4. **When a fact on disk blocks every command, nothing is offered.** A workspace
 *    that is gone, unreadable or standing on someone else's history makes all seven
 *    verbs fail for the same reason, and a list of seven ways to fail is worse than
 *    a blank line beside the blocker.
 *
 * The reasons quote the staleness graph rather than restating it, so an expired row
 * and the suggestion that follows it cannot drift into describing different facts.
 */

/** Every verb this build actually has, in lifecycle order — the order actions are returned in. */
export const LIFECYCLE_COMMANDS = [
  'plan',
  'implement',
  'verify',
  'review',
  'repair',
  'report',
  'pr',
] as const;

export type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];

interface Offer {
  readonly command: LifecycleCommand;
  readonly requires: readonly NextActionRequirement[];
  readonly reason: string;
}

/**
 * The actions justified by this snapshot, in lifecycle order.
 *
 * Pure, and total over the snapshot: the same document always yields the same list,
 * because nothing here looks at a clock, a filesystem or a credential.
 */
export function nextActionsFor(snapshot: StatusSnapshot): SafeNextAction[] {
  if (snapshot.blockers.length > 0) return [];
  return offersOf(snapshot).map((offer) => ({
    command: offer.command,
    reason: offer.reason,
    requires: [...offer.requires],
  }));
}

function offersOf(snapshot: StatusSnapshot): Offer[] {
  const states = snapshot.lifecycle.states;
  const holds = (artifact: LifecycleArtifact) => states[artifact] === 'CURRENT';
  const expired = (artifact: LifecycleArtifact) =>
    snapshot.lifecycle.rows.find((row) => row.artifact === artifact)?.reason ?? '';
  // Stage 7 refuses a patch it cannot describe, so no command that measures bytes is
  // offered against a measurement this machine would not support.
  const measurable = snapshot.workspace.currentPatchIdentity !== null;
  const review = snapshot.review;
  const offers: Offer[] = [];

  if (snapshot.contract && !snapshot.plan) {
    offers.push({
      command: 'plan',
      requires: ['MODEL'],
      reason:
        'An Acceptance Contract is on record and no plan has been drawn from it. ' +
        '`mergesutra plan` asks the model for that plan: it spends a model call and ' +
        'files a plan document, nothing else.',
    });
  }

  if (snapshot.plan && !snapshot.implementation) {
    offers.push({
      command: 'implement',
      requires: ['MODEL', 'REPOSITORY_COMMAND'],
      reason:
        'A plan is on record and no implementation loop has run against it. ' +
        '`mergesutra implement` enters the bounded loop: it spends model calls, writes ' +
        'files and runs commands inside the workspace the plan names, up to the limits ' +
        'that loop is given.',
    });
  }

  if (snapshot.implementation && !holds('verification') && measurable) {
    offers.push({
      command: 'verify',
      requires: ['EXECUTION_CONSENT', 'REPOSITORY_COMMAND'],
      reason:
        (states.verification === 'ABSENT'
          ? 'The bytes in this workspace have never been verified. '
          : `${expired('verification')} `) +
        '`mergesutra verify` runs the gates the verification plan names and gathers fresh ' +
        'receipts. The commands are the repository’s own, and each one it is asked to ' +
        'start needs consent for this scope first.',
    });
  }

  if (snapshot.implementation && !holds('review') && holds('verification') && measurable) {
    offers.push({
      command: 'review',
      requires: ['MODEL'],
      reason:
        (states.review === 'ABSENT'
          ? 'The bytes in this workspace have never been reviewed. '
          : `${expired('review')} `) +
        '`mergesutra review` shows a reviewer the diff beside the receipts that describe ' +
        'it and files the answer as its own document. It spends a model call.',
    });
  }

  if (
    review?.routedToRepair &&
    holds('review') &&
    snapshot.repair?.plan &&
    holds('repairPlan') &&
    !holds('repairApproval') &&
    !cycleAlreadySpent(snapshot)
  ) {
    offers.push({
      command: 'repair',
      requires: ['MODEL', 'HUMAN_APPROVAL'],
      reason:
        'A finding was weighed as something a repair cycle can act on, and that plan has ' +
        'not been approved yet — the approval is the reader’s, not this tool’s. ' +
        '`mergesutra repair` runs a bounded loop over the scope the plan names, spends a ' +
        'model call and writes files, only once a human has approved the digest it prints.',
    });
  }

  if (snapshot.verification && needsRendering(snapshot)) {
    offers.push({
      command: 'report',
      requires: ['LOCAL_ONLY'],
      reason:
        (snapshot.report.packOnDisk === null
          ? 'No evidence pack has been rendered from this run’s record, so there is nothing ' +
            'on disk for a page to point at. '
          : `${expired('pack')} `) +
        '`mergesutra report` renders the pack from the run record: no model call, no ' +
        'repository command, and nothing written outside the run’s own directory.',
    });
  }

  const page = snapshot.publication;
  if (
    page &&
    holds('review') &&
    holds('verification') &&
    !review?.routedToRepair &&
    !holds('publicationApproval') &&
    snapshot.report.packOnDisk !== null
  ) {
    offers.push({
      command: 'pr',
      requires: ['HUMAN_APPROVAL'],
      reason: page.latest
        ? `The page on record is the one built from these bytes, digest ${page.latest.digest.slice(
            0,
            12,
          )}, and no approval names that digest. \`mergesutra pr\` prints the page again for a ` +
          'reader to agree to. This build publishes nothing: an approval here binds a human’s ' +
          'decision to a digest, and no remote is contacted by any command in it.'
        : 'Everything a page is assembled from is current, and no candidate has been proposed ' +
          'for these bytes yet. `mergesutra pr` builds the page from the record and prints the ' +
          'digest a human then has to approve; nothing in this build sends it anywhere.',
    });
  }

  return offers;
}

/**
 * Whether the cycle the plan on record names has already been carried out.
 *
 * `mergesutra repair` refuses a plan whose cycle pair is filed, because the yes on
 * record authorises the edit that document described once, and a second run of the
 * same cycle would spend a cycle nobody approved. So the screen may not invite it —
 * and the comparison has to be the pair, not the approval state. An approval row can
 * be moved by re-wording a persisted plan, since the sentence a finding carries is
 * inside its digest; a spent cycle cannot.
 */
function cycleAlreadySpent(snapshot: StatusSnapshot): boolean {
  const plan = snapshot.repair?.plan;
  const executions = snapshot.repair?.executions ?? [];
  if (!plan) return false;
  return executions.some(
    (execution) =>
      execution.reviewCycle === plan.reviewCycle && execution.repairCycle === plan.repairCycle,
  );
}

/**
 * Whether the page on disk still has work owed to it.
 *
 * The pack row is bound to what a *candidate* claims the page is, so `ABSENT` there
 * means only that no candidate has ever named it — which is also true of a run whose
 * pack was rendered a moment ago and is waiting to be proposed, and suggesting a
 * second render of a page that is already there would be a suggestion to do nothing.
 * So rendering is owed when nothing is on disk, or when something on record names
 * the page and the disk disagrees with it.
 */
function needsRendering(snapshot: StatusSnapshot): boolean {
  if (snapshot.report.packOnDisk === null) return true;
  return snapshot.report.state !== 'ABSENT' && snapshot.report.state !== 'CURRENT';
}

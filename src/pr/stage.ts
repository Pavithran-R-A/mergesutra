import path from 'node:path';
import { AppError } from '../core/errors.js';
import { readPackIdentity } from '../report/write.js';
import { describePatch, type PatchDescription } from '../verify/patch.js';
import {
  createRunRecord,
  parseRunRecord,
  type NewRunRecordInput,
  type RunCheck,
  type RunOutcome,
  type RunRecord,
} from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import {
  decidePublication,
  parsePublicationApproval,
  PUBLICATION_APPROVAL_SCHEMA_VERSION,
  type PublicationApproval,
  type PublicationApprovalDecision,
} from './approval.js';
import { sourceBranchOf, targetOf, type TargetBranchFacts } from './branch.js';
import { candidateOf, type PublicationCandidate } from './candidate.js';
import {
  draftOf,
  type DraftCriterion,
  type DraftFile,
  type DraftGate,
  type DraftIssue,
  type DraftReview,
} from './draft.js';
import { publicationDigestOf } from './digest.js';
import {
  readinessOf,
  type ReadinessCheck,
  type ReadinessFacts,
  type ReadinessReport,
} from './readiness.js';
import { buildPublicationRecord, type PublicationRecord } from './record.js';

/**
 * Stage 10's transition — recorded evidence becomes a page, and a page becomes a
 * filing. Nothing becomes a publication.
 *
 * Every field assembled here was already stated somewhere else: the title is the
 * issue's, the file list is Git's, the gate rows are Stage 7's receipts, the review is
 * Stage 9's, the caveats belong to whichever stage earned them, and the pack identity
 * is hashed from the bytes a reviewer can open. What this module owns is only the
 * *order*, and the order is where every shortcut available to a stage like this one
 * would live:
 *
 * 1. **The workspace is measured before anything is believed about it.** Each
 *     staleness question is a comparison against bytes read now, so a page cannot be
 *     assembled from the last run's idea of what was on disk.
 * 2. **The pack is read from disk, never re-rendered.** Stage 8's renderer prints the
 *     record's own stage and outcome, so rebuilding the pack here would move its
 *     identity every time this stage filed a record — and the approval bound to it
 *     would expire because a status line changed, not because the evidence did.
 * 3. **A proposal already on file wins over a fresh assembly of the same one.** The
 *     digest excludes the timestamp precisely so this is not a rewrite: re-stamping
 *     the page a human read would change the document their yes was about.
 * 4. **The remote is not reachable from here.** This module imports no publisher, no
 *     transport, no client and no runner, and it issues no commands. `published` is
 *     the literal `false`, because no path through this file could make it otherwise.
 *
 * Two refusals share an outcome word and differ in what they touch. A run whose
 * evidence is missing or stale files no publication at all: filing a page over bytes
 * that have moved would create the thing a later reader mistakes for a proposal. A
 * typed approval that names some other page also files nothing — a person tried to say
 * yes, and the answer was "not to this". A run whose evidence is complete and which
 * nobody has agreed to *is* filed, because showing the page is the whole job.
 */

/** Said on every screen and in every record this stage writes, in its own words. */
const REMOTE_BOUNDARY =
  'No branch was pushed and no pull request was opened: this build has no publication ' +
  'remote, so an approval here records a decision and performs no action.';

export interface PrStageInput {
  readonly runId: string;
  /**
   * The digest of the page the operator read and approved, typed on purpose.
   *
   * Absent means this command assembles and shows a page and approves nothing, which
   * is the only default a stage that speaks about somebody else's repository may have.
   */
  readonly approve?: string;
  /** Where the run's workspace hangs off; defaults to its recorded toplevel. */
  readonly repo?: string;
}

export interface PrStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  /** Where this run's pack lives; defaults to the run store's own root. */
  readonly runsRoot?: string;
}

export interface PrStageResult {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly readiness: ReadinessReport;
  /** Null when the evidence could not support a page at all. */
  readonly candidate: PublicationCandidate | null;
  readonly digest: string | null;
  readonly decision: PublicationApprovalDecision | null;
  /** Always false in this build: see the header. */
  readonly published: false;
  readonly record: RunRecord;
  readonly recordFile: string | null;
  readonly checks: readonly RunCheck[];
}

export async function runPrStage(
  input: PrStageInput,
  deps: PrStageDeps = {},
): Promise<PrStageResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const now = deps.now ?? (() => new Date());
  const runsRoot = deps.runsRoot ?? defaultRunStoreRoot(cwd);

  const runId = input.runId;
  const source = parseRunRecord(await store.load(runId));

  const patch = await measurePatch(source, input.repo, cwd);
  const packOnDisk = await readPackIdentity(runsRoot, runId);

  const assembled = assembleCandidate({
    source,
    patch,
    packIdentity: packOnDisk,
    createdAt: now().toISOString(),
  });
  const priorIndex =
    assembled.digest === null
      ? -1
      : source.publications.findIndex(
          (entry) => publicationDigestOf(entry.candidate) === assembled.digest,
        );
  const prior = priorIndex >= 0 ? (source.publications[priorIndex] ?? null) : null;
  // The filed document wins over the fresh assembly of it, digest and all.
  const candidate = prior?.candidate ?? assembled.candidate;
  const digest = candidate === null ? null : publicationDigestOf(candidate);

  const typed = approvalTyped(input, now);
  const decision =
    candidate === null
      ? null
      : decidePublication({ candidate, approval: typed ?? prior?.approval });

  const report = readinessOf({
    ...factsOf({ source, patch, packOnDisk }),
    approval: decision?.status ?? 'ABSENT',
  });
  const evidenceBlocking = report.blocking.filter((row) => row.id !== 'human-approved');
  const showable = candidate !== null && digest !== null && evidenceBlocking.length === 0;
  // A yes that does not fit this page is not progress; it is a person who should look again.
  const approvalRefused = typed !== null && decision?.allowed !== true;
  const outcome: RunOutcome =
    !showable || approvalRefused
      ? 'PR_PUBLICATION_BLOCKED'
      : decision?.allowed === true
        ? 'PR_APPROVED_LOCAL'
        : 'PR_CANDIDATE_RECORDED';

  const checks: RunCheck[] = [
    ...report.checks.map(readinessRow),
    proposalRow({ candidate: showable ? candidate : null, digest, refusal: assembled.refusal }),
    approvalRow({ decision, typed, showable }),
    nextStepRow({ report, runId }),
    { name: 'Publication boundary', status: 'INFO', detail: REMOTE_BOUNDARY },
  ];
  const publications = filings({ outcome, source, candidate, priorIndex, typed });

  const record = createRunRecord({
    ...carried(source),
    stage: 'pr',
    outcome,
    publications,
    checks,
    nextStage: nextStageFor({ outcome, report, digest, runId }),
  });

  let recordFile: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    // A record that cannot be filed says so where the person is already looking: the
    // screen is the only copy of the page until the write succeeds.
    checks.push({
      name: 'Run record',
      status: 'WARN',
      detail:
        `The page above was assembled but not filed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    runId,
    outcome,
    readiness: report,
    candidate: showable ? candidate : null,
    digest: showable ? digest : null,
    decision,
    published: false,
    record,
    recordFile,
    checks,
  };
}

/**
 * Which bytes are on disk right now, or why they cannot be named.
 *
 * The workspace comes from the run's own record, under a root the operator may have
 * pointed at; the measurement itself belongs to Stage 7 and is not re-implemented
 * here. An unnameable workspace propagates as the refusal it is — a run whose patch
 * cannot be read does not have an empty patch, and treating it as one would let a
 * deleted directory produce a page asserting whatever the last record happened to say.
 */
async function measurePatch(
  source: RunRecord,
  repo: string | undefined,
  cwd: string,
): Promise<PatchDescription | null> {
  const implementation = source.implementation;
  if (!implementation) return null;
  const root = path.resolve(repo ?? source.local?.toplevel ?? cwd);
  return describePatch({
    workspace: path.resolve(root, implementation.workspace.relativePath),
    baseSha: implementation.workspace.baseSha,
  });
}

/** The seven facts readiness asks about, all of them read rather than inferred. */
function factsOf(input: {
  source: RunRecord;
  patch: PatchDescription | null;
  packOnDisk: string | null;
}): Omit<ReadinessFacts, 'approval'> {
  const { source, patch, packOnDisk } = input;
  const patchIdentity = patch?.identity ?? null;
  const verification = source.verification;
  const review = source.review;
  return {
    patchIdentity,
    verification: verification
      ? {
          patchIdentity: verification.patchIdentity,
          current: patchIdentity !== null && verification.patchIdentity === patchIdentity,
          result: verification.result,
        }
      : null,
    review: review
      ? {
          current: patchIdentity !== null && review.reviewedPatchIdentity === patchIdentity,
          findings: review.findings.map((finding) => ({
            severity: finding.severity,
            disposition: finding.disposition,
          })),
        }
      : null,
    repairOutcomes: source.repairExecutions.map((execution) => execution.scope.outcome),
    evidencePack:
      packOnDisk === null
        ? null
        : {
            identity: packOnDisk,
            // The pack prints the patch Stage 7 planned against, so that is the field
            // a reader can check the rendered page against.
            patchIdentity: source.verificationPlan?.patchIdentity ?? null,
          },
  };
}

interface Assembled {
  readonly candidate: PublicationCandidate | null;
  readonly digest: string | null;
  /** Why nothing was assembled, in the words of the module that refused. */
  readonly refusal: string | null;
}

/**
 * Freeze the page, or say which document is missing.
 *
 * Every input is a lookup into the record or a measurement of the workspace, and the
 * functions allowed to refuse — `targetOf`, `sourceBranchOf`, `candidateOf` — are
 * called inside one `try` so a refusal arrives as a sentence a human can act on rather
 * than as a stack trace. Nothing else is caught: any other error is a bug, and a stage
 * that publishes pages should not be swallowing evidence about its own failures.
 */
function assembleCandidate(input: {
  source: RunRecord;
  patch: PatchDescription | null;
  packIdentity: string | null;
  createdAt: string;
}): Assembled {
  const { source, patch, packIdentity, createdAt } = input;
  try {
    const target = targetOf({
      repository: source.repository,
      local: source.local,
      base: source.base,
    });
    const proposed = sourceBranchOf({
      runId: source.runId,
      workspaceBranch: source.implementation?.workspace.branch ?? null,
      targetBranch: target.branch,
    });
    const issue = issueOf(source, target);
    const closesIssue = closesTheIssue({ source, patch, target });
    const baseSha = patch?.baseSha ?? target.baseSha;
    const verificationSummary = verificationSummaryOf(source);
    const draft = draftOf({
      runId: source.runId,
      target: { fullName: target.fullName, branch: target.branch },
      issue,
      closesIssue,
      criteria: criteriaOf(source),
      gates: gatesOf(source),
      verification: verificationSummary,
      patchIdentity: patch?.identity ?? null,
      baseSha,
      files: filesOf(patch),
      review: reviewOf(source),
      limitations: source.limitations,
    });
    const candidate = candidateOf({
      runId: source.runId,
      createdAt,
      issue: issue && { canonical: issue.canonical, number: issue.number, closes: closesIssue },
      target: { fullName: target.fullName, branch: target.branch },
      proposedBranch: proposed.name,
      baseSha,
      patchIdentity: patch?.identity ?? null,
      draft,
      evidencePackIdentity: packIdentity,
      verificationSummary,
      review: source.review
        ? {
            cycle: reviewCycleOf(source),
            reviewedPatchIdentity: source.review.reviewedPatchIdentity,
            summary: source.review.summary,
          }
        : null,
      limitations: source.limitations,
    });
    return { candidate, digest: publicationDigestOf(candidate), refusal: null };
  } catch (error) {
    if (error instanceof AppError) {
      return { candidate: null, digest: null, refusal: error.message };
    }
    throw error;
  }
}

/**
 * The yes this command was given, or `null`.
 *
 * Only a typed flag mints an approval, and it is validated through
 * `parsePublicationApproval`, which accepts one run, one 64-character digest, one
 * timestamp and one action — so there is no field for "and everything like it". A
 * stored approval is read separately, and only ever for the entry whose candidate still
 * digests to the page on screen.
 */
function approvalTyped(input: PrStageInput, now: () => Date): PublicationApproval | null {
  if (input.approve === undefined) return null;
  // Approved now, by the act of typing the digest: the one place a yes is authored from
  // a command line, and the human's own words are its only author.
  return parsePublicationApproval({
    schemaVersion: PUBLICATION_APPROVAL_SCHEMA_VERSION,
    runId: input.runId,
    publicationDigest: input.approve,
    approvedAt: now().toISOString(),
    action: 'CREATE_PULL_REQUEST',
  });
}

/**
 * File, fill, or leave alone.
 *
 * A blocked stage writes no publication, because a page nobody could stand behind is
 * not a proposal. Otherwise the entry for this exact digest is filled with the typed
 * yes, or appended without one — and an approval read back from storage leaves the
 * array untouched, since rewriting it would move the time the human gave it.
 */
function filings(input: {
  outcome: RunOutcome;
  source: RunRecord;
  candidate: PublicationCandidate | null;
  priorIndex: number;
  typed: PublicationApproval | null;
}): PublicationRecord[] {
  const { outcome, source, candidate, priorIndex, typed } = input;
  const carried = [...source.publications];
  if (outcome === 'PR_PUBLICATION_BLOCKED' || candidate === null) return carried;
  if (typed !== null) {
    const entry = buildPublicationRecord({ candidate, approval: typed });
    return priorIndex >= 0
      ? carried.map((row, index) => (index === priorIndex ? entry : row))
      : [...carried, entry];
  }
  return priorIndex >= 0
    ? carried
    : [...carried, buildPublicationRecord({ candidate, approval: null })];
}

function readinessRow(check: ReadinessCheck): RunCheck {
  return {
    name: `Readiness · ${check.id}`,
    status: check.passed ? 'INFO' : 'WARN',
    detail: check.detail,
  };
}

/**
 * The page as a line, with everything a person needs in order to decide whether to
 * read the whole of it.
 *
 * The row carries no verdict of its own: `candidate` and `digest` are the same pair
 * `--approve` takes, so what a screen prints and what a yes has to name cannot drift
 * apart between the two.
 */
function proposalRow(input: {
  candidate: PublicationCandidate | null;
  digest: string | null;
  refusal: string | null;
}): RunCheck {
  const { candidate, digest, refusal } = input;
  if (candidate === null || digest === null) {
    return {
      name: 'Publication proposal',
      status: 'FAIL',
      detail:
        (refusal ?? 'No publication candidate could be assembled.') +
        ' MergeSutra will not fill the gap from a model, a template, or this stage’s own guess.',
    };
  }
  return {
    name: 'Publication proposal',
    status: 'INFO',
    detail:
      `${candidate.prTitle} — ${candidate.proposedBranch} into ${candidate.targetBranch} ` +
      `(${candidate.repository}); patch ${short(candidate.patchIdentity)}, evidence pack ` +
      `${short(candidate.evidencePackIdentity)}, body ${String(candidate.prBody.length)} ` +
      `characters. Digest ${digest}.`,
  };
}

function approvalRow(input: {
  decision: PublicationApprovalDecision | null;
  typed: PublicationApproval | null;
  showable: boolean;
}): RunCheck {
  const { decision, typed, showable } = input;
  if (decision) {
    return {
      name: 'Publication approval',
      status: decision.allowed ? 'INFO' : 'WARN',
      detail: decision.reason,
    };
  }
  return {
    name: 'Publication approval',
    status: 'WARN',
    detail: typed
      ? `An approval naming ${short(typed.publicationDigest)} was given, but no candidate could be ` +
        'assembled to compare it against, so nothing was approved.'
      : `No page is on screen to approve${showable ? '' : ', because the evidence above is incomplete'}.`,
  };
}

/** Where each unmet condition is actually answered — never from this stage. */
const STAGE_FOR_CHECK: Record<ReadinessCheck['id'], string> = {
  'patch-measured': '`mergesutra verify`',
  'verification-current': '`mergesutra verify`',
  'verification-passed': '`mergesutra verify`',
  'review-current': '`mergesutra review`',
  'no-repair-candidate-left': '`mergesutra repair`',
  'no-scope-violation': '`mergesutra review`',
  'pack-current': '`mergesutra report`',
  'human-approved': 'this command with --approve',
};

/**
 * Which earlier stage owes the missing fact, said out loud.
 *
 * A consumer names the stage that would supply what it lacks and stops. The row also
 * has to be readable by a person who expects the tool to fix things by itself, so it
 * says plainly that no gate ran here.
 */
function nextStepRow(input: { report: ReadinessReport; runId: string }): RunCheck {
  const missing = input.report.blocking.filter((row) => row.id !== 'human-approved');
  if (missing.length === 0) {
    return {
      name: 'Publication next step',
      status: 'INFO',
      detail:
        'Every fact this stage reads is current, so the page above is the page a human is asked ' +
        `about. To agree to exactly it: \`mergesutra pr ${input.runId} --approve <digest>\`. ` +
        REMOTE_BOUNDARY,
    };
  }
  const commands = [...new Set(missing.map((row) => STAGE_FOR_CHECK[row.id]))];
  return {
    name: 'Publication next step',
    status: 'WARN',
    detail:
      `Not ready to publish: ${missing.map((row) => row.id).join(', ')}. Stage 10 is a consumer, ` +
      `so no gate was re-run and no review was repeated to make the page fit. Run ${commands.join(
        ' or ',
      )} on this run, then \`mergesutra pr ${input.runId}\` again.`,
  };
}

function nextStageFor(input: {
  outcome: RunOutcome;
  report: ReadinessReport;
  digest: string | null;
  runId: string;
}): string {
  if (input.outcome === 'PR_APPROVED_LOCAL') {
    return (
      `HUMAN_APPROVED_FOR_PR — a human approved digest ${String(input.digest).slice(0, 12)}… for ` +
      `this run, and the page is filed. ${REMOTE_BOUNDARY}`
    );
  }
  if (input.outcome === 'PR_CANDIDATE_RECORDED') {
    return (
      `NEEDS_HUMAN_APPROVAL — read the page, then run \`mergesutra pr ${input.runId} --approve ` +
      `${String(input.digest)}\` if it is what you mean to publish. ${REMOTE_BOUNDARY}`
    );
  }
  const missing = input.report.blocking.map((row) => row.id);
  return (
    `NOT_READY_FOR_PUBLICATION — ${missing.join(', ') || 'no candidate could be assembled'}. ` +
    `The commands that would supply them are named in the rows above. ${REMOTE_BOUNDARY}`
  );
}

/** Every field this stage does not own, copied forward by name. */
function carried(
  source: RunRecord,
): Omit<NewRunRecordInput, 'stage' | 'outcome' | 'checks' | 'nextStage' | 'publications'> {
  return {
    runId: source.runId,
    createdAt: source.createdAt,
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: source.acceptanceContract,
    plan: source.plan,
    implementation: source.implementation,
    verificationPlan: source.verificationPlan,
    verification: source.verification,
    executionConsent: source.executionConsent,
    evidence: source.evidence,
    review: source.review,
    repairPlan: source.repairPlan,
    repairExecutions: source.repairExecutions,
    limitations: source.limitations,
  };
}

/** The issue as the page sees it: an identity from Stage 1, a title from Stage 1's document. */
function issueOf(source: RunRecord, target: TargetBranchFacts): DraftIssue | null {
  const ref = source.issueRef;
  if (!ref) return null;
  return {
    canonical: ref.canonical,
    number: ref.number,
    url: ref.url,
    title: source.issue?.title ?? null,
    sameRepository:
      ref.host === target.host && ref.owner === target.owner && ref.repo === target.repo,
  };
}

/**
 * Whether this page may say it closes the issue.
 *
 * The strictest rule in the stage, because it is the only one GitHub acts on: a
 * `Fixes #n` deletes a reviewer's workflow when it is wrong. So it takes evidence that
 * names every criterion, calls each one verified, and was measured on the bytes still
 * on disk — plus an issue in the repository being targeted. Anything short of that
 * links the issue and says nothing at all about closing it.
 */
function closesTheIssue(input: {
  source: RunRecord;
  patch: PatchDescription | null;
  target: TargetBranchFacts;
}): boolean {
  const { source, patch, target } = input;
  const evidence = source.evidence;
  if (!evidence || patch === null || evidence.criteria.length === 0) return false;
  if (evidence.currentPatchIdentity !== patch.identity) return false;
  const everyCriterionVerified = evidence.criteria.every(
    (criterion) => criterion.status === 'PASS' && criterion.sufficiency === 'VERIFIED',
  );
  return everyCriterionVerified && issueOf(source, target)?.sameRepository === true;
}

/**
 * Which reading of these bytes this is.
 *
 * The review document does not number itself, so the lineage is counted from the only
 * list a reviewer's turn produces: the repair cycles that have already moved these
 * bytes. None means the first review; one means the review that followed the first
 * repair, which is what Stage 9 freezes into its next plan.
 */
function reviewCycleOf(source: RunRecord): number {
  return source.repairExecutions.length + 1;
}

function criteriaOf(source: RunRecord): DraftCriterion[] {
  const evidence = source.evidence;
  if (evidence) {
    return evidence.criteria.map((criterion) => ({
      id: criterion.criterionId,
      statement: criterion.statement,
      status: criterion.status,
    }));
  }
  return (source.acceptanceContract?.criteria ?? []).map((criterion) => ({
    id: criterion.id,
    statement: criterion.statement,
    status: criterion.status,
  }));
}

function gatesOf(source: RunRecord): DraftGate[] {
  return (source.verification?.gates ?? []).map((outcome) => ({
    id: outcome.receipt.gateId,
    argv: outcome.receipt.argv,
    result: outcome.receipt.result,
    exitCode: outcome.receipt.exitCode,
  }));
}

function filesOf(patch: PatchDescription | null): DraftFile[] {
  return (patch?.files ?? []).map((file) => ({ path: file.path, change: file.change }));
}

function reviewOf(source: RunRecord): DraftReview | null {
  const review = source.review;
  if (!review) return null;
  return {
    cycle: reviewCycleOf(source),
    modelId: review.modelId,
    findings: review.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      disposition: finding.disposition,
    })),
  };
}

/** The verdict plus the size of the evidence behind it, in Stage 7's own words. */
function verificationSummaryOf(source: RunRecord): string | null {
  const run = source.verification;
  if (!run) return null;
  const ran = run.gates.filter((gate) => gate.receipt.exitCode !== null).length;
  return (
    `${run.result}: ${String(run.gates.length)} gate(s) recorded, ${String(ran)} ran, over plan ` +
    `revision ${String(run.planRevision)} on patch ${short(run.patchIdentity)}`
  );
}

/** Twelve characters identifies a digest to a human reading a row. */
function short(value: string | null): string {
  return value === null ? 'nothing measured' : `${value.slice(0, 12)}…`;
}

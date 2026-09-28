import path from 'node:path';
import { AppError } from '../core/errors.js';
import { runImplementationLoop, type ImplementationLoopDeps } from '../implement/loop.js';
import type { ImplementationRecord } from '../implement/state.js';
import type { LoopBrief } from '../implement/prompt.js';
import { buildEvidencePack } from '../report/pack.js';
import { writeEvidencePack } from '../report/write.js';
import {
  createRunRecord,
  parseRunRecord,
  type RunCheck,
  type RunRecord,
} from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { newestRunId } from '../state/run-selection.js';
import { verdictIsPassed, type GateExecutionSpec } from '../verify/engine.js';
import { describePatch } from '../verify/patch.js';
import { loopClaim, verifyWorkspace, type WorkspaceVerification } from '../verify/workspace.js';
import { resolveLimit, type RepairLimits } from './bounds.js';
import {
  decideRepairApproval,
  parseRepairApproval,
  type RepairApproval,
  type RepairApprovalDecision,
} from './consent.js';
import { assembleRepairContext } from './context.js';
import { buildRepairExecution, type RepairExecution } from './execution.js';
import { resolveRepairLimits } from './limits.js';
import type { RepairPlan } from './plan.js';
import { routeRepairScope } from './scope.js';

/**
 * Stage 9R's transition — an approved plan becomes an edit, and the edit becomes
 * a re-measurement of everything the run used to claim.
 *
 * This is the only module in `src/repair` with hands, and it has none of its own.
 * The writer, the reader and the runner belong to Stage 6's loop; the gate round
 * belongs to Stage 7's `verifyWorkspace`, the same function the `verify` command
 * calls; the pack belongs to Stage 8. What lives here is the *order*, and the
 * order is where every shortcut this product could take would live: asking a
 * model before a human says yes, editing against bytes that have already gone,
 * keeping receipts that describe a patch the workspace no longer holds, calling a
 * failed gate a reason to edit again, or freezing the next cycle off this one's
 * answer. Each of those is refused below, in the order it has to be refused.
 *
 * Three of the shortcuts are worth naming because they are the tempting ones.
 *
 * 1. **Nothing is written to know whether the plan still fits.** The patch is
 *    measured before the loop starts and compared to the digest the findings were
 *    written against, so a cycle that would answer a gone patch costs no model
 *    turns and no bytes.
 * 2. **The consent it reuses is the consent it found.** The re-verification is
 *    handed the run's stored execution consent and nothing else — no `--allow`, no
 *    re-granted yes. Whether that consent still covers this round is decided by
 *    its own digest comparison inside Stage 7, not by a rule written here, which
 *    is why a repair round and an original round produce comparable answers.
 * 3. **A cycle is never repeated by this module.** One plan, one loop, one round.
 *    A failed gate, an out-of-scope write and a cycle that moved nothing all end
 *    with a record pointing at a person; the edit each left behind stays on disk,
 *    because reverting a workspace would be this stage destroying work it was not
 *    asked to touch.
 *
 * The outcome words it can write are the record's three repair outcomes, and none
 * of them is a verdict on the contribution: `REPAIR_APPLIED` means bytes moved
 * inside the approved scope *and* a gate round measured them again, which is still
 * not a claim that the patch is right.
 */

/**
 * Who says a repair cycle's own claim of finishing is a claim.
 *
 * Parallel to Stage 7's source string for the implementation loop's `FINISH`, and
 * deliberately not the same words: two cycles' accounts of the same file are two
 * accounts, and a reader has to be able to tell which one said what.
 */
const REPAIR_LOOP_CLAIM_SOURCE =
  'repair cycle — the model’s FINISH action for this plan (a claim; nothing below read it)';

export interface RepairStageInput {
  readonly runId?: string;
  /**
   * The digest of the plan the operator read and approved, typed on purpose.
   *
   * Absent means this command shows the plan and mutates nothing, which is the
   * only default a stage with a writer may have.
   */
  readonly approvePlan?: string;
  /** Where the primary checkout is; defaults to the run's recorded toplevel. */
  readonly repo?: string;
  readonly signal?: AbortSignal;
}

export interface RepairStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  /** Where this run's pack is written; defaults to the run store's own root. */
  readonly runsRoot?: string;
  /** Absent means the loop's own configured client, which needs a real credential. */
  readonly client?: NonNullable<ImplementationLoopDeps['client']>;
  /** How the re-verification starts its gate processes. A test seam, the engine's shape. */
  readonly runFor?: (spec: GateExecutionSpec) => NonNullable<ImplementationLoopDeps['run']>;
  /** Bounds a caller may tighten; the ceilings in `bounds.ts` are not movable. */
  readonly limits?: Partial<RepairLimits>;
}

export interface RepairStageResult {
  readonly runId: string;
  readonly executed: boolean;
  readonly decision: RepairApprovalDecision;
  readonly record: RunRecord;
  /** Null unless a cycle ran; a refused approval writes no execution and no record. */
  readonly execution: RepairExecution | null;
  /** Null when the cycle owed no re-verification, or was stopped before one. */
  readonly round: WorkspaceVerification | null;
  readonly checks: readonly RunCheck[];
  readonly recordFile: string | null;
  readonly packDir: string | null;
  readonly packError: string | null;
}

export async function runRepairStage(
  input: RepairStageInput = {},
  deps: RepairStageDeps = {},
): Promise<RepairStageResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const now = deps.now ?? (() => new Date());
  const runsRoot = deps.runsRoot ?? defaultRunStoreRoot(cwd);

  const runId = input.runId ?? (await newestPlannedRunId(store));
  const source = parseRunRecord(await store.load(runId));
  const plan = requirePlan(source, runId);
  refuseSpentCycle(source, plan);
  const contract = need(
    source.acceptanceContract,
    runId,
    'no Acceptance Contract, so a cycle would have no obligations to answer to',
    'Run `mergesutra contract` on this run first.',
  );
  const implementation = need(
    source.implementation,
    runId,
    'no implementation record, so this run owns no workspace to edit',
    'Run `mergesutra implement` on this run first.',
  );
  const stagePlan = need(
    source.plan,
    runId,
    'no Stage 4 plan, and the loop the cycle runs through prompts from one',
    'Run `mergesutra plan` on this run first.',
  );
  const previousRound = need(
    source.verificationPlan,
    runId,
    'no verification plan to revise, so a re-verification would mint new gate ids rather than ' +
      're-measure the ones the review read',
    'Run `mergesutra verify` on this run first.',
  );

  const approval = approvalFor(input, now);
  const decision = decideRepairApproval({ plan, approval });
  if (!decision.allowed) {
    // No record is written: a run that was not approved is the same run it was
    // before the command was typed, and rewriting it would say otherwise.
    return {
      runId,
      executed: false,
      decision,
      record: source,
      execution: null,
      round: null,
      checks: [approvalRow(decision)],
      recordFile: null,
      packDir: null,
      packError: null,
    };
  }

  const primaryRoot = path.resolve(input.repo ?? source.local?.toplevel ?? cwd);
  const workspace = path.resolve(primaryRoot, implementation.workspace.relativePath);
  const baseSha = implementation.workspace.baseSha;
  const before = await describePatch({ workspace, baseSha });
  if (before.identity !== plan.reviewedPatchIdentity) {
    throw new AppError({
      kind: 'validation',
      message:
        `The workspace no longer holds the bytes this plan was frozen against: the plan names ` +
        `${plan.reviewedPatchIdentity.slice(0, 12)}… and this workspace measures ${before.identity.slice(
          0,
          12,
        )}…. A repair that ran here would answer findings about a patch that has gone.`,
      remediation:
        'Review these bytes with `mergesutra review` and approve the plan that freezes from that ' +
        'reading. Nothing here will be edited, reverted or cleaned to make the old plan fit.',
      details: { runId, planned: plan.reviewedPatchIdentity, measured: before.identity },
    });
  }

  const context = assembleRepairContext({ record: source, plan });
  const brief: LoopBrief = {
    material: context.text,
    writableFiles: plan.expectedFiles,
    contextFiles: context.files,
  };
  const loop = await runImplementationLoop(
    {
      runId,
      record: source,
      contract,
      plan: stagePlan,
      workspaceRoot: workspace,
      workspace: implementation.workspace,
      limits: resolveRepairLimits(),
      brief,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    {
      now,
      ...(deps.client ? { client: deps.client } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );

  const after = await describePatch({ workspace, baseSha });
  const execution = buildRepairExecution({
    plan,
    approval,
    patchBefore: before,
    patchAfter: after,
    implementation: loop,
    createdAt: now().toISOString(),
  });

  const owedReverification = routeRepairScope(execution.scope) === 'REVERIFY_THROUGH_STAGE_7';
  const round = owedReverification
    ? await verifyWorkspace(
        {
          runId,
          workspace,
          baseSha,
          contract,
          // The claims this round files are the earlier loop's, kept, plus this
          // cycle's. Both are attributed, and nothing that decides a status reads
          // either one.
          claims: [
            ...(source.evidence?.claims ?? []),
            ...loopClaim(REPAIR_LOOP_CLAIM_SOURCE, loop.finishClaim),
          ],
          // The yes the human already gave, and no fresh one. Whether it still
          // covers this round is Stage 7's digest comparison to make.
          consent: source.executionConsent,
          previous: {
            plan: previousRound,
            reason:
              `Repair cycle ${String(plan.repairCycle)} moved the patch to ` +
              `${after.identity.slice(0, 12)}…, so the gates are measured against these bytes.`,
          },
          ...(input.signal ? { signal: input.signal } : {}),
        },
        { now, ...(deps.runFor ? { runFor: deps.runFor } : {}) },
      )
    : null;

  const extra = disclose({ execution, round, runId });
  const outcome = outcomeFor(execution, round, loop);
  const record = createRunRecord({
    runId,
    createdAt: source.createdAt,
    stage: 'repair',
    outcome,
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: contract,
    plan: stagePlan,
    implementation,
    verificationPlan: round?.plan ?? source.verificationPlan,
    verification: round?.run ?? source.verification,
    executionConsent: round?.consent ?? source.executionConsent,
    evidence: round?.evidence ?? source.evidence,
    review: source.review,
    repairPlan: source.repairPlan,
    repairExecutions: [...source.repairExecutions, execution],
    checks: [
      approvalRow(decision),
      ...cycleRows(loop, execution),
      reverificationRow(execution, round),
      ...(round?.checks ?? []),
    ],
    nextStage: nextStageFor(execution, round, plan, deps.limits),
    limitations: [
      ...new Set([
        ...source.limitations,
        ...context.limitations,
        ...(round?.plan.missingPrerequisites ?? []),
        ...extra,
      ]),
    ],
  });

  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }

  // The pack is regenerated from the record that was just filed, in this run's own
  // directory, by Stage 8's renderer — and a pack that cannot be written is said
  // about rather than swallowed, because a run whose evidence went stale deserves
  // a reader, not a silent hole.
  let packDir: string | null = null;
  let packError: string | null = saveError;
  if (!packError) {
    try {
      packDir = (await writeEvidencePack(runsRoot, buildEvidencePack(record))).dir;
    } catch (error) {
      packError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    runId,
    executed: true,
    decision,
    record,
    execution,
    round,
    checks: [...record.checks, packRow(packDir, packError)],
    recordFile,
    packDir,
    packError,
  };
}

/**
 * One approved cycle, once — whatever the process count is.
 *
 * A cycle edits a repository, and the yes that authorises it names one digest.
 * Every entry is handed a fresh loop budget by `resolveRepairLimits()`, so the only
 * thing that bounds a run across restarts is how many cycles it has filed, and a
 * count is a bound only if an entry reads it from the record rather than starting
 * at zero again. The comparison is the cycle pair, not the plan digest: a digest
 * covers a scope that a person can re-word in a persisted record, and a re-worded
 * plan over a spent cycle is the same spent cycle wearing a new approval.
 */
function refuseSpentCycle(source: RunRecord, plan: RepairPlan): void {
  const spent = source.repairExecutions.some(
    (execution) =>
      execution.reviewCycle === plan.reviewCycle && execution.repairCycle === plan.repairCycle,
  );
  if (!spent) return;
  throw new AppError({
    kind: 'validation',
    message:
      `Review cycle ${String(plan.reviewCycle)} / repair cycle ${String(plan.repairCycle)} of this run ` +
      'has already been carried out and filed. Running this plan again would spend a cycle nobody ' +
      'approved: the yes on record authorises the edit that document described, once.',
    remediation:
      'Read what the filed cycle did with `mergesutra status` and `mergesutra report`, then decide ' +
      'the next step. A further cycle needs a fresh review of the current bytes and a plan frozen ' +
      'from that reading, with its own approval.',
    details: { runId: source.runId, reviewCycle: plan.reviewCycle, repairCycle: plan.repairCycle },
  });
}

function requirePlan(source: RunRecord, runId: string): RepairPlan {
  const plan = source.repairPlan;
  if (!plan) {
    throw new AppError({
      kind: 'validation',
      message:
        `Run '${runId}' has no repair plan, so there is nothing for a repair cycle to carry out. ` +
        'A plan is frozen from a review of these bytes, and it names the files a cycle may reach.',
      remediation:
        'Run `mergesutra review` on this run first; a repair with no frozen plan would be an edit ' +
        'with no author.',
      details: { runId },
    });
  }
  return plan;
}

/**
 * One document the cycle cannot do without, named in the words a command prints.
 *
 * Each refusal names the stage that would supply the missing document, because a
 * run that reaches this command out of order is a run whose operator is missing a
 * step rather than a fact, and the four are separate steps. The Stage 4 plan and
 * the prior verification plan belong in this list for the same reason the contract
 * does: the loop takes the first for its prompt, and the re-verification is a
 * *revision* of the second — a fresh plan would hand the repaired bytes a different
 * set of `VG-` ids from the ones the review read, and the receipts would stop being
 * comparable.
 */
function need<T>(
  value: T | null | undefined,
  runId: string,
  missing: string,
  remediation: string,
): T {
  if (value === null || value === undefined) {
    throw new AppError({
      kind: 'validation',
      message: `Run '${runId}' cannot be repaired yet: it has ${missing}.`,
      remediation,
      details: { runId },
    });
  }
  return value;
}

function approvalFor(input: RepairStageInput, now: () => Date): RepairApproval | null {
  if (input.approvePlan === undefined) return null;
  // Approved now, by the act of typing the digest: this is the one place a yes is
  // authored from a flag rather than invented by the stage.
  return parseRepairApproval({ planDigest: input.approvePlan, approvedAt: now().toISOString() });
}

function approvalRow(decision: RepairApprovalDecision): RunCheck {
  return {
    name: 'Repair approval',
    status: decision.allowed ? 'INFO' : 'WARN',
    detail: decision.reason,
  };
}

function cycleRows(loop: ImplementationRecord, execution: RepairExecution): RunCheck[] {
  const { scope } = execution;
  const rows: RunCheck[] = [
    {
      name: 'Repair cycle',
      status: 'INFO',
      detail:
        `cycle ${String(scope.repairCycle)} of review ${String(scope.reviewCycle)} ran through ` +
        `Stage 6’s loop: ${String(loop.summary.steps)} turn(s), ${String(loop.summary.writes)} ` +
        `write(s), ${String(loop.summary.refusedActions)} refusal(s) — patch ` +
        `${scope.reviewedPatchIdentity.slice(0, 12)}… to ${scope.repairPatchIdentity.slice(0, 12)}…`,
    },
    {
      name: 'Repair scope',
      status: scope.outcome === 'WITHIN_PLANNED_SCOPE' ? 'INFO' : 'WARN',
      detail:
        scope.outcome === 'WITHIN_PLANNED_SCOPE'
          ? `every file this cycle moved is one the approved plan named: ${scope.files
              .filter((file) => file.delta !== 'UNCHANGED')
              .map((file) => file.path)
              .join(', ')}`
          : `${scope.outcome.toLowerCase()} — ${
              scope.unexpectedFiles.length > 0
                ? `the cycle reached ${scope.unexpectedFiles.join(', ')}, which the plan did not name`
                : 'the cycle left the patch byte-identical, so nothing it was asked to do was done'
            }. The workspace was not reverted.`,
    },
  ];
  return rows;
}

/**
 * The re-verification row, including the case where there was no round.
 *
 * A row is written either way, because "no round ran and why" is the fact a reader
 * of a repaired run looks for first, and a record that simply still held the old
 * receipts would let them miss that a cycle happened at all.
 */
function reverificationRow(
  execution: RepairExecution,
  round: WorkspaceVerification | null,
): RunCheck {
  if (!round) {
    return {
      name: 'Re-verification',
      status: 'WARN',
      detail:
        execution.scope.outcome === 'OUTSIDE_PLANNED_SCOPE'
          ? 'not run: this cycle reached outside the files the approved plan named, and evidence ' +
            'collected over an unapproved edit would ratify it'
          : 'not run: this cycle moved no bytes, so the gate rows above still describe this ' +
            'workspace and nothing here retired them',
    };
  }
  return {
    name: 'Re-verification',
    status: verdictIsPassed(round.run.result) ? 'INFO' : 'WARN',
    detail:
      `the gates ran again on ${round.plan.patchIdentity.slice(0, 12)}… at revision ` +
      `${String(round.plan.revision)} — verdict ${round.run.result}`,
  };
}

function packRow(packDir: string | null, packError: string | null): RunCheck {
  return {
    name: 'Evidence pack',
    status: packError ? 'WARN' : 'INFO',
    detail: packError
      ? `the run record was filed but its pack was not regenerated: ${packError}`
      : `report.md, report.json and commands.jsonl regenerated from this cycle's record at ${packDir}`,
  };
}

function outcomeFor(
  execution: RepairExecution,
  round: WorkspaceVerification | null,
  loop: ImplementationRecord,
): RunRecord['outcome'] {
  if (!execution.patchChanged) {
    // A loop that stopped on a bound or an outage never had the chance to write;
    // one that finished and moved nothing did have it, and that is a finding.
    return loop.termination.kind === 'FINISH' ? 'REPAIR_NEEDS_HUMAN' : 'REPAIR_BLOCKED';
  }
  if (!round) return 'REPAIR_NEEDS_HUMAN';
  return verdictIsPassed(round.run.result) ? 'REPAIR_APPLIED' : 'REPAIR_NEEDS_HUMAN';
}

function nextStageFor(
  execution: RepairExecution,
  round: WorkspaceVerification | null,
  plan: RepairPlan,
  limits: Partial<RepairLimits> | undefined,
): string {
  if (!execution.patchChanged) {
    return (
      'NEEDS_HUMAN_REVIEW — this cycle left the patch as it found it, so the finding it was ' +
      'approved for is still open and the person who read it has to decide what happens next'
    );
  }
  if (!round) {
    return (
      'NEEDS_HUMAN_REVIEW — this cycle reached outside the files its approved plan named, and the ' +
      'delta is filed rather than undone; a human reads what moved before anything re-verifies it'
    );
  }
  if (!verdictIsPassed(round.run.result)) {
    return (
      `VERIFY — the edit stands on disk and the gates did not pass over it (verdict ` +
      `${round.run.result}); the consent question, if there is one, is in the limitations above`
    );
  }
  const next = plan.reviewCycle + 1;
  const ceiling = resolveLimit('maxReviewCycles', limits?.maxReviewCycles);
  if (next > ceiling) {
    return (
      'NEEDS_HUMAN_REVIEW — this run has spent the reviews its budget allows, and the repaired ' +
      'bytes are measured but unread by any reviewer; a person decides what this patch is worth'
    );
  }
  return (
    `REVIEW — the patch on disk now has never been reviewed; run \`mergesutra review ${execution.runId}\` ` +
    `over these bytes and let a second reader weigh them again. The review in this record describes ` +
    `${execution.patchBeforeIdentity.slice(0, 12)}…, which is gone.`
  );
}

/**
 * What this cycle leaves unexplained, said in the record's own voice.
 *
 * Note the absence: no sentence here calls the old receipts stale for a cycle that
 * moved nothing, and none offers a second repair. Both would be a claim the cycle
 * did not earn — the first from a patch that did not move, the second from a
 * verdict that is a person's to make.
 */
function disclose(input: {
  execution: RepairExecution;
  round: WorkspaceVerification | null;
  runId: string;
}): string[] {
  const { execution, round, runId } = input;
  const extra: string[] = [];

  if (!execution.patchChanged) {
    extra.push(
      `REPAIR-NO-TRACE: cycle ${String(execution.repairCycle)} wrote nothing that reached the ` +
        `patch (${execution.patchAfterIdentity.slice(0, 12)}… is unchanged), so the finding it was ` +
        'approved for is still open. The refusal log inside the execution says what the loop was ' +
        'stopped from touching.',
    );
  }
  if (execution.scope.outcome === 'OUTSIDE_PLANNED_SCOPE') {
    extra.push(
      `REPAIR-OUTSIDE-SCOPE: cycle ${String(execution.repairCycle)} moved ` +
        `${execution.scope.unexpectedFiles.join(', ')}, which no approved plan named. Nothing was ` +
        'reverted or cleaned; a human reads the delta.',
    );
  }
  if (round) {
    const owed = round.run.gates.filter((gate) => gate.requiresConsent).map((gate) => gate.gateId);
    if (owed.length > 0) {
      extra.push(
        `REPAIR-VERIFY-CONSENT: the re-verification of ${round.plan.patchIdentity.slice(
          0,
          12,
        )}… left ${owed.join(', ')} unexecuted, because the execution consent on this run was ` +
          'given against a different set of commands and a stale yes does not become a new one by ' +
          `being reused. The edit was not reverted. Run \`mergesutra verify ${runId} --allow ` +
          `${owed.join(',')}\` when a person has read those commands and agrees to run them.`,
      );
    } else if (!verdictIsPassed(round.run.result)) {
      extra.push(
        `REPAIR-VERIFY-${round.run.result}: the gates ran against the repaired patch ` +
          `(${round.plan.patchIdentity.slice(0, 12)}…) and returned ${round.run.result}. The edit ` +
          'stands and the receipts say what they say; another cycle would need its own approved ' +
          'plan, not this verdict.',
      );
    }
  }
  return extra;
}

/** The newest run that has a frozen work order — the only kind a repair can execute. */
async function newestPlannedRunId(store: RunStore): Promise<string> {
  const chosen = await newestRunId(store, (record) => Boolean(record.repairPlan));
  if (chosen) return chosen;
  throw new AppError({
    kind: 'validation',
    message: 'No run in this directory has a frozen repair plan, so there is nothing to repair.',
    remediation:
      'Pass a run id explicitly, or finish `mergesutra verify` and `mergesutra review` first; a ' +
      'repair may only answer a finding a reviewer filed.',
  });
}

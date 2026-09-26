import path from 'node:path';
import { AppError } from '../core/errors.js';
import type { RunRecord } from '../state/run-record.js';
import { createRunRecord, parseRunRecord } from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import type { ExecutionConsent } from './consent.js';
import type { GateExecutionSpec, VerificationRun } from './engine.js';
import type { Runner } from '../core/runner.js';
import type { AcceptanceEvidence } from './evidence.js';
import type { VerificationPlan } from './plan.js';
import {
  IMPLEMENT_LOOP_CLAIM_SOURCE,
  loopClaim,
  verifyWorkspace,
  type WorkspaceVerification,
} from './workspace.js';

/**
 * Stage 7's wiring: from a run record to documents a resume can re-read.
 *
 * Everything this module decides, it decides from what is already on disk. It
 * asks no model anything, accepts no verdict from the loop, and adds no gate the
 * operator did not name to a consent. The round itself — measure the patch, plan
 * the gates, run what was consented to, map the evidence — lives in
 * `verifyWorkspace`, because Stage 9R has to ask the same question about repaired
 * bytes and a second implementation of it would make the two answers incomparable.
 *
 * What is left here is the part only the command does: finding the run it was
 * given, refusing one that has not contracted or implemented, resolving the
 * workspace that run's own loop record names, and filing what the round produced
 * back into the record a later stage will load.
 */

export interface VerifyStageInput {
  readonly runId?: string;
  /** Where the primary checkout is; defaults to the run's recorded toplevel. */
  readonly repo?: string;
  /** Gate ids the operator consents to run this repository's commands for. */
  readonly allow?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface VerifyStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly runFor?: (spec: GateExecutionSpec) => Runner;
}

export interface VerifyStageResult {
  readonly record: RunRecord;
  readonly plan: VerificationPlan;
  readonly run: VerificationRun;
  readonly evidence: AcceptanceEvidence;
  readonly consent: ExecutionConsent | null;
  readonly workspace: string;
  readonly recordFile: string | null;
  readonly saveError: string | null;
}

export async function runVerifyStage(
  input: VerifyStageInput = {},
  deps: VerifyStageDeps = {},
): Promise<VerifyStageResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const now = deps.now ?? (() => new Date());

  const sourceRunId = input.runId ?? (await newestImplementedRunId(store));
  const source = parseRunRecord(await store.load(sourceRunId));
  const contract = source.acceptanceContract;
  if (!contract) {
    throw new AppError({
      kind: 'validation',
      message: `Run '${sourceRunId}' has no Acceptance Contract, so there is nothing for verification to be evidence about.`,
      remediation: 'Run `mergesutra contract` on this run first.',
    });
  }
  const implementation = source.implementation;
  if (!implementation) {
    throw new AppError({
      kind: 'validation',
      message: `Run '${sourceRunId}' has not implemented anything yet, so there is no workspace and no patch to verify.`,
      remediation:
        'Run `mergesutra implement` on this run first; verify judges bytes, not intentions.',
    });
  }

  const primaryRoot = path.resolve(input.repo ?? source.local?.toplevel ?? cwd);
  const workspace = path.resolve(primaryRoot, implementation.workspace.relativePath);
  const round: WorkspaceVerification = await verifyWorkspace(
    {
      runId: sourceRunId,
      workspace,
      baseSha: implementation.workspace.baseSha,
      contract,
      claims: loopClaim(IMPLEMENT_LOOP_CLAIM_SOURCE, implementation.finishClaim),
      allow: input.allow,
      signal: input.signal,
    },
    { now, runFor: deps.runFor },
  );

  const record = createRunRecord({
    runId: sourceRunId,
    createdAt: source.createdAt,
    stage: 'verify',
    outcome: outcomeFor(round.run.result),
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: contract,
    plan: source.plan,
    implementation,
    verificationPlan: round.plan,
    verification: round.run,
    executionConsent: round.consent,
    evidence: round.evidence,
    /**
     * Carried, not re-derived.
     *
     * Verify's own four documents it writes fresh; what a later stage established
     * it has no way to un-establish. A review happened about some bytes, a plan was
     * frozen, a cycle ran and wrote — dropping those would leave a record showing a
     * fresh round on top of a workspace whose history has been quietly deleted, and
     * the record's whole purpose is that a reader can see what a run did.
     */
    review: source.review,
    repairPlan: source.repairPlan,
    repairExecutions: source.repairExecutions,
    checks: round.checks,
    nextStage:
      'REVIEW — a human weighs this evidence next; verification passed the gates, ' +
      'and nothing in this record calls the contribution ready',
    limitations: [...new Set([...source.limitations, ...round.plan.missingPrerequisites])],
  });

  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }

  return {
    record,
    plan: round.plan,
    run: round.run,
    evidence: round.evidence,
    consent: round.consent,
    workspace,
    recordFile,
    saveError,
  };
}

function outcomeFor(result: VerificationRun['result']): RunRecord['outcome'] {
  switch (result) {
    case 'PASS':
      return 'VERIFICATION_PASS';
    case 'FAIL':
      return 'VERIFICATION_FAIL';
    case 'BLOCKED':
      return 'VERIFICATION_BLOCKED';
    case 'CANCELLED':
      return 'VERIFICATION_CANCELLED';
    case 'INCONCLUSIVE':
      return 'VERIFICATION_INCONCLUSIVE';
  }
}

async function newestImplementedRunId(store: RunStore): Promise<string> {
  const { runs } = await store.list();
  for (const summary of runs) {
    const record = await store.load(summary.runId);
    if (record.implementation) return summary.runId;
  }
  throw new AppError({
    kind: 'validation',
    message: 'No run in this directory has implemented anything yet.',
    remediation:
      'Pass a run id explicitly, or finish `mergesutra issue`, `inspect`, `contract` and `implement` first.',
  });
}

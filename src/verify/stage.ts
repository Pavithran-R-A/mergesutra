import path from 'node:path';
import { openRepoReader } from '../discovery/repo-fs.js';
import { detectManifests } from '../discovery/manifests.js';
import type { Runner } from '../core/runner.js';
import { AppError } from '../core/errors.js';
import type { RunCheck, RunRecord } from '../state/run-record.js';
import { createRunRecord, parseRunRecord } from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { parseExecutionConsent, scopeDigest, type ExecutionConsent } from './consent.js';
import { runVerification, type GateExecutionSpec, type VerificationRun } from './engine.js';
import { mapAcceptanceEvidence, type AcceptanceEvidence, type ModelClaim } from './evidence.js';
import { discoverGates } from './gates.js';
import { describePatch } from './patch.js';
import { buildVerificationPlan, type VerificationPlan } from './plan.js';

/**
 * Stage 7's wiring: from a run record to documents a resume can re-read.
 *
 * Everything this module decides, it decides from what is already on disk. It
 * asks no model anything, accepts no verdict from the loop, and adds no gate
 * the operator did not name to a consent. Its one creative act is the built-in
 * whitespace check, declared as MergeSutra's own in the plan's provenance.
 *
 * The plan is built against the patch that is *actually* in the workspace, at
 * the moment verify runs. A plan built from a remembered identity would either
 * consent to bytes nobody is looking at or block on bytes that moved on; this
 * way the receipts and the consent describe the same diff.
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
  const baseSha = implementation.workspace.baseSha;
  const patch = await describePatch({ workspace, baseSha });

  const reader = await openRepoReader(workspace);
  const manifests = await detectManifests(reader);
  const discovered = await discoverGates({
    reader,
    criteria: contract.criteria.map(({ id, verificationPlan }) => ({ id, verificationPlan })),
    manifests,
  });
  const plan = buildVerificationPlan({
    runId: sourceRunId,
    baseSha,
    patchIdentity: patch.identity,
    discovered,
    additional: [
      {
        name: 'diff-check',
        argv: ['git', 'diff', '--check'],
        reason: 'a patch that introduces trailing whitespace or conflict markers is not finished',
      },
    ],
    now,
  });

  const consent = consentFrom(input.allow, plan, now);
  const run = await runVerification(
    { plan, workspace, consent: consent ?? undefined, signal: input.signal },
    { now, runFor: deps.runFor },
  );

  const current = await describePatch({ workspace, baseSha })
    .then((again) => again.identity)
    .catch(() => null);
  const evidence = mapAcceptanceEvidence({
    criteria: contract.criteria,
    plan,
    run,
    currentPatchIdentity: current ?? undefined,
    claims: claimsFrom(implementation.finishClaim),
  });

  const checks = describeVerification(plan, run, consent, evidence);
  const record = createRunRecord({
    runId: sourceRunId,
    createdAt: source.createdAt,
    stage: 'verify',
    outcome: outcomeFor(run.result),
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: contract,
    plan: source.plan,
    implementation,
    verificationPlan: plan,
    verification: run,
    executionConsent: consent,
    evidence,
    checks,
    nextStage:
      'REVIEW — a human weighs this evidence next; verification passed the gates, ' +
      'and nothing in this record calls the contribution ready',
    limitations: [...new Set([...source.limitations, ...plan.missingPrerequisites])],
  });

  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
  }

  return { record, plan, run, evidence, consent, workspace, recordFile, saveError };
}

/**
 * The operator's flag, turned into the capability the engine checks.
 *
 * An empty or absent list is not a wildcard: it is no consent, and every
 * repository-sourced gate says so in its receipt. A malformed id fails here,
 * before a single process starts, because `--allow all` must not become a
 * `--yes` by accident.
 */
function consentFrom(
  allow: readonly string[] | undefined,
  plan: VerificationPlan,
  now: () => Date,
): ExecutionConsent | null {
  if (!allow || allow.length === 0) return null;
  return parseExecutionConsent({
    planDigest: scopeDigest(plan),
    gateIds: [...allow],
    grantedAt: now().toISOString(),
  });
}

function claimsFrom(
  finishClaim: { summary: string; criteriaBelievedComplete: readonly string[] } | null,
): ModelClaim[] {
  if (!finishClaim) return [];
  return [
    {
      source: "implement loop — the model's FINISH action (a claim; nothing below read it)",
      text: `${finishClaim.summary} Believed complete: ${finishClaim.criteriaBelievedComplete.join(', ') || 'nothing named'}.`,
    },
  ];
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

/** What happened, as stage checks — statuses of MergeSutra's own doing, never of the issue. */
function describeVerification(
  plan: VerificationPlan,
  run: VerificationRun,
  consent: ExecutionConsent | null,
  evidence: AcceptanceEvidence,
): RunCheck[] {
  const executed = run.gates.filter((gate) => gate.receipt.termination !== 'NOT_EXECUTED').length;
  const passed = run.gates.filter((gate) => gate.receipt.result === 'PASS').length;
  const verified = evidence.criteria.filter((entry) => entry.status === 'PASS').length;
  return [
    {
      name: 'Verification plan',
      status: 'PASS',
      detail: `${plan.gates.length} gates at revision ${plan.revision}, bound to patch ${plan.patchIdentity.slice(0, 12)}`,
    },
    {
      name: 'Execution consent',
      status: consent ? 'PASS' : 'WARN',
      detail: consent
        ? `${consent.gateIds.length} repository gate(s) named by the operator: ${consent.gateIds.join(', ')}`
        : 'no gate ids were named — repository commands stay unexecuted, and the record says so',
    },
    {
      name: 'Verification run',
      status: run.result === 'PASS' ? 'PASS' : run.result === 'FAIL' ? 'FAIL' : 'WARN',
      detail: `${executed}/${run.gates.length} gates executed, ${passed} passed — verdict ${run.result}`,
    },
    {
      name: 'Acceptance evidence',
      status: 'INFO',
      detail: `${verified}/${evidence.criteria.length} criteria carry enough receipts to be called PASS; the rest keep their own status`,
    },
  ];
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

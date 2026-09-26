import type { AcceptanceContract } from '../contract/schema.js';
import type { Runner } from '../core/runner.js';
import { detectManifests } from '../discovery/manifests.js';
import { openRepoReader } from '../discovery/repo-fs.js';
import type { RunCheck } from '../state/run-record.js';
import { parseExecutionConsent, scopeDigest, type ExecutionConsent } from './consent.js';
import { runVerification, type GateExecutionSpec, type VerificationRun } from './engine.js';
import { mapAcceptanceEvidence, type AcceptanceEvidence, type ModelClaim } from './evidence.js';
import { discoverGates, type GateProvenance } from './gates.js';
import { describePatch, type PatchDescription } from './patch.js';
import {
  buildVerificationPlan,
  reviseVerificationPlan,
  type AdditionalGateSpec,
  type VerificationPlan,
} from './plan.js';

/**
 * One verification round: a workspace in, receipts and evidence out.
 *
 * This is Stage 7's judgement, taken out of the command that prints it, so that a
 * second caller can ask the same question about different bytes. It has to be one
 * implementation and not two: if a re-verification after a repair measured the
 * patch a little differently, or re-derived its gate ids, or consented on other
 * terms, then a `PASS` from the second round would be a different word from a
 * `PASS` from the first, and the whole point of re-verifying — being able to
 * compare the two — would be gone.
 *
 * Three things are fixed here and none of them is negotiable by a caller. A plan
 * is built from what discovery reads in this workspace at this moment, never from
 * a remembered one. Repository commands run only under a consent naming their ids
 * for this plan's digest. The evidence mapper sees the receipts of this round and
 * the patch that is here when the last gate finishes, so a criterion can never be
 * carried by a receipt written for bytes that have since moved.
 *
 * What it does not do is write anything down. It holds no run record, no store and
 * no file handle beyond the read-only repository reader discovery needs: a round is
 * an answer, and filing an answer is the caller's job. That is also why a repair
 * cycle can run this twice without a workspace changing between the two — measuring
 * is not editing, and this module has no way to confuse them.
 */

/** MergeSutra's own check, declared here so both rounds get the same one. */
const BUILT_IN_GATES: readonly AdditionalGateSpec[] = [
  {
    name: 'diff-check',
    argv: ['git', 'diff', '--check'],
    reason: 'a patch that introduces trailing whitespace or conflict markers is not finished',
  },
];

/**
 * Who says a round re-read the repository.
 *
 * A revision names its evidence, and for a round over a moved patch the evidence
 * is MergeSutra's own decision to measure again — not a CI file, which may not
 * have changed at all. Attributing it to the repository would be a provenance lie.
 */
const REPLAN_SOURCE: GateProvenance = {
  source: 'MERGESUTRA_BUILTIN',
  file: null,
  detail: 'MergeSutra re-read the repository for a patch that has moved',
  line: null,
};

/** How a loop's own account of finishing is filed: a claim, attributed, deciding nothing. */
export const IMPLEMENT_LOOP_CLAIM_SOURCE =
  "implement loop — the model's FINISH action (a claim; nothing below read it)";

export interface FinishClaim {
  readonly summary: string;
  readonly criteriaBelievedComplete: readonly string[];
}

export function loopClaim(source: string, finishClaim: FinishClaim | null): ModelClaim[] {
  if (!finishClaim) return [];
  return [
    {
      source,
      text: `${finishClaim.summary} Believed complete: ${
        finishClaim.criteriaBelievedComplete.join(', ') || 'nothing named'
      }.`,
    },
  ];
}

export interface VerifyWorkspaceInput {
  readonly runId: string;
  /** The workspace to measure and run gates in. It is never written to. */
  readonly workspace: string;
  readonly baseSha: string;
  /** The obligations this round is evidence about. */
  readonly contract: AcceptanceContract;
  /** Claims filed beside the receipts. Nothing that decides a status reads them. */
  readonly claims?: readonly ModelClaim[];
  /** Gate ids the operator consents to run this repository's commands for. */
  readonly allow?: readonly string[];
  readonly signal?: AbortSignal;
  /**
   * The plan this round revises, when the run has been verified before.
   *
   * Passing one is what keeps `VG-002` pointing at the same command across two
   * rounds; leaving it out writes a revision 1 plan, which is a different claim.
   */
  readonly previous?: { readonly plan: VerificationPlan; readonly reason: string };
}

export interface VerifyWorkspaceDeps {
  readonly now?: () => Date;
  readonly runFor?: (spec: GateExecutionSpec) => Runner;
  /**
   * What the workspace holds once the gates have finished. A test seam; the
   * default measures the same way the round's first measurement did.
   */
  readonly currentPatchIdentity?: () => Promise<string | null>;
}

export interface WorkspaceVerification {
  /** The bytes this round was about. */
  readonly patch: PatchDescription;
  readonly plan: VerificationPlan;
  readonly consent: ExecutionConsent | null;
  readonly run: VerificationRun;
  readonly evidence: AcceptanceEvidence;
  /** What happened, as stage checks — statuses of MergeSutra's own doing, never of the issue. */
  readonly checks: readonly RunCheck[];
}

export async function verifyWorkspace(
  input: VerifyWorkspaceInput,
  deps: VerifyWorkspaceDeps = {},
): Promise<WorkspaceVerification> {
  const now = deps.now ?? (() => new Date());
  const patch = await describePatch({ workspace: input.workspace, baseSha: input.baseSha });

  const reader = await openRepoReader(input.workspace);
  const manifests = await detectManifests(reader);
  const discovered = await discoverGates({
    reader,
    criteria: input.contract.criteria.map(({ id, verificationPlan }) => ({
      id,
      verificationPlan,
    })),
    manifests,
  });
  const plan = input.previous
    ? reviseVerificationPlan(input.previous.plan, {
        discovered,
        additional: BUILT_IN_GATES,
        reason: input.previous.reason,
        source: REPLAN_SOURCE,
        patchIdentity: patch.identity,
        now,
      })
    : buildVerificationPlan({
        runId: input.runId,
        baseSha: input.baseSha,
        patchIdentity: patch.identity,
        discovered,
        additional: BUILT_IN_GATES,
        now,
      });

  const consent = consentFrom(input.allow, plan, now);
  const run = await runVerification(
    { plan, workspace: input.workspace, consent: consent ?? undefined, signal: input.signal },
    { now, runFor: deps.runFor },
  );

  const current = await (
    deps.currentPatchIdentity ??
    (() =>
      describePatch({ workspace: input.workspace, baseSha: input.baseSha })
        .then((again) => again.identity)
        .catch(() => null))
  )();
  const evidence = mapAcceptanceEvidence({
    criteria: input.contract.criteria,
    plan,
    run,
    currentPatchIdentity: current ?? undefined,
    claims: input.claims ?? [],
  });

  return { patch, plan, consent, run, evidence, checks: describeRun(plan, run, consent, evidence) };
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

function describeRun(
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

import path from 'node:path';
import {
  createBharatCodeClient,
  requireApiKey,
  type BharatCodeClient,
} from '../bharatcode/client.js';
import { loadBharatCodeConfig } from '../config/load-config.js';
import { AppError } from '../core/errors.js';
import type { AcceptanceContract } from '../contract/schema.js';
import { prepareWorkspace, type PreparedWorkspace } from '../git/workspace.js';
import type { Runner } from '../core/runner.js';
import type { ImplementationPlan } from '../plan/schema.js';
import {
  createRunRecord,
  type RunCheck,
  type RunOutcome,
  type RunRecord,
} from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { newestRunId } from '../state/run-selection.js';
import { runImplementationLoop } from './loop.js';
import type { LoopLimits } from './limits.js';
import type { ImplementationRecord, LoopStatus } from './state.js';

/**
 * The Stage 6 stage: from a stored plan to files in a workspace.
 *
 * This module owns the sequence, and nothing else does. `loop.ts` cannot create a
 * worktree, `workspace.ts` cannot ask a model anything, and `run-record.ts` cannot
 * run a command — so "did the implementation loop get to pick its own workspace?"
 * has one answer, in one file.
 *
 * The order is not arbitrary:
 *
 * 1. a run must already have a contract and a plan, or the network is not touched;
 * 2. the workspace is prepared at the run's recorded base commit, and refused if
 *    it would leave untracked files in the human's checkout;
 * 3. only then does the loop start, rooted in that workspace;
 * 4. the record is written back under the *same* run id, so a bounded or
 *    cancelled loop is resumable and its worktree is still the one it wrote.
 *
 * A run is advanced in place here rather than forked into a new id the way Stage 4
 * does, because a workspace has a name and the name is the run id. Two ids would
 * mean two worktrees for one piece of work.
 */

export interface ImplementStageInput {
  readonly runId?: string;
  /** Where the repository is; defaults to the run's recorded local toplevel. */
  readonly repo?: string;
  readonly limits?: Partial<LoopLimits>;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface ImplementStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly client?: BharatCodeClient;
  readonly run?: Runner;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ImplementStageResult {
  readonly record: RunRecord;
  readonly implementation: ImplementationRecord;
  readonly workspace: PreparedWorkspace;
  readonly recordFile: string | null;
  readonly saveError: string | null;
  readonly checks: readonly RunCheck[];
}

/** Which run outcome each loop status earns. Nothing here says the issue is fixed. */
function outcomeFor(status: LoopStatus): RunOutcome {
  switch (status) {
    case 'COMPLETED_BY_MODEL':
      return 'IMPLEMENTED_BY_MODEL';
    case 'BLOCKED':
    case 'CANCELLED':
      return 'IMPLEMENTATION_BLOCKED';
    case 'INCONCLUSIVE':
      return 'IMPLEMENTATION_INCONCLUSIVE';
    case 'NEEDS_HUMAN_REVIEW':
      return 'IMPLEMENTATION_NEEDS_REVIEW';
  }
}

export async function runImplementStage(
  input: ImplementStageInput = {},
  deps: ImplementStageDeps = {},
): Promise<ImplementStageResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const now = deps.now ?? (() => new Date());

  const sourceRunId = input.runId ?? (await newestPlannedRunId(store));
  const source = await store.load(sourceRunId);
  const contract = requireContract(source, sourceRunId);
  const plan = requirePlan(source, sourceRunId);
  const baseSha = requireBaseSha(source, sourceRunId);
  const client = deps.client ?? clientFromEnvironment(deps.env ?? process.env);

  const primaryRoot = path.resolve(input.repo ?? source.local?.toplevel ?? cwd);
  const workspace = await prepareWorkspace(
    { primaryRoot, runId: sourceRunId, baseSha },
    deps.run ? { run: deps.run } : {},
  );

  const implementation = await runImplementationLoop(
    {
      runId: sourceRunId,
      record: source,
      contract,
      plan,
      workspaceRoot: workspace.path,
      workspace: {
        relativePath: workspace.relativePath,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
        reused: workspace.reused,
        primaryDirty: workspace.primaryDirty,
      },
      limits: input.limits,
      model: input.model,
    },
    { client, now, signal: input.signal, run: deps.run },
  );

  const checks = describeRun(implementation, workspace, contract);
  const record = createRunRecord({
    // The run advances in place: the workspace, the record and the implementation
    // all carry this one id, so a later stage can tell which files belong to it.
    runId: sourceRunId,
    createdAt: source.createdAt,
    stage: 'implement',
    outcome: outcomeFor(implementation.status),
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: contract,
    plan,
    implementation,
    // Carried, unlike the verification and the review this run supersedes: a cycle
    // is a dated fact about what was already edited under approval, not a claim
    // about the bytes now on disk. Dropping it would make a run that has been
    // repaired read as one that never was.
    repairExecutions: source.repairExecutions,
    checks,
    nextStage: nextStageFor(implementation.status),
    limitations: [
      ...new Set([...source.limitations, ...contract.limitations, ...implementation.limitations]),
    ],
  });

  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
    checks.push({ name: 'Run record', status: 'WARN', detail: `not written — ${saveError}` });
  }

  return { record, implementation, workspace, recordFile, saveError, checks };
}

function nextStageFor(status: LoopStatus): string {
  if (status === 'COMPLETED_BY_MODEL') {
    return 'VERIFY — the model says it is done; run `mergesutra verify`, whose gates do not read this record';
  }
  return 'IMPLEMENT — re-run `mergesutra implement` on this run, or read its limitations first';
}

/**
 * The run's own account of what happened, in the statuses the product spec
 * allows. Note what is absent: no criterion is `PASS`, because nothing here
 * checked one, and `Verification` says so rather than being left out.
 */
function describeRun(
  implementation: ImplementationRecord,
  workspace: PreparedWorkspace,
  contract: AcceptanceContract,
): RunCheck[] {
  const checks: RunCheck[] = [
    {
      name: 'Workspace',
      status: 'PASS',
      detail: `${workspace.relativePath} at ${workspace.baseSha.slice(0, 12)} on ${workspace.branch}${workspace.reused ? ' (reused)' : ''}`,
    },
    {
      name: 'Acceptance Contract',
      status: 'PASS',
      detail: `${contract.criteria.length} criterion(criteria) unchanged (v${contract.version}); ${implementation.contractUntouched ? 'no revision was applied' : 'a revision was applied'}`,
    },
    {
      name: 'BharatCode',
      status: 'INFO',
      detail: `model ${implementation.model}, ${implementation.summary.steps} turn(s), ${implementation.summary.modelRequests} request(s)`,
    },
    {
      name: 'Writes',
      status: implementation.summary.writes > 0 ? 'INFO' : 'SKIP',
      detail:
        implementation.summary.writes > 0
          ? `${implementation.summary.writes} file(s), ${implementation.summary.totalBytesWritten} byte(s), all inside the workspace`
          : 'no file was written by this loop',
    },
    {
      name: 'Checks',
      status: implementation.summary.commands > 0 ? 'INFO' : 'SKIP',
      detail:
        implementation.summary.commands > 0
          ? `${implementation.summary.commands} developer command(s) run as argv inside the workspace`
          : 'no command was run by this loop',
    },
    {
      name: 'Refused actions',
      status: implementation.summary.refusedActions > 0 ? 'WARN' : 'PASS',
      detail:
        implementation.summary.refusedActions > 0
          ? `${implementation.summary.refusedActions} action(s) refused by the tool policy, the write boundary or the bounds`
          : 'nothing the model asked for was refused',
    },
  ];

  if (implementation.summary.rejectedAnswers > 0) {
    // The requests are paid for and no action row exists for them, so the
    // screen has to say where they went. The rejected text itself is not here.
    checks.push({
      name: 'Rejected answers',
      status: 'WARN',
      detail:
        `${implementation.summary.rejectedAnswers} answer(s) the model sent that nothing could ` +
        'run from; each cost a request and none appears as an action',
    });
  }
  if (implementation.proposedRevisions.length > 0) {
    checks.push({
      name: 'Proposed revisions',
      status: 'WARN',
      detail: `${implementation.proposedRevisions.length} MODEL CLAIM(s) recorded; the contract was not edited`,
    });
  }
  if (workspace.primaryDirty) {
    checks.push({
      name: 'Primary checkout',
      status: 'WARN',
      detail: 'dirty before this run started; reported, not repaired',
    });
  }
  checks.push({
    name: 'Model claim',
    status: implementation.finishClaim ? 'WARN' : 'NOT_AVAILABLE',
    detail: implementation.finishClaim
      ? `FINISH named ${implementation.finishClaim.criteriaBelievedComplete.length} criterion(s); a claim, not a verdict`
      : 'the loop never claimed to be finished',
  });
  checks.push({
    name: 'Verification',
    status: 'NOT_AVAILABLE',
    detail: 'Stage 6 runs developer checks only; no criterion was verified against its contract',
  });
  checks.push({
    name: 'Remote mutation',
    status: 'NOT_AVAILABLE',
    detail: 'no push, pull request, comment or GitHub write was attempted',
  });
  checks.push({
    name: 'Loop end',
    status: implementation.status === 'COMPLETED_BY_MODEL' ? 'INFO' : 'WARN',
    detail: `${implementation.status} (${implementation.termination.kind}): ${implementation.termination.detail}`,
  });
  return checks;
}

/**
 * The real client, built the way the product is shipped to be used.
 *
 * The credential is required *here*, before a workspace exists, because a
 * machine with no `BHARATCODE_API_KEY` cannot run this stage at all. Left to the
 * loop, the same mistake would arrive as a request that failed — and the run
 * would have created a worktree, written a record, and reported an
 * `INCONCLUSIVE` implementation when the truthful answer is a configuration
 * refusal with exit 78.
 */
function clientFromEnvironment(env: NodeJS.ProcessEnv): BharatCodeClient {
  const config = loadBharatCodeConfig(env);
  requireApiKey(config.apiKey);
  return createBharatCodeClient({ config });
}

function requireContract(record: RunRecord, runId: string): AcceptanceContract {
  if (!record.acceptanceContract) {
    throw new AppError({
      kind: 'validation',
      message: `Run ${runId} has no Acceptance Contract, so there is nothing to implement against.`,
      remediation: 'Run `mergesutra contract` on this run first.',
    });
  }
  return record.acceptanceContract;
}

function requirePlan(record: RunRecord, runId: string): ImplementationPlan {
  if (!record.plan) {
    throw new AppError({
      kind: 'validation',
      message: `Run ${runId} has no implementation plan.`,
      remediation: 'Run `mergesutra plan` on this run first.',
    });
  }
  return record.plan;
}

function requireBaseSha(record: RunRecord, runId: string): string {
  const sha = record.base?.sha;
  if (!sha) {
    throw new AppError({
      kind: 'validation',
      message: `Run ${runId} never recorded a base commit, so no workspace can be pinned to one.`,
      remediation:
        'Run `mergesutra issue`, or `mergesutra inspect` on the clone, so a base commit is recorded.',
    });
  }
  return sha;
}

async function newestPlannedRunId(store: RunStore): Promise<string> {
  const chosen = await newestRunId(store, (record) =>
    Boolean(record.plan && record.acceptanceContract),
  );
  if (chosen) return chosen;
  const { unreadable } = await store.list();
  throw new AppError({
    kind: 'validation',
    message:
      unreadable.length > 0
        ? 'No run record could be trusted, so there is no plan to implement.'
        : 'No run has a plan and a contract yet.',
    remediation: 'Run `mergesutra issue`, then `mergesutra contract`, then `mergesutra plan`.',
  });
}

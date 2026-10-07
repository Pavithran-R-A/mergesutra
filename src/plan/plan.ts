import { AppError } from '../core/errors.js';
import { createBharatCodeClient, safeJsonParse } from '../bharatcode/client.js';
import type { BharatCodeClient } from '../bharatcode/client.js';
import type { ChatMessage } from '../bharatcode/types.js';
import { loadBharatCodeConfig } from '../config/load-config.js';
import { defaultRedactor } from '../security/redaction.js';
import { createRunRecord, newRunId, type RunCheck, type RunRecord } from '../state/run-record.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { newestRunId } from '../state/run-selection.js';
import { buildPlanMessages, withRepairFeedback } from './prompt.js';
import {
  assertPlanCoverage,
  parsePlanBody,
  type ImplementationPlan,
  type PlanBody,
  unknownCriterionIds,
} from './schema.js';
import { ZodError } from 'zod';

const PLAN_MAX_TOKENS = 4096;

/**
 * The planner — Stage 4, the first stage that asks a model anything.
 *
 * The contract came from files; the plan comes from a model, and that changes
 * what may be believed. So this module is mostly refusals:
 *
 * - the answer must parse as JSON and match `planBodySchema` exactly;
 * - every criterion id it names must exist in the contract, and every criterion
 *   must be named — a plan that quietly narrows the obligations is rejected;
 * - the answer text may not carry its own provenance: `planBodySchema` refuses a body that
 *   names a model, a timestamp or a contract, and MergeSutra fills those from the response
 *   envelope. The envelope's model name is what the gateway reported about itself — kept as a
 *   quotation, because nothing in this build decides anything by reading it.
 *
 * It holds no process runner, by design: a plan stage that could execute a
 * command could execute the command the model just proposed.
 */

export interface PlanDeps {
  store: RunStore;
  /** Where `.mergesutra/runs` is found when no store is injected. */
  cwd: string;
  now: () => Date;
  random: () => number;
  /** Injected in tests and by `--json` callers; built from the environment otherwise. */
  client?: BharatCodeClient;
  env?: NodeJS.ProcessEnv;
  /** Schema failures fed back to the model. More than one is cost with no gain. */
  maxRepairAttempts?: number;
}

export interface PlanResult {
  readonly record: RunRecord;
  readonly plan: ImplementationPlan | null;
  readonly sourceRunId: string;
  readonly recordFile: string | null;
  readonly saveError: string | null;
  readonly checks: readonly RunCheck[];
}

export async function runPlanStage(
  input: { runId?: string },
  deps: Partial<PlanDeps> = {},
): Promise<PlanResult> {
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(deps.cwd ?? process.cwd()));
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const maxRepair = deps.maxRepairAttempts ?? 1;
  const client =
    deps.client ??
    createBharatCodeClient({ config: loadBharatCodeConfig(deps.env ?? process.env) });

  const sourceRunId = input.runId ?? (await newestContractRunId(store));
  const source = await store.load(sourceRunId);
  const contract = source.acceptanceContract;

  const checks: RunCheck[] = [
    {
      name: 'Source run',
      status: 'PASS',
      detail: `${sourceRunId} (${source.stage}, ${source.outcome})`,
    },
  ];

  if (!contract) {
    // Asking a model without obligations is how an agent talks itself into
    // solving something nobody asked for. Refuse before the network is touched.
    throw new AppError({
      kind: 'validation',
      message: `Run ${sourceRunId} has no Acceptance Contract, so there is nothing to plan against.`,
      remediation: 'Run `mergesutra contract` on this run first.',
    });
  }
  checks.push({
    name: 'Acceptance Contract',
    status: 'PASS',
    detail: `${contract.criteria.length} criteria (v${contract.version})`,
  });

  const criterionIds = contract.criteria.map((criterion) => criterion.id);
  // Stage 1 keeps the issue body verbatim because it hashes what it read. That
  // text is also about to leave this machine, so the copy that goes to the model
  // is the redacted one: a credential pasted into an issue is not the provider's
  // business, and an echo of it would come back looking like MergeSutra's own.
  const messages = defaultRedactor.deep(buildPlanMessages({ record: source, contract }));

  const requestedAt = now().toISOString();
  const attempt = await requestPlan({ client, messages, criterionIds, maxRepair });

  const limitations: string[] = [];

  // Which model answered, and how many round trips it took: a fact about the
  // run, recorded whether or not the answer was usable.
  checks.push({
    name: 'BharatCode',
    status: 'INFO',
    detail: `${attempt.model}, ${attempt.attempts} round trip(s)`,
  });

  if (!attempt.body) {
    checks.push({
      name: 'Plan schema',
      status: 'FAIL',
      detail: attempt.problem ?? 'the model answer was rejected',
    });
    limitations.push(
      `No plan was stored. ${attempt.problem ?? 'The model answer did not satisfy the plan schema.'}`,
    );
  } else {
    checks.push({
      name: 'Plan schema',
      status: 'PASS',
      detail: `matched in ${attempt.attempts} round trip(s)`,
    });
    checks.push({
      name: 'Plan coverage',
      status: 'PASS',
      detail: `all ${criterionIds.length} criteria accounted for`,
    });
    if (attempt.body.criteriaUnaddressed.length > 0) {
      const deferred = attempt.body.criteriaUnaddressed.map((entry) => entry.id).join(', ');
      checks.push({ name: 'Criteria deferred', status: 'WARN', detail: deferred });
      limitations.push(
        `The plan declares ${deferred} unaddressed. A plan that names a gap is honest; a run that stops at a plan is not complete.`,
      );
    }
    if (attempt.body.proposedCriteria.length > 0) {
      checks.push({
        name: 'Proposed criteria',
        status: 'WARN',
        detail: `${attempt.body.proposedCriteria.length} MODEL CLAIM(s), not requirements`,
      });
      limitations.push(
        'Proposed criteria stay inside the plan until a human adds them with `mergesutra contract --criterion`; the model cannot write requirements.',
      );
    }
  }

  checks.push({
    name: 'Execution',
    status: 'NOT_AVAILABLE',
    detail: 'planning runs nothing; any argv above is a proposal',
  });
  checks.push({
    name: 'Verification',
    status: 'NOT_AVAILABLE',
    detail: 'no criterion changed status when a plan was written',
  });

  const plan = attempt.body
    ? defaultRedactor.deep<ImplementationPlan>({
        schemaVersion: 1,
        runId: newRunId(now(), random),
        body: attempt.body,
        provenance: {
          model: attempt.model,
          source: 'bharatcode',
          requestedAt,
          contractRunId: contract.runId,
          contractVersion: contract.version,
          attempts: attempt.attempts,
          promptTokens: attempt.promptTokens,
          completionTokens: attempt.completionTokens,
        },
        limitations,
        untrusted: true,
      })
    : null;

  const record = createRunRecord({
    runId: plan?.runId ?? newRunId(now(), random),
    createdAt: now().toISOString(),
    stage: 'plan',
    outcome: plan ? 'PLAN_COMPLETE' : 'INCONCLUSIVE',
    issueRef: source.issueRef,
    issue: source.issue,
    repository: source.repository,
    base: source.base,
    local: source.local,
    contract: source.contract,
    acceptanceContract: contract,
    plan,
    checks,
    nextStage: plan
      ? "IMPLEMENT — `mergesutra implement` runs the bounded loop in this run's own workspace; nothing is verified there"
      : 'PLAN — retry `mergesutra plan`',
    limitations: [...new Set([...source.limitations, ...limitations, ...contract.limitations])],
  });

  return persist(record, plan, sourceRunId, checks, store);
}

interface PlanAttempt {
  readonly body: PlanBody | null;
  readonly problem?: string;
  readonly attempts: number;
  /** Copied from the response envelope: what the gateway reported answering. */
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * Ask, validate, and — at most `maxRepair` times — ask again with the refusal
 * quoted back. The feedback carries the schema problem only, never the raw
 * model text, because the raw text is what failed to be trustworthy.
 */
async function requestPlan(input: {
  client: BharatCodeClient;
  messages: readonly ChatMessage[];
  criterionIds: readonly string[];
  maxRepair: number;
}): Promise<PlanAttempt> {
  const { client, criterionIds } = input;
  let messages = [...input.messages];
  let model = 'unknown';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;

  for (let attempt = 1; attempt <= input.maxRepair + 1; attempt += 1) {
    const completion = await client.complete({
      messages,
      temperature: 0,
      maxTokens: PLAN_MAX_TOKENS,
    });
    model = completion.model;
    promptTokens = completion.usage?.promptTokens ?? null;
    completionTokens = completion.usage?.completionTokens ?? null;

    let body: PlanBody | null = null;
    let problem: string | undefined;
    try {
      body = parsePlanBody(safeJsonParse(completion.text));
    } catch (error) {
      problem = `the answer did not match the plan schema: ${reasonOf(error)}`;
    }

    if (body) {
      const unknown = unknownCriterionIds(body, criterionIds);
      if (unknown.length > 0) {
        problem = `the answer named criteria the contract never issued: ${unknown.join(', ')}`;
        body = null;
      } else {
        try {
          assertPlanCoverage(body, criterionIds);
        } catch (error) {
          problem = error instanceof AppError ? error.message : reasonOf(error);
          body = null;
        }
      }
    }

    if (body) return { body, attempts: attempt, model, promptTokens, completionTokens };

    if (attempt > input.maxRepair) {
      return { body: null, problem, attempts: attempt, model, promptTokens, completionTokens };
    }
    messages = withRepairFeedback(messages, problem ?? 'the answer was rejected');
  }

  // Every branch above returns; reached only if maxRepair is negative.
  return {
    body: null,
    problem: 'no attempt was made',
    attempts: 0,
    model,
    promptTokens,
    completionTokens,
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
      .join('; ');
  }
  return defaultRedactor.text(error instanceof Error ? error.message : String(error));
}

async function newestContractRunId(store: RunStore): Promise<string> {
  const chosen = await newestRunId(store, (record) => Boolean(record.acceptanceContract));
  if (chosen) return chosen;
  const { unreadable } = await store.list();
  throw new AppError({
    kind: 'validation',
    message:
      unreadable.length > 0
        ? 'No run record could be trusted, so there is no contract to plan against.'
        : 'No run has an Acceptance Contract yet.',
    remediation: 'Run `mergesutra issue <url>`, then `mergesutra contract`.',
  });
}

async function persist(
  record: RunRecord,
  plan: ImplementationPlan | null,
  sourceRunId: string,
  checks: RunCheck[],
  store: RunStore,
): Promise<PlanResult> {
  let recordFile: string | null = null;
  let saveError: string | null = null;
  try {
    recordFile = await store.save(record);
  } catch (error) {
    saveError = error instanceof Error ? error.message : String(error);
    checks.push({ name: 'Run record', status: 'WARN', detail: `not written — ${saveError}` });
  }
  return { record, plan, sourceRunId, recordFile, saveError, checks };
}

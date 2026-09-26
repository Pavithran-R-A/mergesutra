import { PRODUCT_NAME } from '../version.js';
import {
  createBharatCodeClient,
  requireApiKey,
  type BharatCodeClient,
} from '../bharatcode/client.js';
import type { StructuredRequest } from '../bharatcode/types.js';
import { loadBharatCodeConfig } from '../config/load-config.js';
import { AppError } from '../core/errors.js';
import { MAX_REPAIR_CYCLES_CEILING, MAX_REVIEW_CYCLES_CEILING } from '../repair/bounds.js';
import type { RepairExecution } from '../repair/execution.js';
import { runRepairStage, type RepairStageDeps, type RepairStageResult } from '../repair/stage.js';
import { exitForOutcome } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';

/**
 * `mergesutra repair [run-id]` — Stage 9R.
 *
 * This is the only place in the product where a person authorises an edit, so the
 * flag surface *is* the security model. One flag grants it: `--approve-plan
 * <digest>`, the digest of the plan Stage 9 froze before anything was touched,
 * typed only after that plan has been read. There is no `--yes`, no `--force`, no
 * `--approve-all` and no environment variable that stands in for the digest — a
 * repair that could be approved in advance would be approved without being read,
 * which is the failure this command exists to make impossible.
 *
 * The credential is resolved lazily, because the command has two halves with
 * different needs. Without an approval it shows the plan and stops: that reading
 * costs no request, so demanding a key for it would refuse the only half a person
 * can run before deciding. With an approval it reaches a model, and the absence of
 * a key is then a configuration refusal at exit 78 — before any byte is edited,
 * which is the point of checking here rather than mid-cycle.
 *
 * Nothing printed below calls a repaired patch good. A cycle that ran and
 * re-verified exits 3, because what the screen may claim is "the bytes moved and
 * the gates were re-run"; readiness is a later stage's word to say.
 */

export interface RepairCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  /** The 64-hex digest of the plan being approved — the only way to say yes. */
  readonly approvePlan?: string;
  readonly maxReviewCycles?: string;
  readonly maxRepairCycles?: string;
  readonly signal?: AbortSignal;
}

export async function repairAction(
  runId: string | undefined,
  options: RepairCommandOptions,
  deps: Partial<RepairStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const env = options.env ?? process.env;
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, env),
  });
  const result = await runRepairStage(
    {
      runId,
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.approvePlan ? { approvePlan: options.approvePlan } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      ...deps,
      client: deps.client ?? (options.approvePlan ? clientFromEnvironment(env) : lazyClient(env)),
      ...(options.maxReviewCycles || options.maxRepairCycles
        ? {
            limits: {
              ...(options.maxReviewCycles
                ? {
                    maxReviewCycles: cycleCount(
                      '--max-review-cycles',
                      MAX_REVIEW_CYCLES_CEILING,
                      options.maxReviewCycles,
                    ),
                  }
                : {}),
              ...(options.maxRepairCycles
                ? {
                    maxRepairCycles: cycleCount(
                      '--max-repair-cycles',
                      MAX_REPAIR_CYCLES_CEILING,
                      options.maxRepairCycles,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    },
  );

  if (options.json) {
    write(
      JSON.stringify(
        {
          runId: result.runId,
          executed: result.executed,
          decision: result.decision,
          recordFile: result.recordFile,
          packDir: result.packDir,
          packError: result.packError,
          record: result.record,
        },
        null,
        2,
      ),
    );
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — the approved repair cycle`));
  write('');
  write(formatRepair(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatRepair(result: RepairStageResult, renderer: Renderer): string {
  const { record, decision, execution, round, recordFile, packDir, packError } = result;
  const lines: string[] = [];

  // The stage's own rows, not the record's: the pack row exists only on the way
  // out, and a reader has to see the renderer's failure here rather than in a file
  // they were told about.
  for (const check of result.checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(24)}${check.detail}`);
  }
  lines.push('');

  lines.push(label('Run', record.runId));
  lines.push(label('Outcome', record.outcome));
  lines.push(label('Workspace', workspaceText(record)));
  if (execution) lines.push(label('Approved', execution.planDigest));
  lines.push(label('Patch', patchText(execution, round)));
  lines.push(
    label('Re-verified', round ? roundResult(round) : 'not owed — nothing moved to measure'),
  );
  lines.push('');

  if (!result.executed) {
    lines.push(renderer.heading('Nothing was edited'));
    const reason = decision.reason.split('\n')[0] ?? '';
    lines.push(`  ${reason}`);
    // A reader must never have to re-derive a digest to say yes. When no approval
    // exists yet the domain reason already carries the whole command; when one
    // exists for another plan it names only both digests truncated, so the line
    // that grants this one is printed here rather than left to the terminal history.
    if (decision.requiresApproval && !reason.includes(decision.expectedDigest)) {
      lines.push(
        `  to approve the plan as frozen: mergesutra repair ${record.runId} --approve-plan ${decision.expectedDigest}`,
      );
    }
    const plan = record.repairPlan;
    if (plan) {
      lines.push(
        `  plan cycle ${String(plan.repairCycle)} · ${plan.findings
          .map((item) => `${item.findingId} → ${item.expectedFiles.join(', ')}`)
          .join(' · ')}`,
      );
      lines.push(`  files it may touch: ${plan.expectedFiles.join(', ') || 'none named'}`);
      lines.push(`  checks it answers to: ${plan.expectedChecks.join(', ') || 'none named'}`);
      lines.push(
        renderer.dim(
          `  showing this costs no request; executing it does — \`mergesutra review ${record.runId}\` re-reads the bytes and freezes a plan from that reading.`,
        ),
      );
    }
    lines.push('');
  } else if (execution) {
    const loop = execution.implementation;
    lines.push(renderer.heading('The cycle, as measured'));
    lines.push(
      `  ${String(loop.actions.length)} action(s) by ${loop.model}, ended ${loop.termination.kind.toLowerCase()}`,
    );
    lines.push(
      `  bounds it ran under: ${String(loop.limits.maxSteps)} step(s), ${String(loop.limits.maxWrites)} write(s), ${String(loop.limits.maxCommands)} command(s)`,
    );
    lines.push(`  scope: ${execution.scope.outcome.toLowerCase()}`);
    for (const file of execution.scope.files) {
      if (file.delta === 'UNCHANGED') continue;
      lines.push(
        `    ${file.delta.toLowerCase()}  ${file.path}  (${file.classification.toLowerCase()})`,
      );
    }
    lines.push(
      renderer.dim(
        '  the loop’s account above is untrusted input kept for the record; every status on this screen came from a gate that ran.',
      ),
    );
    lines.push('');
  }

  if (record.limitations.length > 0) {
    lines.push(renderer.heading('What this cycle could not settle'));
    for (const limitation of record.limitations) {
      lines.push(`  - ${limitation}`);
    }
    lines.push('');
  }

  if (packError) {
    lines.push(renderer.dim(`  the pack on disk is the one from before this cycle: ${packError}`));
  } else if (packDir) {
    lines.push(label('Pack', packDir));
  }
  if (recordFile) lines.push(label('Record', recordFile));
  lines.push(label('Next', record.nextStage));
  return lines.join('\n');
}

/** Where the cycle edits, read off the record rather than a stage-only field. */
function workspaceText(record: RepairStageResult['record']): string {
  if (!record.implementation) {
    return 'nothing has been implemented on this run yet';
  }
  return `${record.local?.toplevel ?? 'a checkout this record never named'} · ${
    record.implementation.workspace.relativePath
  }`;
}

function patchText(execution: RepairExecution | null, round: RepairStageResult['round']): string {
  if (!execution) return 'unchanged — no cycle ran';
  const before = execution.patchBeforeIdentity.slice(0, 12);
  if (!execution.patchChanged) return `${before}… (the cycle left no trace)`;
  const measured = round?.plan.patchIdentity === execution.patchAfterIdentity;
  return `${before}… → ${execution.patchAfterIdentity.slice(0, 12)}…${
    measured ? ' — the round below measures these bytes' : ''
  }`;
}

function roundResult(round: NonNullable<RepairStageResult['round']>): string {
  return `${round.run.result} at revision ${String(round.plan.revision)} · ${
    round.plan.gates.length
  } gate(s) · ${round.plan.patchIdentity.slice(0, 12)}…`;
}

/**
 * The cycle's model, built only when a request is actually due.
 *
 * A repair asks a model for its account of the diff, so this is the moment the
 * command needs a credential — and `requireApiKey` is what says so, from the
 * environment, in the CLI layer and nowhere below it. Resolving it lazily is what
 * lets the unapproved half run on a machine with no key, which is the half a
 * person needs in order to decide whether to supply one.
 */
function lazyClient(env: NodeJS.ProcessEnv): BharatCodeClient {
  let built: BharatCodeClient | null = null;
  const need = (): BharatCodeClient => {
    if (!built) {
      built = clientFromEnvironment(env);
    }
    return built;
  };
  return {
    listModels: () => need().listModels(),
    complete: (request) => need().complete(request),
    completeStructured: <T>(request: StructuredRequest<T>): Promise<T> =>
      need().completeStructured(request),
    healthCheck: () => need().healthCheck(),
  };
}

/**
 * The credential, checked before the stage is entered rather than mid-cycle.
 *
 * `runImplementationLoop` turns an action that throws into a failed step and keeps
 * going, so a missing key discovered by the lazy client above would surface as a
 * repair cycle that ran, edited nothing and reported itself blocked. The honest
 * shape of "this command cannot reach a model" is a configuration refusal at exit
 * 78 with no cycle filed at all, which is only obtainable by looking before the
 * work starts — so the half of the command that carries an approval pays the check
 * up front. What it cannot know yet is whether that approval matches; a typed
 * digest that does not is refused below, at exit 3, once the plan is loaded.
 */
function clientFromEnvironment(env: NodeJS.ProcessEnv): BharatCodeClient {
  const config = loadBharatCodeConfig(env);
  requireApiKey(config.apiKey);
  return createBharatCodeClient({ config });
}

/** A mistyped cycle count should fail before a workspace is touched. */
function cycleCount(flag: string, ceiling: number, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new AppError({
      kind: 'config',
      message: `${flag} must be a whole number from 1 to ${String(ceiling)}; got ${raw}.`,
      remediation:
        'The ceiling is not a flag. A repair that needs more cycles than this needs a person, not a bigger budget.',
      details: { flag, given: raw },
    });
  }
  return value;
}

function label(name: string, value: string): string {
  return `${name.padEnd(12)}${value}`;
}

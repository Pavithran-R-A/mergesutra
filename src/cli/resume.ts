import { AppError } from '../core/errors.js';
import { redactDocument } from '../security/redaction.js';
import { runImplementStage, type ImplementStageDeps } from '../implement/implement.js';
import type { LoopLimits } from '../implement/limits.js';
import { runResumeStage, type ResumeStageDeps } from '../lifecycle/resume.js';
import type { ResumePlan } from '../lifecycle/resume-plan.js';
import { runPlanStage, type PlanDeps } from '../plan/plan.js';
import { runPrStage, type PrStageDeps } from '../pr/stage.js';
import { runReportStage, type ReportDeps } from './report.js';
import { runReviewStage, type ReviewStageDeps } from '../review/stage.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import type { RunRecord } from '../state/run-record.js';
import { runVerifyStage, type VerifyStageDeps } from '../verify/stage.js';
import { PRODUCT_NAME } from '../version.js';
import { exitForOutcome, EXIT } from './exit-codes.js';
import { runContractStage, type ContractDeps } from './contract.js';
import { terminalSafeDocument, terminalSafeJson } from '../security/terminal-safety.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';

/**
 * `mergesutra resume [run-id]` — Stage 11.
 *
 * The service above this file decides whether an action may happen. This file decides
 * two things a person depends on and nothing else: what the decision *looks like*
 * before they type `--execute`, and what number a script reads afterwards.
 *
 * The screen exists because §16 asks for a preview that states its cost, and a cost
 * described in prose is a cost a reader skims. So every plan prints the same six rows
 * — a model request, a credential, the workspace, the repository's own gates, an
 * approval, a remote — with a yes or a no on each, whether or not it is the interesting
 * one. A plan that needs none of them still says so on the row where a reader would
 * otherwise assume it, which is the only defence against a screen that reads as safe
 * because it is short.
 *
 * The dispatcher is this file's other half, and it is the reason `src/lifecycle` can
 * stay ignorant of the command layer: the service asks "run the stage this plan names,
 * with these limits", and here a `ResumeCommand` becomes a call to the same stage
 * runner `mergesutra <command>` would have called, with the same injected deps. No
 * second implementation of any stage is reachable from `resume`, so none of them can
 * have a looser gate on the recovery path than on the direct one. It is also where
 * §17's boundaries are physically absent: the dispatcher has no case that approves a
 * repair, no case that consents to a gate, and no case that reaches a remote. Repair is
 * the one command the plan vocabulary contains and the dispatcher refuses, because the
 * service refuses every plan whose repair approval is missing before a dispatcher is
 * ever consulted, and a `resume` that could route to `runRepairStage` would be a
 * `resume` with an approval it was never given.
 *
 * The exit codes are the third thing, and §37 is precise about them: a preview that
 * described its plan exits 0, an action exits whatever the stage that ran filed, a
 * missing approval exits 4, a gap that is a human's to close exits 3, and a missing
 * credential exits 78 — the last one by not being caught here at all, so the same
 * handler every other command uses reports it. Nothing exits 0 because an action was
 * attempted, because on this command an attempt and an action are different events and
 * a script must be able to tell them apart.
 */

export interface ResumeCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  /** The only way to turn a plan into an action. There is no `--yes`, and none is planned. */
  readonly execute?: boolean;
  /** Gate ids the operator consents to run this repository's commands for. */
  readonly allow?: readonly string[];
  readonly signal?: AbortSignal;
}

/** The stage deps the dispatcher may route to, plus the service's own view of the run. */
export interface ResumeCommandDeps {
  readonly resume?: Partial<ResumeStageDeps>;
  readonly contract?: Partial<ContractDeps>;
  readonly plan?: Partial<PlanDeps>;
  readonly implement?: Partial<ImplementStageDeps>;
  readonly verify?: Partial<VerifyStageDeps>;
  readonly review?: Partial<ReviewStageDeps>;
  readonly report?: Partial<ReportDeps>;
  readonly pr?: Partial<PrStageDeps>;
}

export async function resumeAction(
  runId: string | undefined,
  options: ResumeCommandOptions,
  deps: ResumeCommandDeps = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const env = options.env ?? process.env;
  const renderer = createRenderer({ color: resolveColor(options.noColor === true, env) });
  const executeStage = deps.resume?.executeStage ?? stageDispatcher(deps, options);

  const result = await runResumeStage(
    {
      ...(runId ? { runId } : {}),
      ...(options.repo ? { repo: options.repo } : {}),
      execute: options.execute === true,
    },
    { ...(deps.resume ?? {}), executeStage },
  );

  // What this screen prints is partly somebody else's text: a refusal names the host a
  // lock owner called itself, and that file is one any process here could have written.
  // So both shapes are rendered from one redacted copy, which also keeps the page and
  // `--json` from becoming two accounts of the same stop. The exit code is still read
  // from the original — a mask is a decision about display, and must not quietly become
  // a decision about what happened.
  const shown = redactDocument(result);

  if (options.json) {
    write(terminalSafeJson(jsonDocument(shown)));
    return exitFor(result);
  }

  write(renderer.heading(`${PRODUCT_NAME} — what a resume would do`));
  write('');
  write(formatResume(shown, renderer));
  return exitFor(result);
}

/**
 * The plan's command, turned into the call that stage's own screen would have made.
 *
 * `limits` arrives from the budget module and goes to the one stage that has bounds to
 * receive: a resumed loop is given what the entry before it left, and every other stage
 * is given nothing extra, because a plan that names `verify` has no loop to re-enter.
 */
function stageDispatcher(
  deps: ResumeCommandDeps,
  options: ResumeCommandOptions,
): NonNullable<ResumeStageDeps['executeStage']> {
  const where = options.repo ? { repo: options.repo } : {};
  const signal = options.signal ? { signal: options.signal } : {};

  return async (plan: ResumePlan, limits: Partial<LoopLimits> | null): Promise<RunRecord> => {
    const runId = plan.runId;
    switch (plan.command) {
      case 'contract':
        return (await runContractStage({ runId }, deps.contract)).record;
      case 'plan':
        return (await runPlanStage({ runId }, deps.plan)).record;
      case 'implement':
        return (
          await runImplementStage(
            { runId, ...where, ...signal, ...(limits ? { limits } : {}) },
            deps.implement,
          )
        ).record;
      case 'verify':
        return (await runVerifyStage({ runId, ...where, allow: options.allow }, deps.verify))
          .record;
      case 'review':
        return (await runReviewStage({ runId, ...where, ...signal }, deps.review ?? {})).record;
      case 'report': {
        // The pack is a rendering of the record, so the record is the thing to hand
        // back — and re-reading it after the write is how this stays honest about what
        // is on disk rather than what was in memory when the stage started.
        await runReportStage({ runId }, deps.report);
        const store: RunStore =
          deps.report?.store ??
          createFileRunStore(defaultRunStoreRoot(deps.report?.cwd ?? process.cwd()));
        return await store.load(runId);
      }
      case 'pr':
        return (await runPrStage({ runId, ...where }, deps.pr)).record;
      case 'repair':
      case null:
        // A plan that names `repair`, or names no command at all, is not a stage a resume
        // can start: one needs an approval of a digest and the other has nothing to run.
        // The service refuses both before it consults a dispatcher, so this answers a
        // caller that hands a dispatcher a plan it did not gate — rather than falling
        // through to whichever stage happened to be compiled last.
        throw new AppError({
          kind: 'validation',
          message:
            'A repair is not something `resume` can start: it needs an approval of a plan ' +
            'digest, and the only command that may hold one is `mergesutra repair`.',
          remediation:
            'Read the plan with `mergesutra repair <run-id>`, then approve its digest there. A plan with no command has nothing to run, and `mergesutra status <run-id>` says why.',
        });
    }
  };
}

/**
 * The machine-readable shape of one result: the plan flattened, plus what the stop or
 * the action added to it.
 *
 * A script reads this to decide, so the fields a decision is made from cannot sit a
 * level below the field that says which branch they belong to. `kind` and the plan's
 * own vocabulary share the top level for that reason — `action`, `requiresModel` and
 * `observedStateDigest` are readable without first asking where the plan went.
 */
function jsonDocument(result: Awaited<ReturnType<typeof runResumeStage>>): Record<string, unknown> {
  const outcome =
    result.kind === 'RAN'
      ? {
          outcome: result.record.outcome,
          stage: result.record.stage,
          recordRunId: result.record.runId,
          lockReleased: result.lockReleased,
        }
      : {};
  return {
    kind: result.kind,
    ...result.plan,
    ...(result.kind === 'REFUSED' ? { refusal: result.refusal } : {}),
    ...(result.kind === 'BLOCKED' ? { block: result.block } : {}),
    ...outcome,
    ...('message' in result ? { message: result.message } : {}),
  };
}

function exitFor(result: Awaited<ReturnType<typeof runResumeStage>>): number {
  switch (result.kind) {
    case 'PREVIEW':
      // The preview did the only job it has, which is to describe a plan. Nothing was
      // attempted, so this 0 is not a claim about the run.
      return EXIT.OK;
    case 'RAN':
      return exitForOutcome(result.record.outcome);
    case 'REFUSED':
      // A boundary the build cannot grant is a block; a decision that belongs to a
      // person is the gap `INCONCLUSIVE` already means elsewhere in this vocabulary.
      return result.refusal === 'AWAIT_HUMAN' ? EXIT.INCONCLUSIVE : EXIT.BLOCKED;
    case 'BLOCKED':
      return EXIT.BLOCKED;
  }
}

/** The six costs a plan can carry, always all printed — see the header comment. */
function costRows(plan: ResumePlan, renderer: Renderer, width: number): string[] {
  const yes = (needed: boolean, what: string, idle: string): string =>
    needed ? what : renderer.dim(idle);
  return [
    row(
      'Model request',
      yes(plan.requiresModel, 'one BharatCode round trip', 'none — this is arithmetic and Git'),
      width,
    ),
    row(
      'Credential',
      yes(plan.requiresCredential, 'BharatCode must be configured on this machine', 'none needed'),
      width,
    ),
    row(
      'Workspace',
      yes(
        plan.mutatesWorkspace,
        'changes files in the checkout this run owns',
        'untouched — no file here is written',
      ),
      width,
    ),
    row(
      'Repository gates',
      yes(
        plan.requiresExecutionConsent,
        'the gate ids you name with --allow, and only those',
        'no command from the repository is run',
      ),
      width,
    ),
    row(
      'Approval',
      yes(
        plan.requiresRepairApproval || plan.requiresPublicationApproval,
        plan.requiresRepairApproval
          ? "a repair approval this command cannot hold — it is `mergesutra repair`'s to be given"
          : "a page approval this command cannot hold — it is `mergesutra pr`'s to be given",
        'none — nothing here is a decision that belongs to a person',
      ),
      width,
    ),
    row('Remote', renderer.dim('none — this build has no remote action in any command'), width),
  ];
}

export function formatResume(
  input: Awaited<ReturnType<typeof runResumeStage>>,
  renderer: Renderer,
): string {
  // Display copy: a value this command only read may not carry a byte that steers
  // the terminal it is printed on. See src/security/terminal-safety.ts.
  const result = terminalSafeDocument(input);
  const lines: string[] = [];
  const plan = result.plan;
  const width = 22;

  lines.push(row('Run', plan.runId, width));
  lines.push(row('Would run', plan.action, width));
  lines.push(row('Stage', plan.stage ?? 'no stage of its own', width));
  lines.push(
    row('Command', plan.command ? `mergesutra ${plan.command} ${plan.runId}` : 'none', width),
  );
  lines.push('');
  lines.push(renderer.heading('Why this is the next thing'));
  lines.push(`  ${plan.reason}`);
  lines.push('');
  lines.push(renderer.heading('What it costs'));
  lines.push(...costRows(plan, renderer, width));
  lines.push('');

  if (result.kind === 'RAN') {
    lines.push(renderer.heading('What happened'));
    lines.push(row('Outcome', result.record.outcome, width));
    // One action a plan can name files nothing: the pack is a rendering of the record,
    // so the record still reads as whatever stage last advanced it. Printing that stage
    // here would claim this command ran it, which is the difference between a screen a
    // person can act on and one that merely looks like it.
    lines.push(
      row(
        'Stage recorded',
        plan.stage ?? `none — ${plan.command ?? 'this action'} files no record of its own`,
        width,
      ),
    );
    // Some stages advance the run they were given and one of them — the planner — files
    // its answer as a new run instead. The screen names the record that now holds the
    // result either way, because a person who resumes `run-1` and is told "plan
    // complete" needs to know which id to read next.
    lines.push(
      row(
        'Run record',
        result.record.runId === plan.runId
          ? plan.runId
          : `${result.record.runId} (this stage filed a new run; ${plan.runId} is unchanged)`,
        width,
      ),
    );
    lines.push(
      row(
        'Run lock',
        result.lockReleased
          ? 'given back — another process may act on this run'
          : 'left in place, and this command did not remove it',
        width,
      ),
    );
    lines.push('');
    lines.push(
      `  ${renderer.dim(
        'The stage above ran under the plan this screen printed, and filed what it measured. What it measured is not a claim of this command.',
      )}`,
    );
    lines.push('');
    lines.push(renderer.heading('THE STAGE NAMED ABOVE RAN, AND FILED WHAT IT FOUND.'));
    return lines.join('\n');
  }

  if (result.kind === 'REFUSED' || result.kind === 'BLOCKED') {
    lines.push(
      renderer.heading(result.kind === 'BLOCKED' ? 'Blocked. Nothing was run.' : 'Stopped.'),
    );
    lines.push(`  ${result.message}`);
    lines.push('');
  }

  lines.push(renderer.heading('Reading the state this plan was built from'));
  lines.push(row('State digest', plan.observedStateDigest, width));
  lines.push(row('Patch here', plan.currentPatchIdentity ?? 'none this machine reports', width));
  lines.push('');
  lines.push(
    `  ${renderer.dim(
      'The digest covers every fact this plan was read from except when they were read. An execution re-reads them before it acts and stops if they have moved.',
    )}`,
  );
  lines.push('');
  lines.push(
    `  to act on the plan above: mergesutra resume ${plan.runId} --execute${result.kind === 'PREVIEW' ? '' : '  (after re-reading it)'}`,
  );
  lines.push('');
  // Two endings, because the two paths differ: a preview may still be acted on, while a
  // stop has already decided against acting. Both say the same true thing in the last
  // line, in the same place, so a reader never has to learn where the caveat lives.
  lines.push(
    renderer.heading(result.kind === 'PREVIEW' ? 'NOTHING HAS BEEN RUN.' : 'NOTHING WAS RUN.'),
  );
  return lines.join('\n');
}

function row(name: string, value: string, width: number): string {
  return `  ${name.padEnd(Math.max(name.length + 2, width))}${value}`;
}

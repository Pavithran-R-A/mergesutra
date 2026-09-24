import { PRODUCT_NAME } from '../version.js';
import type { ImplementationPlan } from '../plan/schema.js';
import { exitForOutcome } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';
import { runPlanStage, type PlanDeps, type PlanResult } from '../plan/plan.js';

/**
 * `mergesutra plan [run-id]` — Stage 4.
 *
 * The first command that spends a model call, so the first command that has to
 * be explicit about what a model can and cannot decide. It can propose files,
 * commands and risks. It cannot mark a criterion checked, add a requirement, or
 * make MergeSutra run anything — and the footer of this output says so, because
 * a reader who skims the plan must still meet that sentence.
 */

export interface PlanCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function planAction(
  runId: string | undefined,
  options: PlanCommandOptions,
  deps: Partial<PlanDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  // Transport and configuration failures are left to `run()` to report: they
  // are not a plan with a problem in it, and printing one here would blur the
  // two.
  const result = await runPlanStage({ runId }, deps);

  if (options.json) {
    write(JSON.stringify({ recordFile: result.recordFile, record: result.record }, null, 2));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — implementation plan`));
  write('');
  write(formatPlan(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatPlan(result: PlanResult, renderer: Renderer): string {
  const { record, plan, checks, sourceRunId, recordFile, saveError } = result;
  const lines: string[] = [];

  for (const check of checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(20)}${check.detail}`);
  }
  lines.push('');
  lines.push(label('From run', sourceRunId));
  lines.push(
    label(
      'Contract',
      record.acceptanceContract
        ? `v${record.acceptanceContract.version}, ${record.acceptanceContract.criteria.length} criteria`
        : 'NOT_AVAILABLE',
    ),
  );
  lines.push(label('Model', plan?.provenance.model ?? 'NOT_AVAILABLE'));
  lines.push('');

  if (plan) lines.push(...renderBody(plan, renderer));

  lines.push(label('Outcome', record.outcome));
  lines.push('');

  const gaps = [...new Set([...(plan?.limitations ?? []), ...record.limitations])];
  if (gaps.length > 0) {
    lines.push(renderer.heading('What this plan does not establish'));
    for (const gap of gaps) lines.push(`  ${gap}`);
    lines.push('');
  }

  if (recordFile) lines.push(label('Run record', recordFile));
  else if (saveError) lines.push(label('Run record', `not written — ${saveError}`));
  lines.push(label('Next stage', record.nextStage));
  lines.push('');
  lines.push(
    renderer.dim(
      'A plan is a proposal from a model. Nothing here was executed, changed, or verified.',
    ),
  );
  lines.push(
    renderer.dim(
      'Criterion statuses move only when evidence exists, and no command was run to produce any.',
    ),
  );
  return lines.join('\n');
}

function renderBody(plan: ImplementationPlan, renderer: Renderer): string[] {
  const { body } = plan;
  const lines: string[] = [];
  lines.push(renderer.heading('Plan'));
  lines.push(`  ${body.summary}`);
  lines.push('');
  lines.push(label('Root cause', body.rootCause));
  lines.push('');

  lines.push(renderer.heading('Changes proposed'));
  for (const change of body.changes) {
    lines.push(`  ${change.action.padEnd(8)}${change.file.padEnd(38)}${ids(change.criterionIds)}`);
    lines.push(renderer.dim(`          ${change.reason}`));
  }
  lines.push('');

  lines.push(renderer.heading('Validation commands (proposed argv, never run here)'));
  if (body.validationCommands.length === 0) {
    lines.push('  none proposed');
  }
  for (const command of body.validationCommands) {
    lines.push(`  ${command.argv.join(' ').padEnd(40)}${ids(command.criterionIds)}`);
    lines.push(renderer.dim(`    purpose: ${command.purpose}`));
  }
  lines.push('');

  lines.push(label('Covered', ids(body.criteriaCovered)));
  if (body.criteriaUnaddressed.length > 0) {
    lines.push(
      label('Unaddressed', `${body.criteriaUnaddressed.length} the plan names instead of claiming`),
    );
    for (const entry of body.criteriaUnaddressed) {
      lines.push(`  ${entry.id}: ${entry.reason}`);
    }
  }
  lines.push('');

  if (body.proposedCriteria.length > 0) {
    lines.push(renderer.heading('Proposed criteria — MODEL CLAIM, not requirements'));
    for (const proposal of body.proposedCriteria) {
      lines.push(`  [${proposal.requirementType}] ${proposal.statement}`);
      lines.push(renderer.dim(`    why: ${proposal.reason}`));
    }
    lines.push('');
  }

  lines.push(...list(renderer, 'Risks', body.risks));
  lines.push(...list(renderer, 'Assumptions', body.assumptions));
  lines.push(...list(renderer, 'Questions for a human', body.questionsForHuman));
  return lines;
}

function list(renderer: Renderer, title: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  const lines = [renderer.heading(title)];
  for (const item of items) lines.push(`  ${item}`);
  lines.push('');
  return lines;
}

function ids(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '—';
}

function label(name: string, value: string): string {
  return `${(name + ':').padEnd(14)}${value}`;
}

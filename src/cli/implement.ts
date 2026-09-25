import { PRODUCT_NAME } from '../version.js';
import { AppError } from '../core/errors.js';
import {
  runImplementStage,
  type ImplementStageDeps,
  type ImplementStageResult,
} from '../implement/implement.js';
import { LIMIT_CAPS, type LoopLimits } from '../implement/limits.js';
import type { ActionOutcome } from '../implement/state.js';
import { exitForOutcome } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer, type Status } from './render.js';

/**
 * `mergesutra implement [run-id]` — Stage 6.
 *
 * This is the command where a model stops proposing and something happens, so
 * the output is written to make that impossible to misread. Every row is what
 * MergeSutra actually did or refused, the budget the loop ran under is printed
 * before the actions are, and the two words the loop is not allowed to use —
 * `PASS` and `CONTRIBUTION_READY` — appear nowhere except in the sentence that
 * says they cannot.
 *
 * A cancelled or bounded run prints the same shape as a finished one, because
 * "it stopped" and "it worked" are the same kind of fact here: what changed on
 * disk, and what the model believes it did.
 */

export interface ImplementCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  readonly model?: string;
  readonly maxSteps?: string;
  readonly maxWrites?: string;
  readonly maxCommands?: string;
  readonly signal?: AbortSignal;
}

export async function implementAction(
  runId: string | undefined,
  options: ImplementCommandOptions,
  deps: Partial<ImplementStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  const limits = limitsFrom(options);
  const result = await runImplementStage(
    {
      runId,
      repo: options.repo,
      model: options.model,
      limits,
      signal: options.signal,
    },
    deps,
  );

  if (options.json) {
    write(JSON.stringify({ recordFile: result.recordFile, record: result.record }, null, 2));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — bounded implementation run`));
  write('');
  write(formatImplementation(result, renderer));
  return exitForOutcome(result.record.outcome);
}

/**
 * The knobs a caller may turn, and only within the ceiling `limits.ts` holds.
 *
 * Parsing happens here rather than at the loop because a mistyped `--max-steps`
 * should fail before a worktree is created and an API is charged.
 */
function limitsFrom(options: ImplementCommandOptions): Partial<LoopLimits> {
  const limits: { -readonly [K in keyof LoopLimits]?: LoopLimits[K] } = {};
  set('maxSteps', options.maxSteps, limits);
  set('maxWrites', options.maxWrites, limits);
  set('maxCommands', options.maxCommands, limits);
  return limits;
}

function set(key: 'maxSteps' | 'maxWrites' | 'maxCommands', raw: string | undefined, into: object) {
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > LIMIT_CAPS[key]) {
    throw new AppError({
      kind: 'validation',
      message: `--${kebab(key)} expects a whole number from 1 to ${LIMIT_CAPS[key]}; got '${raw}'.`,
      remediation:
        'Leave the budget at its default, or lower it. The ceiling exists so one run cannot become an unbounded agent.',
    });
  }
  Object.assign(into, { [key]: value });
}

export function formatImplementation(result: ImplementStageResult, renderer: Renderer): string {
  const { implementation: impl, record, recordFile, saveError } = result;
  const lines: string[] = [];

  for (const check of record.checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(20)}${check.detail}`);
  }
  lines.push('');

  lines.push(label('Run', impl.runId));
  lines.push(label('Outcome', record.outcome));
  lines.push(label('Loop status', impl.status));
  lines.push(label('Ended', `${impl.termination.kind} — ${impl.termination.detail}`));
  lines.push(label('Model', impl.model));
  lines.push(
    label(
      'Budget',
      `${impl.summary.steps}/${impl.limits.maxSteps} steps · ${impl.summary.writes}/${impl.limits.maxWrites} writes · ${impl.summary.commands}/${impl.limits.maxCommands} checks`,
    ),
  );
  lines.push(
    label(
      'Workspace',
      `${impl.workspace.relativePath} on ${impl.workspace.branch} at ${impl.workspace.baseSha.slice(0, 12)}${impl.workspace.reused ? ' (reused)' : ''}`,
    ),
  );
  lines.push('');

  lines.push(renderer.heading('What happened'));
  if (impl.actions.length === 0) lines.push('  nothing — the loop ended before an action ran');
  for (const action of impl.actions) {
    lines.push(
      `  ${String(action.step).padStart(2)}. ${renderer.status(statusFor(action.outcome))}${action.action.padEnd(26)}${action.target}`,
    );
    if (action.detail) lines.push(`      ${renderer.dim(bound(action.detail, 160))}`);
  }
  lines.push('');

  lines.push(renderer.heading('Files written in this workspace'));
  if (impl.changes.length === 0) lines.push('  none');
  for (const change of impl.changes) {
    lines.push(
      `  ${change.created ? 'new ' : 'edit'} ${change.relativePath.padEnd(44)}${`${change.bytes} B`.padEnd(12)}${ids(change.criterionIds)}`,
    );
    lines.push(`  ${renderer.dim(`sha256 ${change.contentSha256}`)}`);
  }
  lines.push('');

  lines.push(renderer.heading('Criteria the model claims'));
  if (impl.finishClaim) {
    lines.push(`  ${bound(impl.finishClaim.summary, 400)}`);
    lines.push(
      `  believed complete: ${ids(impl.finishClaim.criteriaBelievedComplete)} — MODEL CLAIM, unverified`,
    );
    lines.push(
      renderer.dim(
        '  no criterion changed status here; the record has no field that could claim one',
      ),
    );
  } else {
    lines.push(
      `  none — the loop ended at ${impl.termination.kind} without a FINISH action, so nothing is claimed`,
    );
  }
  lines.push('');

  if (impl.proposedRevisions.length > 0) {
    lines.push(renderer.heading('Revisions the model asked for (not applied)'));
    for (const revision of impl.proposedRevisions) {
      lines.push(
        `  ${revision.criterionId} (step ${revision.step}): ${bound(revision.previous, 90)}`,
      );
      lines.push(`    ${renderer.dim(`proposed: ${bound(revision.proposed, 90)}`)}`);
      lines.push(`    ${renderer.dim(`because: ${bound(revision.reason, 160)}`)}`);
    }
    lines.push(
      renderer.dim(
        '  a model cannot edit the criteria it is measured against. To change the contract, a human re-runs `mergesutra contract`.',
      ),
    );
    lines.push('');
  }

  lines.push(renderer.heading('What this run does not establish'));
  for (const gap of new Set([...impl.limitations, ...record.limitations])) {
    lines.push(`  ${gap}`);
  }
  lines.push('');

  if (recordFile) lines.push(label('Run record', recordFile));
  else if (saveError) lines.push(label('Run record', `not written — ${saveError}`));
  lines.push(label('Next stage', record.nextStage));
  lines.push('');
  lines.push(
    renderer.dim(
      'BharatCode chose what to look at and what to write. MergeSutra decided what was allowed to run.',
    ),
  );
  lines.push(
    renderer.dim(
      'Nothing here is verified: no criterion is PASS, and no push, pull request or comment was attempted.',
    ),
  );
  lines.push(
    renderer.dim(
      'Read it as a candidate: `git -C <workspace> diff` shows the bytes; `mergesutra verify` is what will judge them.',
    ),
  );
  return lines.join('\n');
}

/**
 * An action's outcome drawn in the colour of what it means, not what it hopes.
 *
 * `CHECK_PASSED` is INFO, not PASS: a developer command exiting 0 is a fact
 * about that command, and the word `PASS` in this product belongs to a verified
 * criterion — which Stage 7 decides.
 */
function statusFor(outcome: ActionOutcome): Status {
  switch (outcome) {
    case 'REFUSED':
      return 'FAIL';
    case 'CHECK_FAILED':
      return 'WARN';
    case 'CLAIMED':
    case 'CHECK_PASSED':
      return 'INFO';
    default:
      return 'INFO';
  }
}

function ids(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '—';
}

function label(name: string, value: string): string {
  return `${(name + ':').padEnd(14)}${value}`;
}

function bound(value: string, max: number): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

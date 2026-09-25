import { PRODUCT_NAME } from '../version.js';
import { exitForOutcome } from './exit-codes.js';
import { createRenderer, resolveColor, type Renderer, type Status } from './render.js';
import { runVerifyStage, type VerifyStageDeps, type VerifyStageResult } from '../verify/stage.js';
import type { GateOutcome } from '../verify/engine.js';

/**
 * `mergesutra verify [run-id]` — Stage 7.
 *
 * The one command in the product whose `PASS` rows are not anybody's opinion.
 * The report is still written defensively, because a verification table is
 * exactly where a reader is primed to over-read: a gate that passed is one
 * command's exit code, a criterion that passed is a different claim, and
 * "contribution ready" is a third that this stage never makes — so that
 * string appears nowhere in this file, not even to be denied.
 *
 * Blocked gates are printed as loud as passed ones: a run where nothing ran
 * must be the hardest thing on the page to mistake for success.
 */

export interface VerifyCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  readonly allow?: readonly string[];
  readonly signal?: AbortSignal;
}

export async function verifyAction(
  runId: string | undefined,
  options: VerifyCommandOptions,
  deps: Partial<VerifyStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  const result = await runVerifyStage(
    {
      runId,
      repo: options.repo,
      allow: options.allow,
      signal: options.signal,
    },
    deps,
  );

  if (options.json) {
    write(JSON.stringify({ recordFile: result.recordFile, record: result.record }, null, 2));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — deterministic verification run`));
  write('');
  write(formatVerification(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatVerification(result: VerifyStageResult, renderer: Renderer): string {
  const { record, plan, run, evidence, consent, workspace, recordFile, saveError } = result;
  const lines: string[] = [];

  for (const check of record.checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(20)}${check.detail}`);
  }
  lines.push('');

  lines.push(label('Run', record.runId));
  lines.push(label('Verdict', run.result));
  lines.push(label('Outcome', record.outcome));
  lines.push(label('Workspace', workspace));
  lines.push(label('Patch', `${plan.patchIdentity.slice(0, 12)} on ${plan.baseSha.slice(0, 12)}`));
  lines.push(
    label(
      'Plan',
      `revision ${plan.revision} · ${plan.gates.length} gates · ${run.gates.length} receipts`,
    ),
  );
  lines.push(
    label(
      'Consent',
      consent
        ? `named by operator: ${consent.gateIds.join(', ')}`
        : 'none given — repository commands were not run',
    ),
  );
  lines.push('');

  lines.push(renderer.heading('Gates'));
  for (const outcome of run.gates) {
    const gate = plan.gates.find((entry) => entry.id === outcome.gateId);
    lines.push(
      `  ${renderer.status(statusFor(outcome))} ${outcome.gateId}  ${describeOutcome(outcome, gate?.command ?? '?')}`,
    );
  }
  lines.push('');

  const waiting = run.gates.filter((outcome) => outcome.requiresConsent);
  if (waiting.length > 0) {
    lines.push(renderer.heading('To run the gates above'));
    const flags = waiting.map((outcome) => `--allow ${outcome.gateId}`).join(' ');
    lines.push(`  mergesutra verify ${record.runId} ${flags}`);
    lines.push(
      renderer.dim(
        "  each id consents to that gate's exact command, and to nothing else on this machine.",
      ),
    );
    lines.push(
      renderer.dim(
        '  the workspace is checked separately against the patch this plan describes, so continuing to implement voids a run rather than reusing its receipts.',
      ),
    );
    lines.push('');
  }

  lines.push(renderer.heading('Criteria — what the receipts carry'));
  for (const entry of evidence.criteria) {
    lines.push(
      `  ${renderer.status(criterionStatus(entry.status))} ${entry.criterionId.padEnd(6)}${entry.sufficiency.padEnd(24)}${entry.status === 'PASS' ? 'gates: ' + entry.gateIds.join(', ') : (entry.limitations[0] ?? entry.status)}`,
    );
  }
  if (evidence.criteria.length === 0) {
    lines.push('  the contract holds no criteria, so there is nothing this could evidence');
  }
  lines.push('');

  if (evidence.claims.length > 0) {
    lines.push(renderer.heading('What the model said (a claim; decided nothing)'));
    for (const claim of evidence.claims) {
      lines.push(`  ${renderer.dim(claim.source)}: ${bound(claim.text, 300)}`);
    }
    lines.push('');
  }

  if (run.contamination) {
    lines.push(renderer.heading('Contamination'));
    lines.push(`  ${run.contamination.reason}`);
    lines.push('');
  }
  if (evidence.patchIdentity !== evidence.currentPatchIdentity) {
    lines.push(renderer.heading('Staleness'));
    lines.push(
      `  the workspace now holds ${evidence.currentPatchIdentity.slice(0, 12)}, not the verified ${evidence.patchIdentity.slice(0, 12)} — affected rows are marked STALE above.`,
    );
    lines.push('');
  }
  if (evidence.notes.length > 0) {
    for (const note of evidence.notes) lines.push(renderer.dim(`  ${note}`));
    lines.push('');
  }

  if (recordFile) lines.push(label('Run record', recordFile));
  else if (saveError) lines.push(label('Run record', `not written — ${saveError}`));
  lines.push(label('Next stage', record.nextStage));
  lines.push('');
  lines.push(
    renderer.dim(
      "A gate PASS is one command's exit code. A criterion PASS is that command plus the mapping this record publishes.",
    ),
  );
  lines.push(
    renderer.dim(
      "No gate here saw a model. The model's FINISH sits in the claims section, weighted nothing.",
    ),
  );
  lines.push(
    renderer.dim('The judgement of whether this is worth submitting arrives later, with a human.'),
  );
  return lines.join('\n');
}

/**
 * Row colour by meaning: `BLOCKED` is WARN because it indicts the process,
 * not the patch; only an exit code that disagreed with the claim is FAIL.
 */
function statusFor(outcome: GateOutcome): Status {
  switch (outcome.receipt.result) {
    case 'PASS':
      return 'PASS';
    case 'FAIL':
    case 'REFUSED':
      return 'FAIL';
    case 'INCONCLUSIVE':
    case 'BLOCKED':
      return 'WARN';
    default:
      return 'INFO';
  }
}

function criterionStatus(status: string): Status {
  switch (status) {
    case 'PASS':
      return 'PASS';
    case 'FAIL':
      return 'FAIL';
    case 'PENDING':
      return 'INFO';
    default:
      return 'WARN';
  }
}

function describeOutcome(outcome: GateOutcome, command: string): string {
  const exit =
    outcome.receipt.exitCode === null ? 'not executed' : `exit ${outcome.receipt.exitCode}`;
  return `${command}  ${exit} — ${bound(outcome.reason, 120)}`;
}

function label(name: string, value: string): string {
  return `${(name + ':').padEnd(12)}${value}`;
}

function bound(value: string, max: number): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

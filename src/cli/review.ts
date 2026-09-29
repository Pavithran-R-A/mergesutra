import { PRODUCT_NAME } from '../version.js';
import { AppError } from '../core/errors.js';
import { MAX_REPAIR_CYCLES_CEILING, MAX_REVIEW_CYCLES_CEILING } from '../repair/bounds.js';
import type { ReviewFinding } from '../review/schema.js';
import { runReviewStage, type ReviewStageDeps, type ReviewStageResult } from '../review/stage.js';
import { exitForOutcome } from './exit-codes.js';
import { terminalSafeDocument, terminalSafeJson } from '../security/terminal-safety.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';

/**
 * `mergesutra review [run-id]` — Stage 9.
 *
 * The one command whose subject is another model's judgement, so the reporting
 * has to keep two things apart that a reader will otherwise fuse: what the
 * reviewer said, and what MergeSutra did about it. Every finding row therefore
 * carries the disposition *MergeSutra* gave it and the reason for that
 * disposition, and the words `PASS`, `APPROVED` and `CONTRIBUTION_READY` appear
 * nowhere in this file — a review has no such state to report.
 *
 * The exit code is the recorded outcome's, which is why a completed review exits
 * 3: a run somebody read carefully is not a run that is finished.
 */

export interface ReviewCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly repo?: string;
  readonly maxReviewCycles?: string;
  readonly maxRepairCycles?: string;
  readonly signal?: AbortSignal;
}

export async function reviewAction(
  runId: string | undefined,
  options: ReviewCommandOptions,
  deps: Partial<ReviewStageDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  const result = await runReviewStage(
    {
      runId,
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      ...deps,
      env: deps.env ?? options.env ?? process.env,
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
    write(terminalSafeJson({ recordFile: result.recordFile, record: result.record }));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — independent review of these bytes`));
  write('');
  write(formatReview(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatReview(input: ReviewStageResult, renderer: Renderer): string {
  // Display copy: a value this command only read may not carry a byte that steers
  // the terminal it is printed on. See src/security/terminal-safety.ts.
  const result = terminalSafeDocument(input);
  const { record, attempt, review, repairPlan, workspace, recordFile, saveError } = result;
  const lines: string[] = [];

  for (const check of record.checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(24)}${check.detail}`);
  }
  lines.push('');

  lines.push(label('Run', record.runId));
  lines.push(label('Outcome', record.outcome));
  lines.push(label('Workspace', workspace));
  lines.push(
    label(
      'Reviewed',
      `${attempt.reviewedPatchIdentity.slice(0, 12)}… on ${
        record.base === null ? 'a base this run never recorded' : record.base.shortSha
      }`,
    ),
  );
  lines.push(
    label(
      'On disk now',
      attempt.currentPatchIdentity === null
        ? `not measured — ${attempt.patchPrecondition.toLowerCase()}`
        : `${attempt.currentPatchIdentity.slice(0, 12)}… · ${attempt.patchPrecondition}`,
    ),
  );
  lines.push('');

  if (review === null) {
    lines.push(renderer.heading('No review was filed'));
    lines.push(`  ${attempt.detail}`);
    lines.push(
      renderer.dim(
        '  the record keeps the attempt and what stopped it; nothing here is a second reading of the patch.',
      ),
    );
    lines.push('');
  } else {
    lines.push(
      label(
        'Reviewer',
        `${review.modelId} · ${String(review.attempts)} answer${review.attempts === 1 ? '' : 's'} · ${review.reviewedAt}`,
      ),
    );
    lines.push(label('Its summary', review.summary));
    lines.push('');
    lines.push(renderer.heading('Findings — the reviewer’s words, MergeSutra’s disposition'));
    if (review.findings.length === 0) {
      lines.push('  (none)');
    }
    for (const finding of review.findings) {
      lines.push(...findingLines(finding));
    }
    lines.push('');
  }

  if (repairPlan) {
    lines.push(renderer.heading('Repair plan — frozen before any edit'));
    lines.push(
      `  cycle ${String(repairPlan.reviewCycle)} · ${repairPlan.findings
        .map((item) => `${item.findingId} → ${item.expectedFiles.join(', ')}`)
        .join(' · ')}`,
    );
    lines.push(`  answers to: ${repairPlan.expectedChecks.join(', ') || 'no gate id was named'}`);
    lines.push(
      renderer.dim(
        `  no file was changed here: nothing in this run was edited, and what a later repair achieves is decided by re-verifying the bytes it leaves.`,
      ),
    );
    lines.push('');
  }

  if (record.limitations.length > 0) {
    lines.push(renderer.heading('Limits on what this review could see'));
    for (const limitation of record.limitations) {
      lines.push(`  - ${limitation}`);
    }
    lines.push('');
  }

  if (saveError) {
    lines.push(renderer.status('FAIL'));
    lines.push(`  the record could not be written: ${saveError}`);
  } else if (recordFile) {
    lines.push(label('Record', recordFile));
  }
  lines.push(label('Next', record.nextStage));
  return lines.join('\n');
}

function findingLines(finding: ReviewFinding): string[] {
  return [
    `  ${finding.id}  ${finding.severity}  ${finding.category}  ${finding.disposition}`,
    `    ${finding.statement}`,
    ...(finding.file ? [`    file: ${finding.file}`] : []),
    ...(finding.criterionIds.length > 0
      ? [`    criteria: ${finding.criterionIds.join(', ')}`]
      : []),
    ...(finding.contextRefs.length > 0 ? [`    cites: ${finding.contextRefs.join(', ')}`] : []),
    `    weighed: ${finding.dispositionReason}`,
  ];
}

/** A mistyped cycle count should fail before a request is paid for. */
function cycleCount(flag: string, ceiling: number, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new AppError({
      kind: 'config',
      message: `${flag} must be a whole number from 1 to ${String(ceiling)}; got ${raw}.`,
      remediation:
        'The ceiling is not a flag. A run that needs more cycles than this needs a person, not a bigger budget.',
      details: { flag, given: raw },
    });
  }
  return value;
}

function label(name: string, value: string): string {
  return `${name.padEnd(12)}${value}`;
}

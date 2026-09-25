import { createRenderer, resolveColor, type Renderer } from './render.js';
import { exitForOutcome } from './exit-codes.js';
import { runIntake, type IntakeDeps, type IntakeResult } from '../intake/intake.js';
import { PRODUCT_NAME } from '../version.js';

/**
 * `mergesutra issue <url>` — the hero command, currently intake only.
 *
 * This prints what Stage 1 genuinely established and stops there. It does not
 * simulate the later phases: no fake progress bar, no invented diff, no
 * "CONTRIBUTION_READY". The closing lines say exactly which stages have not
 * been built yet, so nobody mistakes a clean intake for a finished patch.
 */

export interface IssueCommandOptions {
  readonly repo?: string;
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function issueAction(
  url: string | undefined,
  options: IssueCommandOptions,
  deps: Partial<IntakeDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });

  // Intake runs first: a rejected URL should produce one clean error rather
  // than a heading followed by a failure.
  const result = await runIntake({ issueUrl: url, repoPath: options.repo }, deps);

  if (options.json) {
    write(JSON.stringify({ recordFile: result.recordFile, record: result.record }, null, 2));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — intake`));
  write('');
  write(formatIntake(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatIntake(result: IntakeResult, renderer: Renderer): string {
  const { record, recordFile, saveError, checks } = result;
  const lines: string[] = [];

  for (const check of checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(20)}${check.detail}`);
  }
  lines.push('');

  lines.push(
    label(
      'Issue',
      record.issue
        ? `#${record.issue.number} [${record.issue.state}] ${record.issue.title}`
        : (record.issueRef?.canonical ?? '(none supplied)'),
    ),
  );
  lines.push(
    label(
      'Repository',
      record.repository
        ? `${record.repository.fullName} @ ${record.repository.defaultBranch}`
        : 'NOT_AVAILABLE',
    ),
  );
  lines.push(
    label(
      'Base commit',
      record.base ? `${record.base.sha} (${record.base.source})` : 'NOT_AVAILABLE',
    ),
  );
  lines.push(
    label(
      'Local clone',
      record.local ? `${record.local.toplevel} on ${record.local.branch}` : 'NOT_AVAILABLE',
    ),
  );
  lines.push(label('Outcome', record.outcome));
  lines.push('');

  if (record.limitations.length > 0) {
    lines.push(renderer.heading('What MergeSutra does not know yet'));
    for (const limitation of record.limitations) lines.push(`  ${limitation}`);
    lines.push('');
  }

  if (recordFile) {
    lines.push(label('Run record', recordFile));
  } else if (saveError) {
    lines.push(label('Run record', `not written — ${saveError}`));
  }
  lines.push(label('Next stage', record.nextStage));
  lines.push('');

  if (record.issue) {
    lines.push(
      renderer.dim(
        'Issue text was imported as data. It is never treated as instructions, and the full body is not printed.',
      ),
    );
  }
  lines.push(
    renderer.dim(
      'Stages implemented: 0 (foundation), 1 (intake), 2 (repository contract), 3 (acceptance contract), 4 (implementation plan), 5 (workspace, tool policy, write boundary), 6 (bounded implementation loop).',
    ),
  );
  lines.push(
    renderer.dim(
      'This command produced no patch, verification, review or pull request. `mergesutra implement` writes files, but only inside its own workspace, and verifies nothing.',
    ),
  );
  return lines.join('\n');
}

function label(name: string, value: string): string {
  return `${(name + ':').padEnd(14)}${value}`;
}

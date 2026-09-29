import { terminalSafeDocument, terminalSafeJson } from '../security/terminal-safety.js';
import { createRenderer, resolveColor, type Renderer } from './render.js';
import { exitForOutcome } from './exit-codes.js';
import { runInspect, type InspectDeps, type InspectResult } from '../discovery/inspect.js';
import type { Gate, RepositoryContract } from '../discovery/contract.js';
import { PRODUCT_NAME } from '../version.js';

/**
 * `mergesutra inspect <path>` — Stage 2, the repository policy compiler.
 *
 * The output is a list of facts with their sources, not a to-do list. It says
 * "CI runs `npm test` (ci.yml:31)" and "nothing declares a format gate", and it
 * stops there: inspect never runs a repository's commands, never installs
 * anything and never proposes a patch.
 */

export interface InspectCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export async function inspectAction(
  repoPath: string | undefined,
  options: InspectCommandOptions,
  deps: Partial<InspectDeps> = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  const result = await runInspect({ repoPath: repoPath ?? '.' }, deps);

  if (options.json) {
    write(terminalSafeJson({ recordFile: result.recordFile, record: result.record }));
    return exitForOutcome(result.record.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — repository contract`));
  write('');
  write(formatInspect(result, renderer));
  return exitForOutcome(result.record.outcome);
}

export function formatInspect(input: InspectResult, renderer: Renderer): string {
  // Display copy: a value this command only read may not carry a byte that steers
  // the terminal it is printed on. See src/security/terminal-safety.ts.
  const result = terminalSafeDocument(input);
  const { record, contract, recordFile, saveError, checks, root } = result;
  const lines: string[] = [];

  for (const check of checks) {
    lines.push(`${renderer.status(check.status)} ${check.name.padEnd(20)}${check.detail}`);
  }
  lines.push('');
  lines.push(label('Repository', record.local?.toplevel ?? root));
  lines.push(
    label(
      'Base commit',
      record.base ? `${record.base.sha} (${record.base.source})` : 'NOT_AVAILABLE',
    ),
  );
  lines.push(label('Ecosystem', `${contract.ecosystem}` + toolchain(contract)));
  lines.push('');

  lines.push(renderer.heading('Gates'));
  const commandWidth = Math.min(
    40,
    Math.max(20, ...contract.gates.map((gate) => (gate.command ?? '—').length)),
  );
  for (const gate of contract.gates) {
    lines.push(`  ${formatGate(gate, commandWidth)}`);
  }
  lines.push('');
  if (contract.gates.some((gate) => (gate.command ?? '').length > commandWidth)) {
    lines.push(
      renderer.dim(
        `  Commands longer than ${commandWidth} characters are cut in this table; --json carries them whole.`,
      ),
    );
  }

  lines.push(
    label(
      'CI',
      `${contract.ci.provider} — ${contract.ci.workflows.length} workflow(s), ${contract.ci.observedCommandCount} command(s), coverage ${contract.ci.coverage}`,
    ),
  );
  for (const caveat of contract.ci.caveats) lines.push(`  ${renderer.dim(caveat)}`);
  lines.push('');

  lines.push(
    label(
      'Protected',
      contract.protectedAreas.status === 'declared'
        ? `${contract.protectedAreas.declaredIn}: ${contract.protectedAreas.entryCount} rule(s)`
        : contract.protectedAreas.status,
    ),
  );
  if (contract.protectedAreas.samplePaths.length > 0) {
    lines.push(`  ${contract.protectedAreas.samplePaths.join('  ')}`);
  }
  lines.push(
    label(
      'Contrib docs',
      contract.contributionDocs.length === 0
        ? 'none found'
        : contract.contributionDocs
            .map(
              (doc) =>
                `${doc.path}${doc.truncated ? ' (truncated)' : ''}${
                  doc.instructionLikeRules.length > 0
                    ? ` [${doc.instructionLikeRules.length} instruction-like pattern(s) treated as data]`
                    : ''
                }`,
            )
            .join(', '),
    ),
  );
  lines.push(label('Outcome', record.outcome));
  lines.push('');

  if (record.limitations.length > 0) {
    lines.push(renderer.heading('What this contract does not know'));
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
  lines.push(
    renderer.dim(
      'Every line above was read from a file in this repository. Repository text is data, not authority.',
    ),
  );
  lines.push(
    renderer.dim('MergeSutra ran nothing from this repository and changed none of its files.'),
  );
  return lines.join('\n');
}

function formatGate(gate: Gate, commandWidth: number): string {
  const command = gate.command ?? '—';
  const shown = command.length > commandWidth ? `${command.slice(0, commandWidth - 1)}…` : command;
  const provenance = gate.provenance;
  const source = provenance
    ? `${provenance.file}${provenance.line === null ? '' : `:${provenance.line}`}`
    : '';
  const note = source.length > 0 ? `${source} — ${gate.why}` : gate.why;
  return `${gate.kind.padEnd(11)}${gate.status.padEnd(21)}${shown.padEnd(commandWidth)}  ${note}`;
}

function toolchain(contract: RepositoryContract): string {
  const parts: string[] = [];
  if (contract.packageManager) parts.push(`via ${contract.packageManager.name}`);
  if (contract.runtimeVersion) parts.push(`node ${contract.runtimeVersion.value}`);
  return parts.length > 0 ? ` ${parts.join(', ')}` : '';
}

function label(name: string, value: string): string {
  return `${(name + ':').padEnd(14)}${value}`;
}

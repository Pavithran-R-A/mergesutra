import path from 'node:path';
import { AppError } from '../core/errors.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import { newestRunId } from '../state/run-selection.js';
import type { RunRecord } from '../state/run-record.js';
import { PRODUCT_NAME } from '../version.js';
import { exitForOutcome } from './exit-codes.js';
import {
  terminalSafeDocument,
  terminalSafeJsonText,
  terminalSafeText,
} from '../security/terminal-safety.js';
import { createRenderer, resolveColor } from './render.js';
import { buildEvidencePack } from '../report/pack.js';
import { writeEvidencePack } from '../report/write.js';

/**
 * `mergesutra report [run-id]` — Stage 8.
 *
 * This command reads a run record, renders it, and puts the rendering next to
 * the record. It does not run a gate, does not re-map a criterion, and does not
 * know how to decide anything: the exit code it returns is the recorded
 * outcome's, so a report of a blocked run is not a success for having been
 * written neatly.
 */

export interface ReportDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
}

export interface ReportCommandOptions {
  readonly json?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly runId?: string;
}

export interface ReportResult {
  readonly runId: string;
  readonly outcome: RunRecord['outcome'];
  readonly dir: string;
  /**
   * The page this command prints: the pack rendered from a display copy of the record,
   * so a stored string cannot start a line of its own. Not the file on disk.
   */
  readonly markdown: string;
  /** The pack's own `report.json` bytes, exactly as written. */
  readonly json: string;
}

export async function runReportStage(
  input: { readonly runId?: string } = {},
  deps: ReportDeps = {},
): Promise<ReportResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? defaultStoreFor(cwd);
  const runId = input.runId ?? (await reportTargetRunId(store));
  const record = await store.load(runId);
  const pack = buildEvidencePack(record);
  const { dir } = await writeEvidencePack(defaultRunStoreRoot(cwd), pack);
  // A second rendering of the same record, made single-line before the pack's rows are
  // built. The pack above is the evidence and keeps every byte the stages filed; this
  // copy is only what the page shows, and it exists because a caveat that carries a
  // newline of its own would otherwise print its second half at column 0, where a
  // reader sees a status row rather than a quoted one.
  const screen = buildEvidencePack(terminalSafeDocument(record));

  return {
    runId,
    outcome: record.outcome,
    dir,
    markdown: screen.files['report.md'],
    json: pack.files['report.json'],
  };
}

export async function reportAction(
  runId: string | undefined,
  options: ReportCommandOptions = {},
  deps: ReportDeps = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<number> {
  const renderer = createRenderer({
    color: resolveColor(options.noColor === true, options.env ?? process.env),
  });
  const result = await runReportStage({ runId }, deps);

  // The files on disk stay exactly as written — they are the evidence — and only this
  // terminal copy is made inert, so a report a human edited cannot take over the screen
  // that is showing it. The markdown is the display rendering described above; the JSON
  // is the pack's own bytes, made inert here rather than per value because a JSON sink
  // has to stay parseable.
  if (options.json) {
    write(terminalSafeJsonText(result.json).trimEnd());
    return exitForOutcome(result.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — evidence report`));
  write('');
  write(terminalSafeText(result.markdown).trimEnd());
  write('');
  write(renderer.dim(`Pack written to ${path.relative(process.cwd(), result.dir) || result.dir}`));
  write(renderer.dim('Written from the run record; this command decided nothing.'));
  return exitForOutcome(result.outcome);
}

function defaultStoreFor(cwd: string): RunStore {
  // The same directory the pack is written into, so a report and its record
  // cannot drift apart on which machine's working directory they mean.
  return createFileRunStore(defaultRunStoreRoot(cwd));
}

async function reportTargetRunId(store: RunStore): Promise<string> {
  const newest = await newestRunId(store);
  if (!newest) {
    throw new AppError({
      kind: 'validation',
      message: 'No run has been recorded here, so there is nothing to report.',
      remediation: 'Start one with `mergesutra issue <url>`, then ask for its report.',
    });
  }
  return newest;
}

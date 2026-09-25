import path from 'node:path';
import { AppError } from '../core/errors.js';
import { createFileRunStore, defaultRunStoreRoot, type RunStore } from '../state/run-store.js';
import type { RunRecord } from '../state/run-record.js';
import { PRODUCT_NAME } from '../version.js';
import { exitForOutcome } from './exit-codes.js';
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
  readonly markdown: string;
  readonly json: string;
}

export async function runReportStage(
  input: { readonly runId?: string } = {},
  deps: ReportDeps = {},
): Promise<ReportResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? defaultStoreFor(cwd);
  const runId = input.runId ?? (await newestRunId(store));
  const record = await store.load(runId);
  const pack = buildEvidencePack(record);
  const { dir } = await writeEvidencePack(defaultRunStoreRoot(cwd), pack);

  return {
    runId,
    outcome: record.outcome,
    dir,
    markdown: pack.files['report.md'],
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

  if (options.json) {
    write(result.json.trimEnd());
    return exitForOutcome(result.outcome);
  }

  write(renderer.heading(`${PRODUCT_NAME} — evidence report`));
  write('');
  write(result.markdown.trimEnd());
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

async function newestRunId(store: RunStore): Promise<string> {
  const { runs } = await store.list();
  const newest = runs[0];
  if (!newest) {
    throw new AppError({
      kind: 'validation',
      message: 'No run has been recorded here, so there is nothing to report.',
      remediation: 'Start one with `mergesutra issue <url>`, then ask for its report.',
    });
  }
  return newest.runId;
}

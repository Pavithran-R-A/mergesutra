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
import {
  acquireRunLock,
  releaseRunLock,
  type Release,
  type RunLockDeps,
  type RunLockHandle,
} from '../lifecycle/lock.js';

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
  /** Where the pack and the run lock live; defaults to the run store's own root. */
  readonly runsRoot?: string;
  readonly lock?: RunLockDeps;
  /**
   * True when the caller already holds this run's lock.
   *
   * `resume` dispatches this stage while it holds one. A second acquisition in the
   * same process would be refused as its own holder, and a reporter that released it
   * would remove a lock it did not create, so the caller says it has it.
   */
  readonly lockHeldByCaller?: boolean;
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
  /** `null` when the caller already held the lock; otherwise whether this call let it go. */
  readonly lockReleased: boolean | null;
  /** Why the lock stayed, when it did — the sentence a person needs to act on. */
  readonly lockLeftBecause: string | null;
}

export async function runReportStage(
  input: { readonly runId?: string } = {},
  deps: ReportDeps = {},
): Promise<ReportResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? defaultStoreFor(cwd);
  const runsRoot = deps.runsRoot ?? defaultRunStoreRoot(cwd);
  const runId = input.runId ?? (await reportTargetRunId(store));

  // Taken before the record is read: the pack is rendered from what the record says
  // now, so a record that moves under the render would leave a page describing a run
  // that is no longer on disk. A refusal here is `blocked`, not a failure — this
  // command found somebody else's work in progress, not a bad input of its own.
  let handle: RunLockHandle | null = null;
  if (deps.lockHeldByCaller !== true) {
    const acquired = await acquireRunLock(
      { runId, operation: 'report' },
      { ...deps.lock, cwd, runsRoot },
    );
    if (acquired.state !== 'ACQUIRED') {
      throw new AppError({
        kind: 'blocked',
        message: acquired.message,
        remediation:
          `Wait for the other operation on run '${runId}' to finish. If it left the lock ` +
          `behind, \`mergesutra status ${runId}\` names who held it and the path a person ` +
          'can inspect; nothing here removes a lock it did not create.',
        details: { runId, lock: acquired.directory },
      });
    }
    handle = acquired.handle;
  }

  let release: Release | null = null;
  try {
    const record = await store.load(runId);
    const pack = buildEvidencePack(record);
    const { dir } = await writeEvidencePack(runsRoot, pack);
    if (handle) {
      release = await releaseRunLock(handle);
      handle = null;
    }
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
      lockReleased: deps.lockHeldByCaller === true ? null : release?.state === 'RELEASED',
      lockLeftBecause: release?.state === 'LEFT_IN_PLACE' ? release.message : null,
    };
  } finally {
    // Only on the failure path: the success path released above so the answer can say
    // what happened to the lock. A lock that cannot be released is left in place and
    // reported, never deleted by force.
    if (handle) await releaseRunLock(handle);
  }
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
  // A lock this command could not give back blocks the next operation on the run, so
  // the screen says so instead of looking like a clean finish.
  if (result.lockLeftBecause) write(renderer.dim(result.lockLeftBecause));
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

import { AppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import { newestRunId, listRecordNames } from '../state/run-selection.js';
import { defaultRunStoreRoot, createFileRunStore, type RunStore } from '../state/run-store.js';
import { nextActionsFor } from './next-actions.js';
import { observeRun } from './observe.js';
import { readRunLock, type RunLockDeps } from './lock.js';
import { buildStatusSnapshot, type StatusSnapshot } from './snapshot.js';

/**
 * The snapshot behind `mergesutra status`, assembled from disk and Git alone.
 *
 * Three modules above this one already do the thinking: `observe.ts` measures what
 * is here now, `snapshot.ts` puts that beside what the stages recorded, and
 * `next-actions.ts` decides what may honestly be suggested. This file's only job is
 * to run them in the right order against real storage, because that order is the
 * whole command: read a record, measure around it, hand the two to the snapshot.
 *
 * The one thing worth naming is the double build. `buildStatusSnapshot` takes next
 * actions as an *input* rather than deriving them — it has no opinion about routing
 * by design — and routing needs the finished snapshot. So the snapshot is built
 * once without suggestions, fed to `nextActionsFor`, and built again with them.
 * Both builds are pure arithmetic over the same record and the same observation,
 * so the second cannot disagree with the first about anything except which lines
 * are suggested, and the alternative to it would be a second currency module.
 *
 * Nothing here writes. The store is only read, `observeRun` only asks Git questions,
 * and the pack identity is hashed rather than created — which is why this module can
 * be handed a workspace somebody else edited and still be safe to run.
 */

export interface StatusStageInput {
  /**
   * Omitted means "the newest run this store has", by the shared selection — and
   * when a newer record cannot be read, omitted means a refusal, not the older run.
   */
  readonly runId?: string;
  /** A checkout a person pointed at instead of the one the record names. */
  readonly repo?: string;
}

export interface StatusStageDeps {
  readonly store?: RunStore;
  readonly cwd?: string;
  readonly runsRoot?: string;
  readonly run?: Runner;
  readonly now?: () => Date;
  /**
   * Who this machine is, for the lock reading: pid, host, and the liveness probe.
   *
   * Injected rather than defaulted because the answer a lock report gives is a claim
   * about a *process*, and a test that cannot state which process is asking cannot
   * prove the report is not a stub.
   */
  readonly lock?: RunLockDeps;
}

export interface StatusStageResult {
  readonly runId: string;
  readonly snapshot: StatusSnapshot;
}

export async function runStatusStage(
  input: StatusStageInput = {},
  deps: StatusStageDeps = {},
): Promise<StatusStageResult> {
  const cwd = deps.cwd ?? process.cwd();
  const store = deps.store ?? createFileRunStore(defaultRunStoreRoot(cwd));
  const runsRoot = deps.runsRoot ?? defaultRunStoreRoot(cwd);
  const runId = input.runId ?? (await currentRunId(store));
  const record = await store.load(runId);

  const observation = await observeRun({
    record,
    runsRoot,
    cwd,
    run: deps.run ?? defaultRunner,
    ...(input.repo ? { repo: input.repo } : {}),
  });

  // Looked at once, for both builds, so the screen and the suggestions it feeds cannot
  // be built from two different moments. `readRunLock` claims nothing: this is the
  // caller the lock module was written for, and describing a lock here is not taking it.
  const lock = await readRunLock({ runId }, { runsRoot, cwd, ...deps.lock });

  const observedAt = (deps.now ?? (() => new Date()))().toISOString();
  const unsuggested = buildStatusSnapshot({ record, observation, observedAt, lock });

  return {
    runId,
    snapshot: buildStatusSnapshot({
      record,
      observation,
      observedAt,
      lock,
      nextActions: nextActionsFor(unsuggested),
    }),
  };
}

/**
 * One rule, shared: which run an omitted id means.
 *
 * §2 asks that an omitted run id resolve "the newest relevant" run by existing
 * rules, and the existing rule is the shared selection in `state/run-selection`,
 * which reads the store's readable list *and* its unreadable list as one
 * question: a directory holding a newer record this build cannot parse is a
 * directory that does not know which run is current, and this says so instead of
 * showing the older screen. What is *not* done here is any cross-repository
 * guessing: this store is the one for the working directory the command was run
 * from, and a run belonging to another repository is not made relevant by being
 * recent.
 */
async function currentRunId(store: RunStore): Promise<string> {
  const chosen = await newestRunId(store);
  if (chosen) return chosen;
  const { unreadable } = await store.list();
  if (unreadable.length > 0) {
    // The directory is not empty and saying it were would send a person to look for
    // a run that is sitting right there. What is reported is the names, because the
    // bytes behind them are the thing this build cannot promise is safe to print —
    // an older record may hold anything its author put in it, and §27 forbids both
    // quoting it back and quietly repairing it so the command can proceed. A long
    // history of them is listed up to a point and then counted, because one error
    // line should not become a wall.
    throw new AppError({
      kind: 'validation',
      message:
        `None of the ${String(unreadable.length)} run record(s) here can be read by this build: ` +
        `${listRecordNames(unreadable.map((entry) => entry.file))}.`,
      remediation:
        'Name a run with `mergesutra status <run-id>`. This command will not rewrite or repair an unreadable record in order to read it.',
    });
  }
  throw new AppError({
    kind: 'validation',
    message: 'No run has been recorded here, so there is no status to show.',
    remediation:
      'Start one with `mergesutra issue <url>`, or name a run: `mergesutra status <run-id>`.',
  });
}

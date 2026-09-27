import path from 'node:path';
import { AppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import { defaultRunStoreRoot, createFileRunStore, type RunStore } from '../state/run-store.js';
import { nextActionsFor } from './next-actions.js';
import { observeRun } from './observe.js';
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
  /** Omitted means "the newest run this store has", by the store's own ordering. */
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
  const runId = input.runId ?? (await newestRunId(store));
  const record = await store.load(runId);

  const observation = await observeRun({
    record,
    runsRoot,
    cwd,
    run: deps.run ?? defaultRunner,
    ...(input.repo ? { repo: input.repo } : {}),
  });

  const observedAt = (deps.now ?? (() => new Date()))().toISOString();
  const unsuggested = buildStatusSnapshot({ record, observation, observedAt });

  return {
    runId,
    snapshot: buildStatusSnapshot({
      record,
      observation,
      observedAt,
      nextActions: nextActionsFor(unsuggested),
    }),
  };
}

/**
 * The store's own newest-first ordering, reused rather than re-invented.
 *
 * §2 asks that an omitted run id resolve "the newest relevant" run by existing
 * rules, and the existing rule is `list()`, which already sorts by recorded
 * creation time and already reports what it could not read. What is *not* done
 * here is any cross-repository guessing: this store is the one for the working
 * directory the command was run from, and a run belonging to another repository
 * is not made relevant by being recent.
 */
async function newestRunId(store: RunStore): Promise<string> {
  const { runs, unreadable } = await store.list();
  const newest = runs[0];
  if (newest) return newest.runId;
  if (unreadable.length > 0) {
    // The directory is not empty and saying it were would send a person to look for
    // a run that is sitting right there. What is reported is the names, because the
    // bytes behind them are the thing this build cannot promise is safe to print —
    // an older record may hold anything its author put in it, and §27 forbids both
    // quoting it back and quietly repairing it so the command can proceed. A long
    // history of them is listed up to a point and then counted, because one error
    // line should not become a wall.
    const named = unreadable.slice(0, 5).map((entry) => path.basename(entry.file));
    const rest = unreadable.length - named.length;
    throw new AppError({
      kind: 'validation',
      message:
        `None of the ${String(unreadable.length)} run record(s) here can be read by this build: ` +
        `${named.join(', ')}${rest > 0 ? `, and ${String(rest)} more` : ''}.`,
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

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { assertSafePathSegment, isCaseInsensitivePlatform } from '../security/path-safety.js';
import { parseRunRecord, type RunRecord } from './run-record.js';

/**
 * Where a run's belief state lives on disk.
 *
 * Writes go to a temporary file and are renamed into place, so an interrupted
 * process cannot leave a half-written record that the next run trusts. Run ids
 * are validated before they touch the filesystem: a run id is an untrusted
 * string, and `..` in one would otherwise become a write outside the run
 * directory.
 */

export interface RunSummary {
  readonly runId: string;
  readonly createdAt: string;
  readonly outcome: RunRecord['outcome'];
  readonly canonical: string;
  readonly file: string;
}

export interface UnreadableRun {
  readonly file: string;
  readonly reason: string;
}

export interface RunListResult {
  readonly runs: readonly RunSummary[];
  /** Files we found but could not trust — reported, never quietly skipped. */
  readonly unreadable: readonly UnreadableRun[];
}

export interface RunStore {
  save(record: RunRecord): Promise<string>;
  load(runId: string): Promise<RunRecord>;
  list(): Promise<RunListResult>;
}

export const RUN_STATE_DIRNAME = '.mergesutra';

/**
 * Saves that would share one scratch path are run one after another.
 *
 * Every save of a run id stages at `<target>.<pid>.tmp`, which is what lets a save
 * that fails at the rename be cleaned up by the next one. Two saves of that run
 * running at once in one process would therefore write two records into one file
 * and race two renames over it. Production's own call sites save once per stage
 * boundary, so this does not arise there — but a durability boundary should not
 * depend on a caller promise it does not enforce.
 *
 * The key is the resolved target, case-folded on the platforms whose filesystems
 * fold names, so two spellings of one file share one queue instead of two. Two
 * spellings that reach one file through different symlinked roots are still two
 * keys, and a second process is a different pid with a different scratch name:
 * neither is serialised here. The run lock spans one `resume` only and stage saves
 * do not take it, so two processes saving one run are not ordered at all: the target
 * ends up with whichever rename succeeded last, and a losing rename can fail on its
 * own — Windows refuses one over a target another handle holds open. This queue
 * makes no cross-process claim.
 */
const saveQueues = new Map<string, Promise<void>>();

function saveKey(target: string): string {
  const resolved = path.resolve(target);
  return isCaseInsensitivePlatform() ? resolved.toLowerCase() : resolved;
}

function saveInTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  saveQueues.set(key, tail);
  void tail.then(() => {
    if (saveQueues.get(key) === tail) saveQueues.delete(key);
  });
  return next;
}

export function defaultRunStoreRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, RUN_STATE_DIRNAME, 'runs');
}

export function createFileRunStore(root: string = defaultRunStoreRoot()): RunStore {
  return {
    async save(record) {
      const runId = assertSafePathSegment(record.runId, 'run id');
      const target = fileForRun(root, runId);
      return saveInTurn(saveKey(target), async () => {
        await mkdir(root, { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, target);
        return target;
      });
    },

    async load(runId) {
      const safeId = assertSafePathSegment(runId, 'run id');
      const file = fileForRun(root, safeId);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (cause) {
        throw new AppError({
          kind: 'not-found',
          message: `No run record '${safeId}' in ${root}.`,
          remediation: 'Run `mergesutra issue <url>` first, or list the run directory.',
          cause,
        });
      }
      return parseRunRecord(json(text, file));
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return { runs: [], unreadable: [] };
      }
      const runs: RunSummary[] = [];
      const unreadable: UnreadableRun[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(root, name);
        try {
          // The name is as untrusted as the bytes: it arrives from a directory a
          // person, a restore, or another tool may have put anything into. A stem
          // that cannot be a run id is reported through the same channel as a file
          // that cannot be parsed, so one stray name leaves the readable runs listed
          // instead of taking down every screen that asks which runs exist.
          const runId = assertSafePathSegment(name.slice(0, -'.json'.length), 'run file name');
          const record = parseRunRecord(json(await readFile(file, 'utf8'), file));
          runs.push({
            runId,
            createdAt: record.createdAt,
            outcome: record.outcome,
            canonical: record.issueRef?.canonical ?? '(no issue)',
            file,
          });
        } catch (error) {
          unreadable.push({
            file,
            reason:
              error instanceof Error
                ? (error.message.split('\n')[0] ?? 'unreadable')
                : 'unreadable',
          });
        }
      }
      runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return { runs, unreadable };
    },
  };
}

function fileForRun(root: string, runId: string): string {
  return path.join(root, `${runId}.json`);
}

function json(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AppError({
      kind: 'validation',
      message: `Run file is not valid JSON: ${path.basename(file)}`,
      remediation: 'Delete the corrupt run file or start a fresh run.',
      cause,
    });
  }
}

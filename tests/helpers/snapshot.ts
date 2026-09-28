import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStatusSnapshot, type SafeNextAction } from '../../src/lifecycle/snapshot.js';
import { readRunLock, type RunLockDeps } from '../../src/lifecycle/lock.js';
import { observeRun } from '../../src/lifecycle/observe.js';
import { cleanUp, NOW } from './plan.js';
import type { Runner } from '../../src/core/runner.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * A snapshot taken the way the CLI would take it: observe, read the lock, then build.
 *
 * Stage 11's tests all want the same three steps over a fixture run, and the
 * alternative — each file re-writing the set — is three places for the
 * observation's input to drift out of agreement with the command's.
 *
 * The lock is *looked up*, never assumed free. A helper that filled the field with an
 * `UNHELD` reading would make every Stage 11 snapshot silently answer "nobody is here",
 * which is the exact bug S12-05 exists to close, and would hide it from every test that
 * uses this file.
 */
export async function snapshotOf(
  record: RunRecord,
  runsRoot: string,
  extra: {
    repo?: string;
    nextActions?: readonly SafeNextAction[];
    /** A Git that will not answer, for a lifecycle whose patch cannot be measured. */
    run?: Runner;
    /** Who this test process is, for a fixture that plants a lock. */
    lock?: RunLockDeps;
  } = {},
) {
  const observation = await observeRun({
    record,
    runsRoot,
    cwd: record.local?.toplevel ?? runsRoot,
    repo: extra.repo,
    run: extra.run,
  });
  const lock = await readRunLock({ runId: record.runId }, { runsRoot, ...extra.lock });
  return buildStatusSnapshot({
    record,
    observation,
    observedAt: NOW.toISOString(),
    lock,
    nextActions: extra.nextActions ?? [],
  });
}

/** An empty directory to stand in for a run store. */
export async function scratch(prefix: string, tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export { cleanUp };

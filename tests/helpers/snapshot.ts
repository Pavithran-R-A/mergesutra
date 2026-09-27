import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStatusSnapshot, type SafeNextAction } from '../../src/lifecycle/snapshot.js';
import { observeRun } from '../../src/lifecycle/observe.js';
import { cleanUp, NOW } from './plan.js';
import type { Runner } from '../../src/core/runner.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * A snapshot taken the way the CLI would take it: observe, then build.
 *
 * Stage 11's tests all want the same two steps over a fixture run, and the
 * alternative — each file re-writing the pair — is three places for the
 * observation's input to drift out of agreement with the command's.
 */
export async function snapshotOf(
  record: RunRecord,
  runsRoot: string,
  extra: {
    repo?: string;
    nextActions?: readonly SafeNextAction[];
    /** A Git that will not answer, for a lifecycle whose patch cannot be measured. */
    run?: Runner;
  } = {},
) {
  const observation = await observeRun({
    record,
    runsRoot,
    cwd: record.local?.toplevel ?? runsRoot,
    repo: extra.repo,
    run: extra.run,
  });
  return buildStatusSnapshot({
    record,
    observation,
    observedAt: NOW.toISOString(),
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

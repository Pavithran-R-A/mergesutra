import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRunRecord,
  newRunId,
  type NewRunRecordInput,
  type RunRecord,
} from '../../src/state/run-record.js';
import { createFileRunStore, type RunStore } from '../../src/state/run-store.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';

/**
 * Two saves of one run id in one process (audit finding F02).
 *
 * `save` stages every record at `${target}.${pid}.tmp` and renames it into place.
 * The name carries the pid but nothing per-save, so two concurrent saves of the
 * same run compute one scratch path: one rename takes the file the other is about
 * to rename, and the loser fails with a raw ENOENT although its record was written.
 *
 * The first save is held inside `writeFile` — after the path is chosen, before any
 * byte is written — and the second is started while it is held. Without
 * serialisation the second save reaches the same scratch path immediately, which
 * `startsWithin` observes and the assertion fails; with the queue it cannot start
 * until the first save has settled. Holding at the syscall rather than racing two
 * unpaused saves is what makes the reproduction deterministic: the earlier version
 * of this file relied on scheduling and passed on the unfixed source whenever the
 * first rename happened to win.
 *
 * Production saves once per stage boundary, so the collision is not reachable
 * through the CLI today. It is pinned here because `save` is the durability
 * boundary for a run's whole belief state, and its atomicity should not rest on a
 * caller promise it does not enforce.
 */

interface Gate {
  readonly hold: Promise<void>;
  readonly reached: Promise<void>;
  release(): void;
  markReached(): void;
}

const gates = vi.hoisted(() => new Map<string, Gate>());
const writes = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const write = real.writeFile as (...args: unknown[]) => Promise<unknown>;
  return {
    ...real,
    async writeFile(...args: unknown[]) {
      const file = String(args[0]);
      writes.push(file);
      const gate = gates.get(file);
      if (gate !== undefined) {
        // One-shot: only the save the test armed is held.
        gates.delete(file);
        gate.markReached();
        await gate.hold;
      }
      return write(...args);
    },
  };
});

let root: string;
let store: RunStore;

beforeEach(async () => {
  gates.clear();
  writes.length = 0;
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-runs-concurrent-'));
  store = createFileRunStore(path.join(root, 'runs'));
});

afterEach(async () => {
  gates.clear();
  await rm(root, { recursive: true, force: true });
});

function record(overrides: Partial<NewRunRecordInput> = {}): RunRecord {
  return createRunRecord({
    runId: newRunId(new Date('2026-09-24T21:32:07.000Z'), () => 0.25),
    createdAt: '2026-09-24T21:32:07.000Z',
    stage: 'intake',
    outcome: 'INTAKE_COMPLETE',
    issueRef: {
      ...TEST_REPO,
      number: 123,
      canonical: 'projectbharat/datekit#123',
      url: 'https://x',
    },
    issue: toIssueDocument(issuePayload),
    repository: toRepositoryIdentity(repositoryPayload, TEST_REPO),
    base: {
      sha: '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182',
      shortSha: '3f2a1c9d8e',
      source: 'local-git',
    },
    local: null,
    contract: null,
    checks: [],
    nextStage: 'DISCOVERY',
    limitations: [],
    ...overrides,
  });
}

function reasonOf(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? String(result.reason) : 'fulfilled';
}

function blockWritesTo(file: string): { readonly reached: Promise<void>; release(): void } {
  let release!: () => void;
  let markReached!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  gates.set(file, { hold, reached, release, markReached });
  return { reached, release };
}

/** Watch for another start at `file` for a bounded interval, without pausing it. */
async function startsWithin(
  file: string,
  milliseconds: number,
): Promise<'started' | 'not-started'> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (writes.includes(file)) return 'started';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return writes.includes(file) ? 'started' : 'not-started';
}

describe('createFileRunStore save concurrency', () => {
  it('holds a second save of one run behind the first instead of racing its scratch', async () => {
    const base = record();
    const scratch = path.join(root, 'runs', `${base.runId}.json.${process.pid}.tmp`);
    const gate = blockWritesTo(scratch);

    const first = store.save(base);
    await gate.reached;
    // The first save's own write is already recorded; observe what comes next.
    writes.length = 0;

    const second = store.save({ ...base, outcome: 'INCONCLUSIVE' } as RunRecord);
    const observed = await startsWithin(scratch, 300);

    // Release before asserting so a failing run still cleans both saves up.
    gate.release();
    const [a, b] = await Promise.allSettled([first, second]);

    expect(observed, 'the second save entered writeFile while the first was still held there').toBe(
      'not-started',
    );
    expect(a.status, `first save: ${reasonOf(a)}`).toBe('fulfilled');
    expect(b.status, `second save: ${reasonOf(b)}`).toBe('fulfilled');

    const loaded = await store.load(base.runId);
    expect(['INTAKE_COMPLETE', 'INCONCLUSIVE']).toContain(loaded.outcome);
    expect(writes.filter((entry) => entry === scratch)).toHaveLength(1);
    const names = await readdir(path.join(root, 'runs'));
    expect(names.filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

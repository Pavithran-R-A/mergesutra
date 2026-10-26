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
import { isCaseInsensitivePlatform } from '../../src/security/path-safety.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';

/**
 * The queue that serialises one run's saves (audit finding F02, review follow-up).
 *
 * The reproduction of the collision itself lives in `run-store-concurrent.test.ts`.
 * This file pins the three properties a queue can fail that a single concurrent
 * pair cannot show:
 *
 * 1. **A failed save cannot poison the queue.** The next save of the same run must
 *    run, not inherit the previous rejection as a reason to wait forever.
 * 2. **The queue is per run, not global.** A save held inside `writeFile` for one
 *    run must not delay a save of an unrelated run.
 * 3. **Two spellings of one file share one queue** on the platforms whose
 *    filesystems fold names; otherwise the queue protects the string and not the
 *    file it names.
 *
 * The hold is injected by wrapping `writeFile` for one exact scratch path and
 * delegating everything else to the real module, so the bytes on disk are real. As
 * with the collision itself, production's call sites save once at a stage boundary
 * and the per-run operation lock keeps a second process out; these are the module's
 * own guarantees, not a claim about the CLI.
 */

interface Gate {
  readonly hold: Promise<void>;
  readonly reached: Promise<void>;
  release(): void;
  markReached(): void;
}

const gates = vi.hoisted(() => new Map<string, Gate>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const write = real.writeFile as (...args: unknown[]) => Promise<unknown>;
  return {
    ...real,
    async writeFile(...args: unknown[]) {
      const gate = gates.get(String(args[0]));
      if (gate !== undefined) {
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
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-runs-queue-'));
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

function targetOf(runId: string): string {
  return path.join(root, 'runs', `${runId}.json`);
}

function scratchOf(runId: string): string {
  return `${targetOf(runId)}.${process.pid}.tmp`;
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

/** Resolve to `settled` only if `work` finishes within `milliseconds`. */
async function settlesWithin(work: Promise<unknown>, milliseconds: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('waiting'), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('the run store save queue', () => {
  it('does not let a failed save block the next save of the same run', async () => {
    const base = record();
    // JSON.stringify refuses a BigInt before any file is touched, which fails the
    // queued task without leaving scratch the next save would have to cope with.
    const unserialisable = { ...base, outcome: 1n } as unknown as RunRecord;

    await expect(store.save(unserialisable)).rejects.toThrow(/BigInt|serialize/i);
    await expect(store.save(base)).resolves.toBe(targetOf(base.runId));
    expect((await store.load(base.runId)).outcome).toBe('INTAKE_COMPLETE');
    expect((await readdir(path.join(root, 'runs'))).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('does not make a save of one run wait for another run', async () => {
    const held = record({ runId: 'run-queue-probe-held' });
    const other = record({ runId: 'run-queue-probe-other', outcome: 'INCONCLUSIVE' });
    const gate = blockWritesTo(scratchOf(held.runId));

    const first = store.save(held);
    await gate.reached;

    // A global queue would hold this save behind the gated one. The timeout turns
    // that mistake into a failure instead of a suite that waits for its deadline.
    const second = await Promise.race([
      store.save(other),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('a save of another run waited for the held one')), 2000);
      }),
    ]);

    expect(second).toBe(targetOf(other.runId));
    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstSettled, 'the held save should not have finished before its release').toBe(false);

    gate.release();
    await expect(first).resolves.toBe(targetOf(held.runId));
    expect((await store.load(held.runId)).outcome).toBe('INTAKE_COMPLETE');
  });

  it.skipIf(!isCaseInsensitivePlatform())(
    'shares one queue between spellings of a run id that name one file',
    async () => {
      const held = record({ runId: 'run-case-probe' });
      const otherSpelling = record({ runId: 'RUN-CASE-PROBE', outcome: 'INCONCLUSIVE' });
      const gate = blockWritesTo(scratchOf(held.runId));

      const first = store.save(held);
      await gate.reached;
      const second = store.save(otherSpelling);

      expect(
        await settlesWithin(second, 300),
        'a case-only spelling wrote through the held file',
      ).toBe('waiting');

      gate.release();
      await expect(first).resolves.toBe(targetOf(held.runId));
      await expect(second).resolves.toBe(targetOf(otherSpelling.runId));
    },
  );
});

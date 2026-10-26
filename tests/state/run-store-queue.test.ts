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
 * 1. **A failed save cannot poison the queue.** A save that dies at its rename
 *    leaves its scratch behind; the next save of the same run must run — not wait
 *    forever on the rejection — and must reuse and rename that scratch.
 * 2. **The queue is per run, not global.** A save held inside `writeFile` for one
 *    run must not delay a save of an unrelated run.
 * 3. **Two spellings of one file share one queue** on the platforms whose
 *    filesystems fold names; otherwise the queue protects the string and not the
 *    file it names. Whether the second save began is read from the `mkdir` every
 *    save issues as its first call, recorded by the mock on entry, so the answer
 *    does not depend on a timer. The write count still folds names, because the
 *    second save constructs its scratch string from the other spelling.
 *
 * The hold and the rename failure are injected by wrapping those two calls and
 * delegating everything else to the real module, so the bytes on disk are real. As
 * with the collision itself, production's call sites save once at a stage boundary;
 * these are the module's own guarantees, not a claim about the CLI.
 */

interface Gate {
  readonly hold: Promise<void>;
  readonly reached: Promise<void>;
  release(): void;
  markReached(): void;
}

const gates = vi.hoisted(() => new Map<string, Gate>());
const writes = vi.hoisted(() => [] as string[]);
const dirs = vi.hoisted(() => [] as string[]);
const renameFaults = vi.hoisted(() => new Map<string, number>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const write = real.writeFile as (...args: unknown[]) => Promise<unknown>;
  const make = real.mkdir as (...args: unknown[]) => Promise<unknown>;
  const move = real.rename as (...args: unknown[]) => Promise<unknown>;
  return {
    ...real,
    async mkdir(...args: unknown[]) {
      dirs.push(String(args[0]));
      return make(...args);
    },
    async writeFile(...args: unknown[]) {
      const file = String(args[0]);
      writes.push(file);
      const gate = gates.get(file);
      if (gate !== undefined) {
        gate.markReached();
        await gate.hold;
      }
      return write(...args);
    },
    async rename(...args: unknown[]) {
      const from = String(args[0]);
      const remaining = renameFaults.get(from) ?? 0;
      if (remaining > 0) {
        if (remaining === 1) renameFaults.delete(from);
        else renameFaults.set(from, remaining - 1);
        throw Object.assign(new Error(`injected rename failure for ${from}`), { code: 'EIO' });
      }
      return move(...args);
    },
  };
});

let root: string;
let store: RunStore;

beforeEach(async () => {
  gates.clear();
  writes.length = 0;
  dirs.length = 0;
  renameFaults.clear();
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-runs-queue-'));
  store = createFileRunStore(path.join(root, 'runs'));
});

afterEach(async () => {
  gates.clear();
  renameFaults.clear();
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

function failRenameOnce(from: string): void {
  renameFaults.set(from, 1);
}

/**
 * Let microtasks and one macrotask turn run; an unqueued save issues its first
 * call — the `mkdir` every save begins with — in that turn.
 */
async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('the run store save queue', () => {
  it('does not let a failed save block the next save of the same run', async () => {
    const base = record();
    const scratch = scratchOf(base.runId);
    // Dying at the rename is the failure that leaves something behind: the bytes
    // reached the scratch, the target was never replaced. The next save has to run
    // anyway, and has to reuse and rename that same artefact.
    failRenameOnce(scratch);

    await expect(store.save(base)).rejects.toThrow(/injected rename failure/);
    expect(
      await readdir(path.join(root, 'runs')),
      'the failed save should have left exactly its own scratch',
    ).toEqual([path.basename(scratch)]);

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
      const scratch = scratchOf(held.runId);
      const gate = blockWritesTo(scratch);

      const first = store.save(held);
      await gate.reached;
      // Observe only what the second save does from here on.
      writes.length = 0;
      const dirsBefore = dirs.length;

      const second = store.save(otherSpelling);
      await turn();
      const started = dirs.length > dirsBefore;

      gate.release();
      await expect(first).resolves.toBe(targetOf(held.runId));
      await expect(second).resolves.toBe(targetOf(otherSpelling.runId));

      expect(
        started,
        'a case-only spelling reached the held scratch path while the first save held it',
      ).toBe(false);
      expect(
        writes.filter((entry) => entry.toLowerCase() === scratch.toLowerCase()),
        'the second save should stage exactly once at that name',
      ).toHaveLength(1);
    },
  );
});

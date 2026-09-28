import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  createRunRecord,
  newRunId,
  type NewRunRecordInput,
  type RunRecord,
} from '../../src/state/run-record.js';
import { createFileRunStore, type RunStore } from '../../src/state/run-store.js';
import { newestRunId } from '../../src/state/run-selection.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';

/**
 * S12-08 — what the run directory holds when a save fails.
 *
 * `createFileRunStore` writes a temporary file and renames it into place, which is a
 * claim about a window: the target is either the old record or the new one, never a
 * mixture. This file puts a failure into each step of that claim — the run directory
 * cannot be made, the temp file cannot be written, the disk fills partway through the
 * temp, the process is interrupted after the temp lands, the rename is refused, the
 * write is denied on permission — and at every one of them asserts the same three
 * properties: the record that was on disk before is byte-for-byte the record on disk
 * after, the failure reaches the caller instead of being swallowed, and `list()` does
 * not mistake an artefact of the failed save for a run.
 *
 * The filesystem view is injected by faulting `node:fs/promises` around calls, which
 * delegates to the real module for everything it is not faulting; the bytes on disk
 * are real, and the fault is only the moment a syscall says no. Every assertion about
 * those bytes goes through `node:fs`, which carries no fault at all — a durability
 * claim cannot be proved through the same seam that was made to fail.
 *
 * What this file does *not* prove, and the docs do not claim: nothing in
 * `src/state/run-store.ts` calls `fsync`. `src/security/writer.ts:162` syncs a handle
 * before it renames; the run store does not, so a save that returns only says the
 * bytes reached the operating system. A power loss or a device reset is outside what
 * this build promises.
 */

const fault = vi.hoisted(() => ({
  window: null as string | null,
  code: 'EIO',
  attempted: [] as string[],
}));

/** The windows a save can fail in, named after the line that fails. */
type FaultWindow =
  'mkdir' | 'temp-write' | 'temp-write-partial' | 'temp-permission' | 'before-rename' | 'rename';

vi.mock('node:fs/promises', async (importOriginal) => {
  // A type-only import: erased before runtime, so it names the real module's shape
  // without reaching through the mock this factory installs.
  const real = await importOriginal<typeof fsPromises>();
  const call =
    (name: 'mkdir' | 'writeFile' | 'rename') =>
    (...args: unknown[]): Promise<unknown> =>
      (real[name] as (...a: unknown[]) => Promise<unknown>)(...args);
  const injected = (label: string, target: unknown): NodeJS.ErrnoException => {
    const error = new Error(
      `${fault.code}: injected ${label} failure on ${String(target)}`,
    ) as NodeJS.ErrnoException;
    error.code = fault.code;
    return error;
  };
  const at = (window: FaultWindow): boolean => fault.window === window;

  return {
    ...real,
    async mkdir(...args: unknown[]) {
      fault.attempted.push('mkdir');
      if (at('mkdir')) throw injected('mkdir', args[0]);
      return call('mkdir')(...args);
    },
    async writeFile(...args: unknown[]) {
      fault.attempted.push('writeFile');
      const [file, data] = args as [string, string];
      if (at('temp-write')) throw injected('writeFile', file);
      if (at('temp-permission')) throw injected('writeFile', file);
      if (at('temp-write-partial')) {
        // What a full disk leaves: the prefix that made it before the write failed.
        await call('writeFile')(file, data.slice(0, Math.floor(data.length / 3)), 'utf8');
        throw injected('writeFile partway', file);
      }
      const written = await call('writeFile')(...args);
      if (at('before-rename')) throw injected('interruption after the temp landed', file);
      return written;
    },
    async rename(...args: unknown[]) {
      fault.attempted.push('rename');
      if (at('rename')) throw injected('rename', args[1]);
      return call('rename')(...args);
    },
  };
});

let root: string;
let dir: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mergesutra-store-faults-'));
  dir = path.join(root, 'runs');
  store = createFileRunStore(dir);
  fault.window = null;
  fault.code = 'EIO';
  fault.attempted = [];
});

afterEach(() => {
  // Created by this test process and removed by it; nothing outside `root` is touched.
  rmSync(root, { recursive: true, force: true });
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
    checks: [{ name: 'Issue URL', status: 'PASS', detail: 'projectbharat/datekit#123' }],
    nextStage: 'DISCOVERY',
    limitations: [],
    ...overrides,
  });
}

/** The record a save is *trying* to file: same run, one more check than the last one. */
function nextAttempt(): RunRecord {
  return record({
    checks: [
      { name: 'Issue URL', status: 'PASS', detail: 'projectbharat/datekit#123' },
      { name: 'Later stage', status: 'PASS', detail: 'the save that is about to fail' },
    ],
  });
}

const targetOf = (runId: string): string => path.join(dir, `${runId}.json`);
/** The name `run-store.ts` gives its scratch file: the target, this process's id, `.tmp`. */
const tempOf = (runId: string): string => `${targetOf(runId)}.${String(process.pid)}.tmp`;

function strayFiles(): string[] {
  return readdirSync(dir).filter((name) => !name.endsWith('.json'));
}

/**
 * Arm a window and start the call log fresh, so an assertion about which steps a
 * save attempted describes that save and not the setup that preceded it.
 */
function arm(window: FaultWindow, code: string): void {
  fault.attempted = [];
  fault.window = window;
  fault.code = code;
}

async function expectRejected(save: Promise<unknown>, code: string): Promise<Error> {
  const error = await save.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  const failure = error as Error;
  // The failure reaches the caller with the filesystem's own code on it: the store
  // does not catch a fault and hand back a path as though the rename had happened.
  expect((failure as NodeJS.ErrnoException).code).toBe(code);
  expect(failure.message.length).toBeGreaterThan(0);
  return failure;
}

describe('run-store save failures', () => {
  it('leaves the previous record untouched when the run directory cannot be created', async () => {
    const first = record();
    await store.save(first);
    const before = readFileSync(targetOf(first.runId));
    const listing = readdirSync(dir);

    arm('mkdir', 'EPERM');
    await expectRejected(store.save(nextAttempt()), 'EPERM');

    expect(fault.attempted).toEqual(['mkdir']);
    expect(readFileSync(targetOf(first.runId))).toEqual(before);
    expect(readdirSync(dir)).toEqual(listing);
    expect(await store.load(first.runId)).toEqual(first);
  });

  it('leaves no artefact behind when the temp file cannot be written', async () => {
    const first = record();
    await store.save(first);
    const before = readFileSync(targetOf(first.runId));

    arm('temp-write', 'ENOSPC');
    const next = nextAttempt();
    await expectRejected(store.save(next), 'ENOSPC');

    expect(fault.attempted).toEqual(['mkdir', 'writeFile']);
    expect(readFileSync(targetOf(first.runId))).toEqual(before);
    expect(strayFiles()).toEqual([]);
    expect((await store.list()).runs.map((run) => run.runId)).toEqual([first.runId]);
  });

  it('reports a denied write as a denial and keeps the record that was there', async () => {
    const first = record();
    await store.save(first);
    const before = readFileSync(targetOf(first.runId));

    arm('temp-permission', 'EACCES');
    await expectRejected(store.save(nextAttempt()), 'EACCES');

    expect(readFileSync(targetOf(first.runId))).toEqual(before);
    expect(strayFiles()).toEqual([]);
    // A refusal is not retried into the target: one attempt at the write, no rename.
    expect(fault.attempted).toEqual(['mkdir', 'writeFile']);
  });

  it('leaves a truncated temp file that no reader mistakes for a run', async () => {
    const first = record();
    await store.save(first);
    const before = readFileSync(targetOf(first.runId));

    arm('temp-write-partial', 'ENOSPC');
    const next = nextAttempt();
    await expectRejected(store.save(next), 'ENOSPC');

    const temp = tempOf(next.runId);
    // First the property that matters: the record that was there is still there.
    expect(readFileSync(targetOf(first.runId))).toEqual(before);
    expect(readdirSync(dir).includes(path.basename(temp))).toBe(true);
    const half = readFileSync(temp, 'utf8');
    expect(half.length).toBeGreaterThan(0);
    // The bytes that landed are a third of a record: unreadable by anything,
    // including the store that would have owned them.
    expect(() => JSON.parse(half)).toThrow();

    const listed = await store.list();
    expect(listed.runs.map((run) => run.file)).toEqual([targetOf(first.runId)]);
    expect(listed.unreadable).toEqual([]);
    expect(await store.load(first.runId)).toEqual(first);
  });

  it('does not list a complete temp file that never reached the rename', async () => {
    const fresh = record();
    arm('before-rename', 'ERR_INTERRUPTION');
    await expectRejected(store.save(fresh), 'ERR_INTERRUPTION');

    expect(fault.attempted).toEqual(['mkdir', 'writeFile']);
    const temp = tempOf(fresh.runId);
    // The whole record is on disk and nothing about it is a run: it was never filed.
    expect(JSON.parse(readFileSync(temp, 'utf8')).runId).toBe(fresh.runId);
    expect(readdirSync(dir)).toEqual([path.basename(temp)]);

    const listed = await store.list();
    expect(listed.runs).toEqual([]);
    expect(listed.unreadable).toEqual([]);
    const missing = await store.load(fresh.runId).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect((missing as AppError).kind).toBe('not-found');
  });

  it('keeps the old bytes in place when the rename is refused, and files on a later try', async () => {
    const first = record();
    await store.save(first);
    const before = readFileSync(targetOf(first.runId));

    arm('rename', 'EPERM');
    const next = nextAttempt();
    await expectRejected(store.save(next), 'EPERM');

    expect(fault.attempted).toEqual(['mkdir', 'writeFile', 'rename']);
    expect(readFileSync(targetOf(first.runId))).toEqual(before);
    expect(await store.load(first.runId)).toEqual(first);
    const listed = await store.list();
    expect(listed.runs.map((run) => run.runId)).toEqual([first.runId]);

    // The next save of the same run recovers, and it recovers through the very
    // scratch name the refused save left: the retry overwrites and renames it, so a
    // stale artefact can neither shadow the record nor outlive the next filing.
    fault.window = null;
    await store.save(next);
    expect(JSON.parse(readFileSync(targetOf(next.runId), 'utf8'))).toEqual(next);
    expect(strayFiles()).toEqual([]);
    expect((await store.list()).runs).toHaveLength(1);
  });

  it('fails the same way without a mock, when a directory sits where the temp file goes', async () => {
    const first = record();
    await store.save(first);
    const before = readFileSync(targetOf(first.runId));
    mkdirSync(tempOf(first.runId));

    const error = await store.save(nextAttempt()).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    // Which code a real filesystem gives for "that path is a directory" is the
    // platform's choice; that the save stops there is the claim under test.
    expect(['EISDIR', 'EPERM', 'ENOTDIR', 'UNKNOWN']).toContain(
      (error as NodeJS.ErrnoException).code,
    );
    expect(readFileSync(targetOf(first.runId))).toEqual(before);
    expect(await store.load(first.runId)).toEqual(first);
    expect((await store.list()).runs.map((run) => run.runId)).toEqual([first.runId]);
  });

  it('never names a leftover temp holding another run’s bytes as a run of its own', async () => {
    mkdirSync(dir, { recursive: true });
    const ghost = record({ runId: 'run-20260101T000000Z-zzzzzz' });
    writeFileSync(path.join(dir, 'run-20260101T000000Z-zzzzzz.9999.tmp'), JSON.stringify(ghost));
    const first = record();
    await store.save(first);

    const listed = await store.list();
    expect(listed.runs.map((run) => run.runId)).toEqual([first.runId]);
    // An artefact is invisible to `list()`, not merely rejected: the record it holds
    // is complete and parseable and still names no run.
    expect(listed.unreadable).toEqual([]);
    expect(
      JSON.parse(readFileSync(path.join(dir, 'run-20260101T000000Z-zzzzzz.9999.tmp'), 'utf8')),
    ).toMatchObject({ runId: ghost.runId });
  });
});

describe('run-store listing of files that cannot be runs', () => {
  it('reports a name that cannot be a run id instead of failing the whole listing', async () => {
    const first = record();
    await store.save(first);
    for (const name of ['.json', '_draft.json', 'run..x.json']) {
      writeFileSync(path.join(dir, name), '{}', 'utf8');
    }

    const listed = await store.list();
    expect(listed.runs.map((run) => run.runId)).toEqual([first.runId]);
    expect(listed.unreadable.map((entry) => path.basename(entry.file)).sort()).toEqual([
      '.json',
      '_draft.json',
      'run..x.json',
    ]);
    for (const entry of listed.unreadable) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it('routes a stray name into the refusal that already covers an unreadable record', async () => {
    const first = record();
    await store.save(first);
    writeFileSync(path.join(dir, '.json'), '{}', 'utf8');

    // `newestRunId` is how every command without an explicit run id chooses one. With
    // the stray file reported rather than fatal, it answers the way S12-06 decided it
    // must: refuse to call any run current, and name the file that cannot be dated.
    const error = await newestRunId(store).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toContain('Cannot tell which run is current');
    expect((error as AppError).message).toContain('.json');
    expect((error as AppError).remediation).toContain(first.runId);
  });
});

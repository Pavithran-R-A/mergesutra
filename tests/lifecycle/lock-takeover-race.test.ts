import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireRunLock,
  type Acquisition,
  type RunLockDeps,
  type RunLockMetadata,
  releaseRunLock,
  runLockDirectory,
} from '../../src/lifecycle/lock.js';
import { cleanUp } from '../helpers/plan.js';

/**
 * The one race this lock can lose, and the proof it does not.
 *
 * A contender decides in two steps: it reads the owner record and proves the holder
 * gone, then it claims the takeover with a second atomic `mkdir`. Between those two
 * steps the world is allowed to change, and the change that matters is exactly the
 * one this file plants — another process that also proved the holder gone, finished
 * its takeover, and removed the claim directory behind it. A contender that arrives
 * after that finds no claim to collide with, wins one, and is holding a lock that
 * somebody else is already using. Two `ACQUIRED` answers for one run is the failure
 * this module exists to prevent, and it is worse than a false refusal: the winner
 * keeps mutating the workspace while the disk says somebody else owns it.
 *
 * So the claim has to be *held*, not just won. Everything below drives a contender
 * into the window through `beforeTakeoverClaim` — an await that changes no decision —
 * so the interleaving is arranged rather than waited for. No test here sleeps, and no
 * test here depends on which `mkdir` the operating system happens to serve first.
 *
 * The crash half of the matrix is pinned too, because it is the same window seen from
 * the other side: a process that dies after claiming and before writing leaves a
 * claim behind, and a leftover claim must block, never be cleared by the next arrival.
 */

const tempDirs: string[] = [];
const HOST = 'this-host';
const DEAD_TOKEN = 'd'.repeat(32);
const DEAD_PID = 1234;

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function runsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mergesutra-lock-race-'));
  tempDirs.push(root);
  return root;
}

/** A holder this machine can prove gone, planted the way an exited process leaves it. */
function deadOwner(runId: string, over: Partial<RunLockMetadata> = {}): RunLockMetadata {
  return {
    runId,
    operation: 'resume',
    pid: DEAD_PID,
    host: HOST,
    createdAt: '2026-09-26T00:00:00.000Z',
    token: DEAD_TOKEN,
    ...over,
  };
}

async function plantLock(root: string, runId: string, owner: RunLockMetadata): Promise<string> {
  const directory = runLockDirectory(root, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'owner.json'),
    `${JSON.stringify(owner, null, 2)}\n`,
    'utf8',
  );
  return directory;
}

async function ownerFile(directory: string): Promise<RunLockMetadata> {
  return JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')) as RunLockMetadata;
}

function depsFor(root: string, over: Partial<RunLockDeps> = {}): RunLockDeps {
  return {
    runsRoot: root,
    host: HOST,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
    // Only the planted holders are dead; every process competing here is live.
    isProcessAlive: (pid) => pid !== DEAD_PID,
    ...over,
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

type Acquired = Extract<Acquisition, { state: 'ACQUIRED' }>;

async function acquired(promise: Promise<Acquisition>): Promise<Acquired> {
  const result = await promise;
  if (result.state !== 'ACQUIRED') {
    throw new Error(
      `expected the lock, got ${result.state}: ${'message' in result ? result.message : 'no message'}`,
    );
  }
  return result;
}

async function blocked(
  promise: Promise<Acquisition>,
): Promise<Extract<Acquisition, { state: 'BLOCKED' }>> {
  const result = await promise;
  if (result.state !== 'BLOCKED') {
    throw new Error(
      `expected to be blocked, got ${result.state}` +
        (result.state === 'ACQUIRED'
          ? ` — a second process believes it owns this run (token ${result.handle.token})`
          : ''),
    );
  }
  return result;
}

describe('a takeover two contenders both proved', () => {
  it('refuses the contender that arrives after the lock was already taken over', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-late', deadOwner('run-late'));
    const arrived = deferred();
    const released = deferred();

    // Late arrives first: it has proved the holder gone and stopped before claiming.
    const late = acquireRunLock(
      { runId: 'run-late' },
      depsFor(root, {
        pid: 4004,
        beforeTakeoverClaim: () => {
          arrived.resolve();
          return released.promise;
        },
      }),
    );
    await arrived.promise;

    // Winner arrives second and finishes a takeover while Late is standing in the window.
    const winner = await acquired(
      acquireRunLock({ runId: 'run-late' }, depsFor(root, { pid: 3003 })),
    );

    released.resolve();
    const loser = await blocked(late);

    expect(loser.reason).toBe('HELD_BY_LIVE_PROCESS');
    // The refusal is honest about who is really here: the process that took over.
    expect(loser.holding.owner?.pid).toBe(3003);
    expect(loser.message).toContain('3003');

    // The disk names one owner, and it is the winner's — not the late claimant's.
    expect(await ownerFile(directory)).toMatchObject({ pid: 3003, token: winner.handle.token });
    // Claiming is not deleting: the claim is put down, and nothing else is touched.
    expect(await readdir(directory)).toEqual(['owner.json']);

    // A handle that is refused is not a handle that has been given.
    const release = await releaseRunLock(winner.handle);
    expect(release.state).toBe('RELEASED');
    expect(await readdir(root)).toEqual([]);
  });

  it('gives a chain of late arrivals the same single answer', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-chain', deadOwner('run-chain'));
    const firstArrived = deferred();
    const firstReleased = deferred();
    const secondArrived = deferred();
    const secondReleased = deferred();

    const first = acquireRunLock(
      { runId: 'run-chain' },
      depsFor(root, {
        pid: 2002,
        beforeTakeoverClaim: () => {
          firstArrived.resolve();
          return firstReleased.promise;
        },
      }),
    );
    await firstArrived.promise;

    const second = acquireRunLock(
      { runId: 'run-chain' },
      depsFor(root, {
        pid: 2121,
        beforeTakeoverClaim: () => {
          secondArrived.resolve();
          return secondReleased.promise;
        },
      }),
    );
    await secondArrived.promise;

    firstReleased.resolve();
    const taken = await acquired(first);
    secondReleased.resolve();
    const refused = await blocked(second);

    expect(refused.reason).toBe('HELD_BY_LIVE_PROCESS');
    expect(await ownerFile(directory)).toMatchObject({ pid: 2002, token: taken.handle.token });
    expect(await readdir(directory)).toEqual(['owner.json']);
  });

  it('takes over the holder that was on the record when the claim was won', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-relay', deadOwner('run-relay'));
    const arrived = deferred();
    const released = deferred();
    // A second crash: another process held this run and died too, after Late looked.
    const laterDead = deadOwner('run-relay', { pid: 5555, token: 'e'.repeat(32) });

    const got = acquireRunLock(
      { runId: 'run-relay' },
      depsFor(root, {
        pid: 6006,
        isProcessAlive: (pid) => pid !== DEAD_PID && pid !== 5555,
        beforeTakeoverClaim: () => {
          arrived.resolve();
          return released.promise;
        },
      }),
    );
    await arrived.promise;
    await writeFile(
      path.join(directory, 'owner.json'),
      `${JSON.stringify(laterDead, null, 2)}\n`,
      'utf8',
    );
    released.resolve();

    const acquired_ = await acquired(got);
    // The evidence carried forward is the record this process actually broke into,
    // not the one it read before anyone else had died.
    expect(await ownerFile(directory)).toMatchObject({
      pid: 6006,
      token: acquired_.handle.token,
      brokenFrom: { pid: 5555, token: 'e'.repeat(32) },
    });
  });

  it('blocks on a claim a crashed takeover left behind, and clears nothing', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-leftover', deadOwner('run-leftover'));
    await mkdir(path.join(directory, 'takeover'));

    const got = await blocked(
      acquireRunLock({ runId: 'run-leftover' }, depsFor(root, { pid: 7007 })),
    );

    expect(got.reason).toBe('TAKEOVER_IN_PROGRESS');
    expect(got.message).toContain(directory);
    // A leftover claim is somebody else's decision, so it stays exactly where it was.
    expect(await readdir(directory)).toEqual(['owner.json', 'takeover']);
    expect(await ownerFile(directory)).toMatchObject({ pid: DEAD_PID, token: DEAD_TOKEN });
  });

  it('names the live holder when a leftover claim sits behind a lock that is held', async () => {
    const root = await runsRoot();
    const directory = await plantLock(
      root,
      'run-held-over',
      deadOwner('run-held-over', { pid: 8008, token: 'f'.repeat(32) }),
    );
    await mkdir(path.join(directory, 'takeover'));

    const got = await blocked(
      acquireRunLock({ runId: 'run-held-over' }, depsFor(root, { pid: 9009 })),
    );

    // The lock is held by a live process, and that is the useful answer — not the
    // claim directory, which is a mark a dead decision left.
    expect(got.reason).toBe('HELD_BY_LIVE_PROCESS');
    expect(await readdir(directory)).toEqual(['owner.json', 'takeover']);
  });
});

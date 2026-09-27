import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileRunStore } from '../../src/state/run-store.js';
import {
  acquireRunLock,
  type Acquisition,
  type RunLockDeps,
  type Release,
  type RunLockMetadata,
  readRunLock,
  releaseRunLock,
  runLockDirectory,
} from '../../src/lifecycle/lock.js';
import { cleanUp } from '../helpers/plan.js';

/**
 * One run, one lifecycle mutation at a time — proved on the filesystem.
 *
 * The claim these tests hold the code to is narrow but load-bearing: `resume` can
 * write, so two processes resuming the same run would edit the same workspace and
 * the same record. An in-memory mutex cannot cover that, because the two processes
 * are not in the same memory. So a lock is a *directory*, created with one atomic
 * `mkdir`, holding one owner record that says who is here and why.
 *
 * The other half of the claim is what a lock does when it cannot be taken: it
 * blocks, names the path it is blocking on, and leaves every byte alone. A stale
 * lock is only called stale when this machine can prove the holder is gone; a lock
 * this build cannot read, cannot reach across hosts to check, or finds in an
 * unexpected shape is left exactly as it was found. Nothing here has a `--force`
 * path, so "the lock is uncertain" must resolve into a person with a filesystem,
 * not into a deletion.
 *
 * Process liveness is injected for everything except one test that uses a real
 * exited process, so the default probe cannot become a stub that always answers
 * "alive".
 */

const tempDirs: string[] = [];
const HOST = 'this-host';
const DEAD_TOKEN = 'd'.repeat(32);

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function runsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mergesutra-lock-'));
  tempDirs.push(root);
  return root;
}

function depsFor(root: string, over: Partial<RunLockDeps> = {}): RunLockDeps {
  return {
    runsRoot: root,
    host: HOST,
    pid: 11_000,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
    // Every planted holder is live unless a test says otherwise: a lock is never
    // broken because a test forgot to answer.
    isProcessAlive: () => true,
    ...over,
  };
}

function ownerOf(runId: string, over: Partial<RunLockMetadata> = {}): RunLockMetadata {
  return {
    runId,
    operation: 'resume',
    pid: 4_321,
    host: HOST,
    createdAt: '2026-09-26T00:00:00.000Z',
    token: DEAD_TOKEN,
    ...over,
  };
}

/** A lock directory planted by hand, as an earlier process or a person would leave it. */
async function plantLock(
  root: string,
  runId: string,
  owner: RunLockMetadata | string | null,
): Promise<string> {
  const directory = runLockDirectory(root, runId);
  await mkdir(directory, { recursive: true });
  if (owner !== null) {
    await writeFile(
      path.join(directory, 'owner.json'),
      typeof owner === 'string' ? owner : `${JSON.stringify(owner, null, 2)}\n`,
      'utf8',
    );
  }
  return directory;
}

async function ownerFile(directory: string): Promise<RunLockMetadata> {
  return JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')) as RunLockMetadata;
}

/** Every path and byte under a root, so "unchanged" means unchanged. */
async function fingerprint(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`dir ${relative}`);
        await walk(path.join(directory, entry.name), relative);
      } else {
        lines.push(`file ${relative} ${await readFile(path.join(directory, entry.name), 'utf8')}`);
      }
    }
  };
  await walk(root, '');
  return lines.join('\n');
}

type Acquired = Extract<Acquisition, { state: 'ACQUIRED' }>;
type Blocked = Extract<Acquisition, { state: 'BLOCKED' }>;
type Held = Extract<Release, { state: 'LEFT_IN_PLACE' }>;

async function acquired(promise: Promise<Acquisition>): Promise<Acquired> {
  const result = await promise;
  if (result.state !== 'ACQUIRED') {
    throw new Error(`expected the lock, got ${result.state}: ${result.message}`);
  }
  return result;
}

async function blocked(promise: Promise<Acquisition>): Promise<Blocked> {
  const result = await promise;
  if (result.state !== 'BLOCKED') {
    throw new Error(`expected to be blocked, got ${result.state}`);
  }
  return result;
}

function leftInPlace(release: Release): Held {
  if (release.state !== 'LEFT_IN_PLACE') {
    throw new Error(`expected the lock left in place, got ${release.state}`);
  }
  return release;
}

describe('a per-run lock', () => {
  it('creates one lock directory that says who is here and why', async () => {
    const root = await runsRoot();

    const got = await acquired(
      acquireRunLock({ runId: 'run-plain' }, depsFor(root, { pid: 4242, host: 'holder-host' })),
    );

    expect(got.directory).toBe(runLockDirectory(root, 'run-plain'));
    expect(await readdir(root)).toEqual(['run-plain.lock']);
    const owner = await ownerFile(got.directory);
    expect(owner).toMatchObject({
      runId: 'run-plain',
      operation: 'resume',
      pid: 4242,
      host: 'holder-host',
      createdAt: '2026-09-27T00:00:00.000Z',
    });
    expect(owner.token).toMatch(/^[0-9a-f]{32}$/);
    // A lock taken in the normal way replaces nobody.
    expect(owner.brokenFrom ?? null).toBe(null);
  });

  it('refuses a run id that is not a file name, and writes nothing at all', async () => {
    const root = await runsRoot();

    await expect(acquireRunLock({ runId: '../elsewhere' }, depsFor(root))).rejects.toThrow(
      /Refusing to use run id/,
    );

    expect(await readdir(root)).toEqual([]);
  });

  it('blocks a second process on the same run and tells the human where the lock is', async () => {
    const root = await runsRoot();
    const first = await acquired(acquireRunLock({ runId: 'run-two' }, depsFor(root, { pid: 1 })));
    const before = await fingerprint(root);

    const second = await blocked(
      acquireRunLock({ runId: 'run-two' }, depsFor(root, { pid: 2, isProcessAlive: () => true })),
    );

    expect(second.reason).toBe('HELD_BY_LIVE_PROCESS');
    expect(second.holding.owner?.pid).toBe(1);
    expect(second.message).toContain(first.directory);
    // Blocked is not "half-acquired": not one byte of the held lock moves.
    expect(await fingerprint(root)).toBe(before);
  });

  it('says so plainly when it is this same process asking twice', async () => {
    const root = await runsRoot();
    await acquired(acquireRunLock({ runId: 'run-same' }, depsFor(root, { pid: 700 })));

    const again = await blocked(acquireRunLock({ runId: 'run-same' }, depsFor(root, { pid: 700 })));

    expect(again.reason).toBe('HELD_BY_THIS_PROCESS');
    expect(again.message).toContain('This process');
  });

  it('lets the next process through once the lock is released', async () => {
    const root = await runsRoot();
    const first = await acquired(acquireRunLock({ runId: 'run-hero' }, depsFor(root, { pid: 1 })));
    expect(
      (await blocked(acquireRunLock({ runId: 'run-hero' }, depsFor(root, { pid: 2 })))).state,
    ).toBe('BLOCKED');

    expect((await releaseRunLock(first.handle)).state).toBe('RELEASED');
    expect(await readdir(root)).toEqual([]);

    const second = await acquired(
      acquireRunLock(
        { runId: 'run-hero' },
        depsFor(root, { pid: 2, now: () => new Date('2026-09-27T00:05:00.000Z') }),
      ),
    );
    expect(await ownerFile(second.directory)).toMatchObject({ pid: 2 });
  });

  it('will not release a lock that somebody else has since taken', async () => {
    const root = await runsRoot();
    const mine = await acquired(acquireRunLock({ runId: 'run-steal' }, depsFor(root, { pid: 1 })));
    // Another process proved this one gone and claimed the run.
    await writeFile(
      path.join(mine.directory, 'owner.json'),
      `${JSON.stringify(ownerOf('run-steal', { pid: 99, token: 'e'.repeat(32) }), null, 2)}\n`,
      'utf8',
    );

    const release = await releaseRunLock(mine.handle);

    expect(leftInPlace(release).reason).toBe('NOT_OURS');
    expect(await ownerFile(mine.directory)).toMatchObject({ pid: 99, token: 'e'.repeat(32) });
  });

  it('will not release into a lock directory that holds no owner record', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-empty', null);
    const handle = {
      directory,
      runId: 'run-empty',
      operation: 'resume' as const,
      token: 'a'.repeat(32),
    };

    const release = await releaseRunLock(handle);

    expect(leftInPlace(release).reason).toBe('UNEXPECTED_CONTENT');
    expect(await readdir(directory)).toEqual([]);
  });

  it('leaves a lock directory holding something this build did not write', async () => {
    const root = await runsRoot();
    const got = await acquired(acquireRunLock({ runId: 'run-extra' }, depsFor(root)));
    const stranger = path.join(got.directory, 'someone-else.json');
    await writeFile(stranger, 'not mine\n', 'utf8');
    const before = await fingerprint(root);

    const release = await releaseRunLock(got.handle);

    expect(leftInPlace(release).reason).toBe('UNEXPECTED_CONTENT');
    expect(leftInPlace(release).message).toContain(got.directory);
    expect(await fingerprint(root)).toBe(before);
  });

  it('blocks on a lock directory with no owner record and deletes nothing', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-nobody', null);

    const got = await blocked(acquireRunLock({ runId: 'run-nobody' }, depsFor(root)));

    expect(got.reason).toBe('OWNER_UNREADABLE');
    expect(got.message).toContain(directory);
    expect(await readdir(root)).toEqual(['run-nobody.lock']);
  });

  it('blocks on an owner record it cannot trust, without probing a pid', async () => {
    const root = await runsRoot();
    const probes: number[] = [];
    const cases: readonly (readonly [string, RunLockMetadata | string])[] = [
      ['run-garbage', '{ not json'],
      ['run-wrong-run', ownerOf('a-different-run')],
      ['run-negative-pid', ownerOf('run-negative-pid', { pid: -1 })],
      ['run-zero-pid', ownerOf('run-zero-pid', { pid: 0 })],
      ['run-huge-pid', ownerOf('run-huge-pid', { pid: 2 ** 31 })],
      ['run-bad-token', ownerOf('run-bad-token', { token: 'not-a-token' })],
      ['run-extra-field', ownerOf('run-extra-field', { operation: 'reset' as 'resume' })],
    ];
    const planted: string[] = [];
    for (const [runId, owner] of cases) {
      planted.push(await plantLock(root, runId, owner));
    }
    const before = await fingerprint(root);

    for (const [runId] of cases) {
      const got = await blocked(
        acquireRunLock(
          { runId },
          depsFor(root, {
            isProcessAlive: (pid) => {
              probes.push(pid);
              return true;
            },
          }),
        ),
      );
      expect(got.reason).toBe('OWNER_UNREADABLE');
      // The human gets the path, because only a person can settle what it means.
      expect(got.message).toContain(runLockDirectory(root, runId));
    }

    expect(probes).toEqual([]);
    expect(await fingerprint(root)).toBe(before);
    expect(planted.length).toBe(cases.length);
  });

  it('never calls a lock on another host stale, because it cannot check one', async () => {
    const root = await runsRoot();
    const probes: number[] = [];
    const directory = await plantLock(
      root,
      'run-remote',
      ownerOf('run-remote', { host: 'another-machine' }),
    );

    const got = await blocked(
      acquireRunLock(
        { runId: 'run-remote' },
        depsFor(root, {
          isProcessAlive: (pid) => {
            probes.push(pid);
            return false;
          },
        }),
      ),
    );

    expect(got.reason).toBe('HELD_ON_ANOTHER_HOST');
    expect(got.holding.liveness).toBe('UNKNOWABLE');
    expect(got.holding.owner?.host).toBe('another-machine');
    expect(probes).toEqual([]);
    expect(await readFile(path.join(directory, 'owner.json'), 'utf8')).toContain(DEAD_TOKEN);
  });

  it('takes over a lock whose holder this machine proves is gone, and records whose lock it broke', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-crash', ownerOf('run-crash', { pid: 1234 }));

    const got = await acquired(
      acquireRunLock(
        { runId: 'run-crash' },
        depsFor(root, { pid: 5678, isProcessAlive: (pid) => pid !== 1234 }),
      ),
    );

    expect(got.tookOverGoneLock).toBe(true);
    const owner = await ownerFile(directory);
    expect(owner).toMatchObject({ pid: 5678, host: HOST });
    expect(owner.token).not.toBe(DEAD_TOKEN);
    // The dead holder is not erased: its record is carried inside the new one.
    expect(owner.brokenFrom).toMatchObject({ pid: 1234, token: DEAD_TOKEN });
    // The claim this build used to take over is cleaned up behind it.
    expect(await readdir(directory)).toEqual(['owner.json']);
  });

  it('hands a contested stale lock to exactly one process', async () => {
    const root = await runsRoot();
    const directory = await plantLock(root, 'run-race', ownerOf('run-race', { pid: 1234 }));
    const live = (pid: number) => pid !== 1234;

    const [left, right] = await Promise.all([
      acquireRunLock({ runId: 'run-race' }, depsFor(root, { pid: 3003, isProcessAlive: live })),
      acquireRunLock({ runId: 'run-race' }, depsFor(root, { pid: 4004, isProcessAlive: live })),
    ]);

    const winners = [left, right].filter((one) => one.state === 'ACQUIRED');
    expect(winners.length).toBe(1);
    const loser = left.state === 'ACQUIRED' ? right : left;
    expect(loser.state).toBe('BLOCKED');

    const winner = winners[0] as Acquired;
    expect(await readdir(directory)).toEqual(['owner.json']);
    expect((await ownerFile(directory)).token).toBe(winner.handle.token);
  });

  it('detects a real exited process without being told it exited', async () => {
    const root = await runsRoot();
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    if (typeof dead !== 'number') throw new Error('could not start a throwaway process');
    await plantLock(root, 'run-real', ownerOf('run-real', { pid: dead, host: os.hostname() }));

    const reading = await readRunLock({ runId: 'run-real' }, { runsRoot: root });

    expect(reading.state).toBe('HELD');
    if (reading.state !== 'HELD') return;
    expect(reading.holding.liveness).toBe('GONE');
    expect(reading.holding.owner?.pid).toBe(dead);

    const got = await acquired(acquireRunLock({ runId: 'run-real' }, { runsRoot: root }));
    expect(got.tookOverGoneLock).toBe(true);
  });

  it('reports a lock without taking one, and says when there is none', async () => {
    const root = await runsRoot();

    expect(await readRunLock({ runId: 'run-free' }, depsFor(root))).toEqual({
      state: 'FREE',
      directory: runLockDirectory(root, 'run-free'),
    });
    // Reading a lock must not become acquiring it, or `status` would block itself.
    expect(await readdir(root)).toEqual([]);

    const directory = await plantLock(root, 'run-free', ownerOf('run-free'));
    const held = await readRunLock({ runId: 'run-free' }, depsFor(root));
    expect(held.state === 'HELD' && held.holding.owner?.token).toBe(DEAD_TOKEN);
    expect(await readdir(root)).toEqual(['run-free.lock']);
    expect(await readdir(directory)).toEqual(['owner.json']);
  });

  it('leaves the run record and the run listing exactly as it found them', async () => {
    const root = await runsRoot();
    const record = path.join(root, 'run-quiet.json');
    await writeFile(record, '{"runId":"run-quiet"}\n', 'utf8');
    const store = createFileRunStore(root);
    const before = await store.list();

    const got = await acquired(acquireRunLock({ runId: 'run-quiet' }, depsFor(root)));
    expect(await readFile(record, 'utf8')).toBe('{"runId":"run-quiet"}\n');
    // A lock directory is not a run, and must never be read as one.
    expect(await store.list()).toEqual(before);

    expect((await releaseRunLock(got.handle)).state).toBe('RELEASED');
    expect(await readdir(root)).toEqual(['run-quiet.json']);
    expect(await store.list()).toEqual(before);
  });

  it('blocks on something that is not a lock and is in its way', async () => {
    const root = await runsRoot();
    const directory = runLockDirectory(root, 'run-file');
    await writeFile(directory, 'a person put a file here\n', 'utf8');

    const got = await blocked(acquireRunLock({ runId: 'run-file' }, depsFor(root)));

    expect(got.reason).toBe('PATH_OCCUPIED');
    expect(got.message).toContain(directory);
    expect(await readFile(directory, 'utf8')).toBe('a person put a file here\n');
  });

  it('grants nothing but the lock itself', async () => {
    const root = await runsRoot();
    const got = await acquired(acquireRunLock({ runId: 'run-power' }, depsFor(root)));

    // The handle is a directory, a token, a run and an operation. It is not a
    // consent, an approval, or a capability of any kind.
    expect(Object.keys(got.handle).sort()).toEqual(['directory', 'operation', 'runId', 'token']);
    expect(await readdir(root)).toEqual(['run-power.lock']);
    expect(await readdir(got.directory)).toEqual(['owner.json']);
  });
});

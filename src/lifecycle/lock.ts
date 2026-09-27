import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { assertSafePathSegment } from '../security/path-safety.js';
import { defaultRunStoreRoot } from '../state/run-store.js';

/**
 * One lifecycle mutation per run, proved on the filesystem rather than in memory.
 *
 * `resume` writes: it can drive the implementation loop, run the repository's gates,
 * and file receipts against the same workspace and the same run record. Two processes
 * doing that to one run is not two attempts that happen to overlap — it is one run's
 * evidence edited by two writers, so the second one's "what is true now" is partly the
 * first one's work. An in-process mutex cannot help, because the two processes do not
 * share memory; the claim has to live somewhere both of them have to pass through, and
 * on this platform that place is `mkdir` of a directory that does not exist yet. It is
 * the one atomic, exclusive, crash-safe primitive both POSIX and Windows give us, and
 * it needs no dependency.
 *
 * So a lock is `<runsRoot>/<runId>.lock/` holding `owner.json` — the run, the
 * operation, the pid, the host, the time, and a random token that lets a release prove
 * it is removing its own lock and not somebody else's. The owner record is written
 * temp-then-rename inside the directory, the same convention the run store uses for
 * its own records, because a half-written owner record is worse than none: it looks
 * like an answer.
 *
 * What this module will not do is the point of it:
 *
 * 1. **It never removes a lock it did not create**, and "did not create" is proved by
 *    the token, not assumed. A lock whose owner record cannot be read, cannot be
 *    reached (another host — liveness there is not knowable from here), names a
 *    different run, or is in an unexpected shape is *blocked on*, with the path in the
 *    message so the answer is a person with a filesystem.
 * 2. **Age is never evidence of death.** A long build is a legitimate lock holder, so
 *    a lock is only called stale when this machine can prove the recorded pid is not a
 *    process any more (`ESRCH`), on the same host, from a record this build can fully
 *    parse. Pid reuse can make a dead holder look alive, which blocks — the safe
 *    direction; nothing here can make a live holder look dead.
 * 3. **Even a proven-dead lock is not deleted.** It is claimed with a second atomic
 *    `mkdir` so exactly one racer can take it, the dead holder's identity is copied
 *    into the new owner record as `brokenFrom`, and the claim is removed behind the
 *    winner. Evidence is carried forward, not thrown away.
 * 4. **Holding the lock authorises nothing else.** It is not execution consent, not
 *    repair consent, not publication approval, and not a remote capability; it does
 *    not write the run record, and `release` is a removal of this module's own
 *    directory and nothing more.
 *
 * Acquisition is single-shot on purpose: this build reports "somebody else is here"
 * immediately rather than waiting, so no test and no runtime depends on a sleep, and
 * the caller gets a true answer about the moment it asked about.
 */

/** The operations that mutate a run's lifecycle. `resume` is the only one in this build. */
export const RUN_LOCK_OPERATIONS = ['resume'] as const;
export type RunLockOperation = (typeof RUN_LOCK_OPERATIONS)[number];

/** The one file a lock directory is allowed to hold. */
export const LOCK_OWNER_FILE_NAME = 'owner.json';

/** A lock file naming a pid this build will not probe is refused, not interpreted. */
const MAX_PID = 2_147_483_647;
const TAKEOVER_NAME = 'takeover';

export interface RunLockOwnerRecord {
  readonly pid: number;
  readonly host: string;
  readonly createdAt: string;
  readonly token: string;
}

export interface RunLockMetadata {
  readonly runId: string;
  readonly operation: RunLockOperation;
  readonly pid: number;
  readonly host: string;
  readonly createdAt: string;
  readonly token: string;
  readonly brokenFrom?: RunLockOwnerRecord;
}

export type LockLiveness = 'ALIVE' | 'GONE' | 'UNKNOWABLE';

export type LockBlockReason =
  | 'HELD_BY_LIVE_PROCESS'
  | 'HELD_BY_THIS_PROCESS'
  | 'HELD_ON_ANOTHER_HOST'
  | 'TAKEOVER_IN_PROGRESS'
  | 'OWNER_UNREADABLE'
  | 'PATH_OCCUPIED';

export interface RunLockHandle {
  readonly directory: string;
  readonly runId: string;
  readonly operation: RunLockOperation;
  readonly token: string;
}

export interface LockHolding {
  readonly directory: string;
  readonly owner: RunLockMetadata | null;
  readonly liveness: LockLiveness | null;
  /** Why this lock could not be read, when it could not be — never raw file contents. */
  readonly why: string | null;
  /** True when the lock path is held by something that is not a lock directory. */
  readonly occupied: boolean;
}

export type LockReading =
  | { readonly state: 'FREE'; readonly directory: string }
  | { readonly state: 'HELD'; readonly holding: LockHolding };

export type Acquisition =
  | {
      readonly state: 'ACQUIRED';
      readonly directory: string;
      readonly tookOverGoneLock: boolean;
      readonly handle: RunLockHandle;
    }
  | {
      readonly state: 'BLOCKED';
      readonly directory: string;
      readonly reason: LockBlockReason;
      readonly holding: LockHolding;
      readonly message: string;
    };

export type Release =
  | { readonly state: 'RELEASED'; readonly directory: string }
  | {
      readonly state: 'LEFT_IN_PLACE';
      readonly directory: string;
      readonly reason: 'NOT_OURS' | 'UNEXPECTED_CONTENT' | 'COULD_NOT_BE_REMOVED';
      readonly message: string;
    };

export interface RunLockInput {
  readonly runId: string;
}

export interface RunLockDeps {
  readonly runsRoot?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly host?: string;
  readonly now?: () => Date;
  /** Process liveness, injected so a test can prove this is not a stub that says "alive". */
  readonly isProcessAlive?: (pid: number) => boolean;
}

const ownerRecordSchema = z
  .object({
    pid: z.number().int().min(1).max(MAX_PID),
    host: z.string().min(1).max(255),
    createdAt: z.string().min(1).max(64),
    token: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

const ownerSchema = z
  .object({
    runId: z.string().min(1).max(80),
    operation: z.enum(RUN_LOCK_OPERATIONS),
    pid: z.number().int().min(1).max(MAX_PID),
    host: z.string().min(1).max(255),
    createdAt: z.string().min(1).max(64),
    token: z.string().regex(/^[0-9a-f]{32}$/),
    brokenFrom: ownerRecordSchema.optional(),
  })
  .strict();

/** Where a run's lock lives, from the same root the run records and the pack live in. */
export function runLockDirectory(runsRoot: string, runId: string): string {
  return path.join(runsRoot, `${assertSafePathSegment(runId, 'run id')}.lock`);
}

export async function acquireRunLock(
  input: RunLockInput,
  deps: RunLockDeps = {},
): Promise<Acquisition> {
  const here = environment(input, deps);
  const block = (reason: LockBlockReason, holding: LockHolding): Acquisition => ({
    state: 'BLOCKED',
    directory: here.directory,
    reason,
    holding,
    message: blockMessage(reason, holding, here),
  });

  await mkdir(here.root, { recursive: true });

  let created: boolean;
  try {
    await mkdir(here.directory);
    created = true;
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
    created = false;
  }

  if (created) {
    const owner = newOwner(here);
    await writeOwner(here.directory, owner);
    return {
      state: 'ACQUIRED',
      directory: here.directory,
      tookOverGoneLock: false,
      handle: handleOf(here.directory, owner),
    };
  }

  const looked = await inspect(here, deps);
  const holding = looked.holding;
  if (holding.occupied) return block('PATH_OCCUPIED', holding);
  if (!holding.owner) return block('OWNER_UNREADABLE', holding);
  if (holding.liveness === 'UNKNOWABLE') return block('HELD_ON_ANOTHER_HOST', holding);
  if (holding.owner.pid === here.pid) return block('HELD_BY_THIS_PROCESS', holding);
  if (holding.liveness === 'ALIVE') return block('HELD_BY_LIVE_PROCESS', holding);

  // Proven gone on this host. The claim directory is what makes two processes that
  // both proved it at the same moment resolve into exactly one new holder.
  const claim = path.join(here.directory, TAKEOVER_NAME);
  try {
    await mkdir(claim);
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw error;
    return block('TAKEOVER_IN_PROGRESS', holding);
  }
  const owner = newOwner(here, {
    pid: holding.owner.pid,
    host: holding.owner.host,
    createdAt: holding.owner.createdAt,
    token: holding.owner.token,
  });
  try {
    await writeOwner(here.directory, owner);
  } finally {
    await rmdir(claim).catch(() => undefined);
  }
  return {
    state: 'ACQUIRED',
    directory: here.directory,
    tookOverGoneLock: true,
    handle: handleOf(here.directory, owner),
  };
}

/**
 * Whether a run is locked, without claiming anything.
 *
 * `status` and a resume preview read through here, so a lock they report is a lock
 * they did not create, touch or remove.
 */
export async function readRunLock(
  input: RunLockInput,
  deps: RunLockDeps = {},
): Promise<LockReading> {
  const here = environment(input, deps);
  const looked = await inspect(here, deps);
  if (!looked.found) return { state: 'FREE', directory: here.directory };
  return { state: 'HELD', holding: looked.holding };
}

/**
 * Remove this handle's lock, if and only if the owner record still names this handle.
 *
 * Anything else in the directory, or a record with somebody else's token, is left
 * exactly as found and reported. Nothing is injected here: a release needs the handle it
 * was given and no view of the machine, so it cannot be talked into removing a lock by
 * a forged pid or host.
 */
export async function releaseRunLock(handle: RunLockHandle): Promise<Release> {
  const directory = handle.directory;
  const left = (
    reason: 'NOT_OURS' | 'UNEXPECTED_CONTENT' | 'COULD_NOT_BE_REMOVED',
    why: string,
  ): Release => ({
    state: 'LEFT_IN_PLACE',
    directory,
    reason,
    message: `The lock at ${directory} ${why}. This build removes nothing else from it.`,
  });

  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return left('NOT_OURS', 'is no longer a lock directory this build can read');
  }
  if (names.length !== 1 || names[0] !== LOCK_OWNER_FILE_NAME) {
    return left('UNEXPECTED_CONTENT', 'does not hold only its own owner record');
  }

  let owner: z.infer<typeof ownerSchema> | undefined;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(directory, LOCK_OWNER_FILE_NAME), 'utf8'),
    );
    const result = ownerSchema.safeParse(parsed);
    if (result.success) owner = result.data;
  } catch {
    owner = undefined;
  }
  if (!owner || owner.token !== handle.token || owner.runId !== handle.runId) {
    return left('NOT_OURS', 'records a different operation as its owner');
  }

  try {
    await unlink(path.join(directory, LOCK_OWNER_FILE_NAME));
    await rmdir(directory);
  } catch {
    return left('COULD_NOT_BE_REMOVED', 'is still held open by this machine');
  }
  return { state: 'RELEASED', directory };
}

interface Environment {
  readonly root: string;
  readonly runId: string;
  readonly directory: string;
  readonly pid: number;
  readonly host: string;
  readonly now: () => Date;
}

function environment(input: RunLockInput, deps: RunLockDeps): Environment {
  const cwd = deps.cwd ?? process.cwd();
  const root = deps.runsRoot ?? defaultRunStoreRoot(cwd);
  const runId = assertSafePathSegment(input.runId, 'run id');
  return {
    root,
    runId,
    directory: runLockDirectory(root, runId),
    pid: deps.pid ?? process.pid,
    host: deps.host ?? os.hostname(),
    now: deps.now ?? (() => new Date()),
  };
}

function newOwner(here: Environment, brokenFrom?: RunLockOwnerRecord): RunLockMetadata {
  return {
    runId: here.runId,
    operation: 'resume',
    pid: here.pid,
    host: here.host,
    createdAt: here.now().toISOString(),
    token: randomBytes(16).toString('hex'),
    ...(brokenFrom ? { brokenFrom } : {}),
  };
}

function handleOf(directory: string, owner: RunLockMetadata): RunLockHandle {
  return { directory, runId: owner.runId, operation: owner.operation, token: owner.token };
}

/** The owner record goes in whole or not at all, exactly the way a run record does. */
async function writeOwner(directory: string, owner: RunLockMetadata): Promise<void> {
  const target = path.join(directory, LOCK_OWNER_FILE_NAME);
  const temp = `${target}.${owner.token.slice(0, 12)}.tmp`;
  await writeFile(temp, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

async function inspect(
  here: Environment,
  deps: RunLockDeps,
): Promise<{ found: boolean; holding: LockHolding }> {
  const hold = (
    found: boolean,
    owner: RunLockMetadata | null,
    liveness: LockLiveness | null,
    why: string | null,
    occupied = false,
  ): { found: boolean; holding: LockHolding } => ({
    found,
    holding: { directory: here.directory, owner, liveness, why, occupied },
  });

  let names: string[];
  try {
    names = await readdir(here.directory);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return hold(false, null, null, 'was gone by the time this process looked at it');
    }
    return hold(true, null, null, 'is something other than a lock directory', true);
  }
  if (!names.includes(LOCK_OWNER_FILE_NAME)) return hold(true, null, null, 'holds no owner record');

  let owner: RunLockMetadata | undefined;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(here.directory, LOCK_OWNER_FILE_NAME), 'utf8'),
    );
    const result = ownerSchema.safeParse(parsed);
    if (result.success) owner = result.data;
  } catch {
    owner = undefined;
  }
  if (!owner) {
    // No contents in the reason: an owner record is somebody else's file.
    return hold(true, null, null, 'is not a lock record this build can read');
  }
  if (owner.runId !== here.runId) {
    return hold(true, null, null, `records itself as run '${owner.runId}', not this run`);
  }
  if (owner.host !== here.host) return hold(true, owner, 'UNKNOWABLE', null);
  if (owner.pid === here.pid) return hold(true, owner, 'ALIVE', null);
  const probe = deps.isProcessAlive ?? processIsAlive;
  return hold(true, owner, probe(owner.pid) ? 'ALIVE' : 'GONE', null);
}

/**
 * Liveness by signal 0: `ESRCH` is a process that is not there, `EPERM` is one that is
 * there and not ours. Anything else is answered as gone, because this function is only
 * ever consulted to decide whether a lock may be *touched*, and an unsure answer must
 * never be the reason a live process loses its lock.
 */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1 || pid > MAX_PID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === 'EPERM';
  }
}

function blockMessage(reason: LockBlockReason, holding: LockHolding, here: Environment): string {
  const owner = holding.owner;
  const where = `at ${here.directory}`;
  const who = owner ? `process ${String(owner.pid)} on host ${owner.host}` : 'an unknown process';
  switch (reason) {
    case 'HELD_BY_THIS_PROCESS':
      return `This process already holds the lock for run '${here.runId}' ${where}. A second lifecycle operation in one process would edit the same evidence twice.`;
    case 'HELD_BY_LIVE_PROCESS':
      return `Run '${here.runId}' is already active: ${who} holds its lock ${where}. This build will not remove a lock it did not create.`;
    case 'HELD_ON_ANOTHER_HOST':
      return `Run '${here.runId}' is locked by ${who}, a machine this one cannot check. The lock is ${where}, and an uncertain lock is left for a person to settle.`;
    case 'TAKEOVER_IN_PROGRESS':
      return `Another process is deciding what to do with the stale lock for run '${here.runId}' ${where}. This build does not make a second decision about the same lock.`;
    case 'PATH_OCCUPIED':
      return `Something that is not a MergeSutra lock is in the way ${where}. Nothing is deleted or overwritten.`;
    case 'OWNER_UNREADABLE':
      return `Run '${here.runId}' has a lock ${where} whose owner record ${holding.why ?? 'cannot be read'}. Nothing is deleted or overwritten; a person has to decide.`;
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

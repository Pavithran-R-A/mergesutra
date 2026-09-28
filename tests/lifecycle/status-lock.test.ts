import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatStatus } from '../../src/cli/status.js';
import { createRenderer } from '../../src/cli/render.js';
import {
  LOCK_OWNER_FILE_NAME,
  runLockDirectory,
  type RunLockDeps,
} from '../../src/lifecycle/lock.js';
import { buildResumePlan } from '../../src/lifecycle/resume-plan.js';
import { runStatusStage } from '../../src/lifecycle/status.js';
import type { StatusSnapshot } from '../../src/lifecycle/snapshot.js';
import { createFileRunStore } from '../../src/state/run-store.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { recordAt } from '../helpers/report.js';

/**
 * Whether a run is locked, on the page a person reads to decide whether to lock it.
 *
 * `resume` refuses to run while another process holds a run's lock, and it says so in
 * the refusal. But the refusal only arrives *after* a person has typed the command — so
 * the screen that exists to answer "is this run free?" silently answered "yes" to the
 * one question it was being asked. The read-only lock reader has existed since Stage 11
 * for exactly this purpose and had no caller.
 *
 * What is on the page is a closed, five-word description: `UNHELD`, `HELD_LIVE`,
 * `HELD_ELSEWHERE`, `HELD_PROVABLY_GONE`, `UNREADABLE`. Those words carry the whole
 * difference between "you can proceed", "somebody is here" and "this machine cannot
 * tell" — so the second is never rendered as the third. An uncertain lock is not a stale
 * lock, and a screen that called it stale would hand a person the one word that makes
 * them delete a live process's claim.
 *
 * Two properties are proved rather than asserted in prose:
 *
 * 1. **Describing a lock is not touching one.** Every held case fingerprints the lock
 *    directory's names and bytes before and after the status call, byte-identical,
 *    including the cases where the contents are a truncated record or a plain file
 *    sitting where a directory belongs. The unheld case proves the reverse direction:
 *    reading created no directory at all.
 * 2. **The release token never reaches a screen.** The token is the proof a release uses
 *    to show it is removing its own lock; printing it turns a status screen into a
 *    capability. It is checked absent from the rendered page *and* from the serialised
 *    snapshot.
 *
 * And the host and time strings in an owner record are somebody else's bytes: they
 * reach a page only when every code point is printable, because a lock file that types
 * `ESC[31m` into a terminal is a lock file giving instructions to the terminal.
 */

const tempDirs: string[] = [];
const RUN_ID = 'run-20260924T000000Z-aaaaaa';
const HOST = 'this-host';
const OUR_PID = 11_000;
const HOLDER_PID = 4_321;
const TOKEN = 'ab'.repeat(16);

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

interface Scene {
  readonly runsRoot: string;
  readonly lockDir: string;
  /** `alive` only decides liveness for a holder on this host that is not this process. */
  read(over?: { alive?: boolean }): Promise<StatusSnapshot>;
}

async function scene(overrides: Parameters<typeof recordAt>[0] = {}): Promise<Scene> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mergesutra-status-lock-'));
  tempDirs.push(cwd);
  const runsRoot = path.join(cwd, '.mergesutra', 'runs');
  const store = createFileRunStore(runsRoot);
  await store.save(
    recordAt({ runId: RUN_ID, createdAt: '2026-09-24T00:00:00.000Z', ...overrides }),
  );
  return {
    runsRoot,
    lockDir: runLockDirectory(runsRoot, RUN_ID),
    read(over = {}) {
      const lock: RunLockDeps = {
        host: HOST,
        pid: OUR_PID,
        // Defaulting to "alive" is the safe direction: a test that forgets to answer
        // must not be the reason a live holder is described as gone.
        isProcessAlive: () => over.alive !== false,
      };
      return runStatusStage({ runId: RUN_ID }, { store, cwd, runsRoot, now: () => NOW, lock }).then(
        (result) => result.snapshot,
      );
    },
  };
}

function owner(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    operation: 'resume',
    pid: HOLDER_PID,
    host: HOST,
    createdAt: '2026-09-26T00:00:00.000Z',
    token: TOKEN,
    ...over,
  };
}

/** Plant a lock the way `acquireRunLock` leaves it: a directory holding one owner record. */
async function plantOwner(target: Scene, over: Record<string, unknown> = {}): Promise<void> {
  await mkdir(target.lockDir, { recursive: true });
  await writeFile(
    path.join(target.lockDir, LOCK_OWNER_FILE_NAME),
    JSON.stringify(owner(over)),
    'utf8',
  );
}

/** Names plus bytes, so "unchanged" means every byte rather than "still there". */
async function fingerprint(directory: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    return '<not a readable directory>';
  }
  const parts: string[] = [];
  for (const name of names) {
    parts.push(`${name}=${await readFile(path.join(directory, name), 'utf8')}`);
  }
  return parts.join('|');
}

async function storeNames(runsRoot: string): Promise<string[]> {
  return (await readdir(runsRoot)).sort();
}

function screenOf(snapshot: StatusSnapshot): string {
  return formatStatus(snapshot, createRenderer({ color: false }));
}

/**
 * The page's lock row and the sentence under it.
 *
 * Narrowed to those lines on purpose: the rest of the screen is other sections'
 * vocabulary, and a negative claim about the lock must not accidentally become a claim
 * about the word `STALE` in some other section's row.
 */
function lockLinesOf(screen: string): string {
  const lines = screen.split('\n');
  const at = lines.findIndex((line) => line.includes('Run lock'));
  expect(at, 'the status screen has a Run lock row').toBeGreaterThan(-1);
  return lines.slice(at, at + 2).join('\n');
}

/**
 * The lines of the page that carry a control character inside them.
 *
 * Checked per line, because the page's own newlines are its structure while a control
 * character *within* a line is something a fixture put there — an escape sequence that
 * restyles the screen, or a `BEL` that names the terminal window.
 */
function unprintableLines(screen: string): string[] {
  return screen.split('\n').filter((line) => {
    for (let i = 0; i < line.length; i += 1) {
      const code = line.codePointAt(i) ?? 0;
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  });
}

function lockRowCount(screen: string): number {
  return screen.split('\n').filter((line) => line.includes('Run lock')).length;
}

describe('the status screen reports whether the run is locked', () => {
  it('reports an unheld run and creates no lock directory by looking', async () => {
    const run = await scene();
    const before = await storeNames(run.runsRoot);

    const snapshot = await run.read();
    const screen = screenOf(snapshot);

    expect(snapshot.lock.state).toBe('UNHELD');
    expect(screen).toContain('UNHELD');
    expect(snapshot.lock.holder).toBeNull();
    // Reading a lock must not claim one: the same directory listing, no `.lock` entry.
    expect(await storeNames(run.runsRoot)).toEqual(before);
    expect(await fingerprint(run.lockDir)).toBe('<not a readable directory>');
  });

  it('names a live holder by process and machine, and never by its release token', async () => {
    const run = await scene();
    await plantOwner(run);
    const before = await fingerprint(run.lockDir);

    const snapshot = await run.read();
    const screen = screenOf(snapshot);

    expect(snapshot.lock.state).toBe('HELD_LIVE');
    expect(screen).toContain('HELD_LIVE');
    expect(lockLinesOf(screen)).toContain(String(HOLDER_PID));
    expect(lockLinesOf(screen)).toContain(HOST);
    expect(snapshot.lock.holder).toMatchObject({
      operation: 'resume',
      pid: HOLDER_PID,
      host: HOST,
    });
    // The token is what proves a release is removing its own lock. Printing it on a
    // screen another process can read hands that process the capability.
    expect(screen).not.toContain(TOKEN);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(await fingerprint(run.lockDir)).toBe(before);
  });

  it('describes a holder on another machine as unknowable, never as stale', async () => {
    const run = await scene();
    await plantOwner(run, { host: 'another-machine' });

    const snapshot = await run.read();
    const lines = lockLinesOf(screenOf(snapshot));

    expect(snapshot.lock.state).toBe('HELD_ELSEWHERE');
    expect(lines).toContain('HELD_ELSEWHERE');
    // Liveness on that host is not a question this machine can answer, so the page may
    // not use a word that implies it answered.
    expect(lines.toLowerCase()).not.toMatch(/stale|gone|not a process|abandoned/);
    expect(lines).toMatch(/another machine|another host|cannot/i);
    expect(snapshot.lock.holder).toMatchObject({ pid: HOLDER_PID, host: 'another-machine' });
  });

  it('reports a holder this machine can prove is gone, and still leaves the lock in place', async () => {
    const run = await scene();
    await plantOwner(run);
    const before = await fingerprint(run.lockDir);

    const snapshot = await run.read({ alive: false });

    expect(snapshot.lock.state).toBe('HELD_PROVABLY_GONE');
    expect(screenOf(snapshot)).toContain('HELD_PROVABLY_GONE');
    // Proving a holder gone is not the same as being allowed to clean up after it:
    // `status` has no act in it, so the directory is exactly as found.
    expect(await fingerprint(run.lockDir)).toBe(before);
  });

  it('reports an owner record it cannot parse as unreadable without quoting it back', async () => {
    const run = await scene();
    await mkdir(run.lockDir, { recursive: true });
    const secret = 'SECRET_TOKEN=a-b-c';
    await writeFile(
      path.join(run.lockDir, LOCK_OWNER_FILE_NAME),
      `{"runId":"${RUN_ID}","token":"${secret}","operation":`,
      'utf8',
    );
    const before = await fingerprint(run.lockDir);

    const snapshot = await run.read();
    const screen = screenOf(snapshot);

    expect(snapshot.lock.state).toBe('UNREADABLE');
    expect(screen).toContain('UNREADABLE');
    expect(screen).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.lock.holder).toBeNull();
    // Nothing repaired, nothing quarantined, nothing removed.
    expect(await fingerprint(run.lockDir)).toBe(before);
  });

  it('reports something that is not a lock directory as unreadable and leaves its bytes alone', async () => {
    const run = await scene();
    const planted = 'a person put a file here\n';
    await writeFile(run.lockDir, planted, 'utf8');

    const snapshot = await run.read();

    expect(snapshot.lock.state).toBe('UNREADABLE');
    expect(screenOf(snapshot)).toContain('UNREADABLE');
    expect(await readFile(run.lockDir, 'utf8')).toBe(planted);
  });

  it('refuses to let a holder timestamp type control characters into the screen', async () => {
    const run = await scene();
    await plantOwner(run, {
      createdAt: '2026-09-26T00:00:00.000Z\u001b[31mAPPROVE THIS RUN\u001b[0m',
    });

    const snapshot = await run.read();
    const screen = screenOf(snapshot);

    expect(snapshot.lock.state).toBe('HELD_LIVE');
    expect(snapshot.lock.holder?.createdAt).toBeNull();
    expect(screen).not.toContain('APPROVE THIS RUN');
    expect(unprintableLines(screen)).toEqual([]);
  });

  it('refuses a holder timestamp whose newline would print a second lock row', async () => {
    const run = await scene();
    await plantOwner(run, { createdAt: '2026-09-26T00:00:00.000Z\n  Run lock UNHELD' });

    const snapshot = await run.read();
    const screen = screenOf(snapshot);

    // A record that can inject a line can forge the one answer this row exists to give,
    // so the row count is the assertion, not the wording.
    expect(snapshot.lock.holder?.createdAt).toBeNull();
    expect(lockRowCount(screen)).toBe(1);
    expect(screen).not.toContain('Run lock UNHELD');
  });

  it('refuses to print a hostile host name that would change what the terminal does', async () => {
    const run = await scene();
    await plantOwner(run, { host: 'x\u001b]0;pwned\u0007' });

    const snapshot = await run.read();

    // The host differs from this one, so this is already an unknowable holder; the
    // point is that an unprintable name is reported as unprintable rather than shown.
    expect(snapshot.lock.holder?.host).toBeNull();
    expect(snapshot.lock.state).toBe('HELD_ELSEWHERE');
    expect(unprintableLines(screenOf(snapshot))).toEqual([]);
  });

  it('keeps the lock out of the digest a resume execution compares against', async () => {
    const run = await scene();
    const unheld = await run.read();
    await plantOwner(run);
    const held = await run.read();

    // `resume --execute` takes the lock *before* re-reading the snapshot, so a lock
    // inside the observed-state digest would expire every plan the instant it was
    // executed. The collision is refused by the lock check itself, not by the digest.
    expect(held.lock.state).toBe('HELD_LIVE');
    expect(unheld.lock.state).toBe('UNHELD');
    expect(buildResumePlan(held).observedStateDigest).toBe(
      buildResumePlan(unheld).observedStateDigest,
    );

    // The control: the digest is not a constant. A run whose recorded facts differ has
    // to hash differently, or the exclusion above would be proved by an empty guard.
    const moved = await scene({ createdAt: '2026-09-24T00:00:01.000Z' });
    expect(buildResumePlan(await moved.read()).observedStateDigest).not.toBe(
      buildResumePlan(unheld).observedStateDigest,
    );
  });
});

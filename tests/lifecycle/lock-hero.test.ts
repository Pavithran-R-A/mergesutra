import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireRunLock, readRunLock, releaseRunLock } from '../../src/lifecycle/lock.js';
import { defaultRunStoreRoot } from '../../src/state/run-store.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { resumeAction, type ResumeCommandDeps } from '../../src/cli/resume.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { cleanUp, hasGit, NOW } from '../helpers/verifyRun.js';
import { reviewedRun } from '../helpers/repairRun.js';

/**
 * §53: two services, one run — the second is refused while the first holds it.
 *
 * The lock's unit tests go case by case through who may be believed dead and what may
 * not be deleted. This file asks the only question a person notices: what happens when
 * two things try to resume the same run. It matters because `resume` writes — it can
 * run the repository's gates and file receipts against one workspace and one record —
 * and two processes doing that is not two attempts that overlap harmlessly. The second
 * one's idea of "what is true now" is partly the first one's work, and an in-process
 * mutex cannot help because they do not share a process.
 *
 * So the sequence is the brief's, in its own words: A acquires, B attempts a resume, B
 * is told the run is already active, A releases, B may proceed. Around that, the two
 * claims that make exclusion worth having. B's refusal has to have *refused* something:
 * no pack written, no record saved, no model asked, and A's lock left holding the same
 * owner it started with — a tool that reported a conflict and then did the work anyway
 * would be worse than one that never checked. And B has to be able to go through after
 * A lets go, with nothing about B changed but the moment it asked.
 *
 * No sleeps, and none of the assertions wait on a timer: acquisition is single-shot, so
 * B's answer is about the instant it asked, and the only sequencing in this file is the
 * order of the calls. The model clients here are tripwires that throw if asked — a
 * recovery path that spent a request on its way to saying "no" would be the exact
 * failure §18 exists to prevent.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

// The fixture at the top of this file is Stage 9R's: a real repository, measured twice
// through Stage 7. Raised for that cost, not for contention; no assertion is widened.
vi.setConfig({ testTimeout: 150_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

/** Two processes on one machine, told apart by the only thing a lock can see. */
const SERVICE_A = 41_41;
const SERVICE_B = 42_42;
const HOST = 'lock-hero-host';

describe.skipIf(!AVAILABLE)('§53 a run resumed by two services', () => {
  it('refuses the second while the first holds it, and lets it through afterwards', async () => {
    // A run with everything current for its bytes and no page on disk: the next thing
    // it is offered is Stage 8's pack, which costs no model request and no repository
    // command, so anything this test sees written was written by the resumed stage.
    const fixture = await reviewedRun(tempDirs, { findings: false });
    const runId = fixture.record.runId;
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mergesutra-lockhero-state-'));
    tempDirs.push(stateRoot);
    const runsRoot = defaultRunStoreRoot(stateRoot);
    const packDir = path.join(runsRoot, runId);

    const neverModel = scriptedClient([]);
    const deps = {
      resume: {
        store: fixture.store,
        cwd: fixture.workspace,
        runsRoot,
        now: () => NOW,
        host: HOST,
        isProcessAlive: () => true,
      },
      report: { store: fixture.store, cwd: stateRoot },
      plan: { client: neverModel },
      implement: { client: neverModel },
      review: { client: neverModel },
    } satisfies ResumeCommandDeps;

    /** Service B's own view of the machine: it is B, it is alive, and that is all. */
    const asB = (): ResumeCommandDeps => ({
      ...deps,
      resume: { ...deps.resume, pid: SERVICE_B },
    });
    const askB = (lines: string[], execute: boolean) =>
      resumeAction(
        runId,
        { noColor: true, env: {}, ...(execute ? { execute: true } : {}) },
        asB(),
        (line) => lines.push(line),
      );

    const packFiles = async (): Promise<string[] | null> =>
      await readdir(packDir).catch(() => null);
    const stored = async (): Promise<string> => JSON.stringify(await fixture.store.load(runId));
    const readByB = () =>
      readRunLock({ runId }, { runsRoot, cwd: fixture.workspace, pid: SERVICE_B, host: HOST });

    const recordBefore = await stored();
    expect(await packFiles()).toBeNull();

    // ── A acquires the run's lock and holds it. ─────────────────────────────────────
    const acquired = await acquireRunLock(
      { runId },
      { runsRoot, cwd: fixture.workspace, pid: SERVICE_A, host: HOST, now: () => NOW },
    );
    expect(acquired.state).toBe('ACQUIRED');

    // B may still look. A preview reads through the same lock module without claiming
    // it, so the exclusion costs nobody the ability to ask what is going on.
    const previewLines: string[] = [];
    expect(await askB(previewLines, false)).toBe(EXIT.OK);
    expect(previewLines.join('\n')).toContain('REGENERATE_EVIDENCE_PACK');
    expect(previewLines.join('\n')).toContain('NOTHING HAS BEEN RUN.');

    // ── B attempts a resume. B is told the run is already active. ───────────────────
    const blocked: string[] = [];
    expect(await askB(blocked, true)).toBe(EXIT.BLOCKED);
    const refused = blocked.join('\n');
    expect(refused).toContain('Blocked. Nothing was run.');
    expect(refused).toContain('is already active');
    expect(refused).toContain(`process ${String(SERVICE_A)} on host ${HOST}`);
    expect(refused).toContain('will not remove a lock it did not create');
    expect(refused).toContain('NOTHING WAS RUN.');

    // …and the refusal is the whole of what B did.
    expect(await packFiles()).toBeNull();
    expect(await stored()).toBe(recordBefore);
    expect(neverModel.calls).toHaveLength(0);
    const held = await readByB();
    expect(held.state).toBe('HELD');
    if (held.state !== 'HELD') throw new Error('unreachable');
    expect(held.holding.owner?.pid).toBe(SERVICE_A);
    expect(held.holding.owner?.token).toBe(
      acquired.state === 'ACQUIRED' ? acquired.handle.token : 'no handle issued',
    );

    // ── A releases. ────────────────────────────────────────────────────────────────
    if (acquired.state !== 'ACQUIRED') throw new Error('A never acquired the lock');
    expect((await releaseRunLock(acquired.handle)).state).toBe('RELEASED');
    expect((await readByB()).state).toBe('FREE');

    // ── B may proceed — same command, same service, nothing else altered. ───────────
    const proceeded: string[] = [];
    expect(await askB(proceeded, true)).toBe(EXIT.INCONCLUSIVE);
    const screen = proceeded.join('\n');
    expect(screen).toContain('THE STAGE NAMED ABOVE RAN, AND FILED WHAT IT FOUND.');
    expect(screen).toContain('given back — another process may act on this run');
    expect((await packFiles())?.sort()).toEqual(['commands.jsonl', 'report.json', 'report.md']);
    // B wrote the pack it was refused while A held the run, and gave its own lock back
    // on the way out; A's directory is not sitting there with B's name on it. And what
    // it filed is the record it was given plus the pack's own identity — not a page, an
    // approval, or anybody's consent.
    expect((await readByB()).state).toBe('FREE');
    const afterB = await fixture.store.load(runId);
    expect(afterB.publications).toEqual([]);
    // The pack is a rendering, not an outcome: the record is byte for byte the one A
    // left behind, so what B was allowed to do after the release changed a directory
    // and not the run's account of itself.
    expect(await stored()).toBe(recordBefore);
  });
});

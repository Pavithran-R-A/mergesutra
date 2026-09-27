import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { defaultRunner, type Runner } from '../../src/core/runner.js';
import { statusSnapshotSchema } from '../../src/lifecycle/snapshot.js';
import { runPrStage } from '../../src/pr/stage.js';
import { describePatch } from '../../src/verify/patch.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { recordWith } from '../helpers/review.js';
import { reviewedRun } from '../helpers/repairRun.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { memoryRunStore } from '../helpers/github.js';
import { hasGit } from '../helpers/git.js';
import type { ProgramDeps } from '../../src/cli/program.js';
import type { RepairFixture } from '../helpers/repairRun.js';

/**
 * `mergesutra status` — the screen that is allowed to describe and nothing else.
 *
 * What is worth testing here is what a person trusts this command with: the state of
 * a run they have not looked at in a week, in a workspace somebody else may have
 * edited. So the contract has three load-bearing parts. The screen must keep the
 * recorded claim and the current observation in two different places (§3), it must
 * reach its words about currency from the same graph the snapshot holds rather than a
 * second opinion rendered on the way out (§7), and it must do all of it without
 * touching a model, a repository command, or a byte of the state it is describing
 * (§2, §39). The last of those is proved by measurement — the patch identity and the
 * run directory are compared before and after — and not by a promise in a comment.
 *
 * The exit code is the other deliberate choice, and the strangest one: a run that is
 * blocked, stale, half-repaired and waiting for a human still exits 0, because what
 * exited is the observation command, which succeeded. A missing or unreadable record
 * exits 1, because then there is no report at all. That separation is what lets a
 * script tell "STATUS COMMAND FAILED" from "STATUS REPORTED A FAILED RUN", and it is
 * argued in docs/DECISIONS.md rather than assumed here.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** The fixture's own store and pack directory, so the screen reads real state. */
function depsFor(fixture: RepairFixture): ProgramDeps {
  return {
    status: { store: fixture.store, cwd: fixture.workspace, runsRoot: fixture.runsRoot },
  };
}

/** Every model slot in the process gets this; touching it from `status` is a failure. */
function explodingDeps(): ProgramDeps {
  const exploding = new Proxy(
    {},
    {
      get(_target, property): never {
        throw new Error(`status reached for '${String(property)}' on a model client`);
      },
    },
  ) as never;
  return {
    plan: exploding,
    implement: exploding,
    review: exploding,
    repair: exploding,
    issue: exploding,
  };
}

/** A Runner that starts nothing but Git, and records what Git was asked for. */
function gitOnly(calls: GitCall[]): Runner {
  return async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file !== 'git') {
      throw new Error(`status asked to start '${file}', which is not a read of Git`);
    }
    return defaultRunner(file, args);
  };
}

interface GitCall {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * The verb Git was being asked to run, with the `-C <path>` prefix skipped.
 *
 * Every Git read in the observation layer arrives as `git -C <dir> <verb> …`, so a
 * parser that took the token after `git` would return the directory and call the
 * whole screen a failure. This is the difference between asserting "only reads" and
 * asserting "my guess about the shape of the argv was right".
 */
function gitVerbOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
      i += 1;
      continue;
    }
    if (token?.startsWith('-')) continue;
    return token ?? '';
  }
  return '';
}

function statusDeps(fixture: RepairFixture, extra: Partial<ProgramDeps['status']> = {}) {
  return {
    status: {
      store: fixture.store,
      cwd: fixture.workspace,
      runsRoot: fixture.runsRoot,
      ...extra,
    },
  } satisfies ProgramDeps;
}

describe.skipIf(!AVAILABLE)('mergesutra status', () => {
  it('shows what was recorded and what is here now as two different claims', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    const screen = c.text();
    // The record still says the gates passed; the observation says they are about
    // bytes that are gone. Printing only one of the two would be the lie.
    expect(code).toBe(EXIT.OK);
    expect(screen).toContain('REVIEW_RECORDED');
    expect(screen).toMatch(/verification\s+STALE/i);
    expect(screen).toContain(fixture.identityA.slice(0, 8));
    expect(screen).not.toContain('PR ready');
    expect(screen).toContain('No files were changed.');
  });

  it('changes neither the workspace nor the run directory while describing them', async () => {
    const fixture = await reviewedRun(tempDirs);
    const before = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const packBefore = await readdir(fixture.runsRoot);
    const calls: GitCall[] = [];
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...statusDeps(fixture, { run: gitOnly(calls) }),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    const after = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    expect(code).toBe(EXIT.OK);
    expect(after.identity).toBe(before.identity);
    expect(await readdir(fixture.runsRoot)).toEqual(packBefore);
    // §2: repository code is never started, and every Git call is one that reads.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.file, `status started '${call.file}'`).toBe('git');
      expect(
        [
          'rev-parse',
          'cat-file',
          'diff',
          'ls-files',
          'status',
          'show',
          'merge-base',
          'symbolic-ref',
        ],
        `unexpected Git verb in: ${['git', ...call.args].join(' ')}`,
      ).toContain(gitVerbOf(call.args));
    }
  });

  it('needs no model client anywhere in the process', async () => {
    const fixture = await reviewedRun(tempDirs);
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      ...explodingDeps(),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain(fixture.record.runId);
  });

  it('reports a blocked lifecycle and still exits 0', async () => {
    const fixture = await reviewedRun(tempDirs);
    const gone = path.join(path.dirname(fixture.workspace), 'deleted-by-somebody');
    await fixture.store.save(
      recordWith(fixture.record, {
        local: { ...fixture.record.local!, toplevel: gone, requestedPath: gone },
      }),
    );
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    // The command did its job: it found the workspace is gone and said so, in the
    // observation's words, without proposing to put it back.
    expect(code).toBe(EXIT.OK);
    expect(c.text()).toMatch(/MISSING/);
    expect(c.text()).toMatch(/will not recreate/i);
    expect(c.text()).toContain('No files were changed.');
  });

  it('says a review found nothing without saying there is nothing wrong', async () => {
    const fixture = await proposedRun(tempDirs);
    const c = capture();

    await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    const screen = c.text();
    expect(screen).toMatch(/review\s+CURRENT/);
    expect(screen).toContain('0 findings recorded');
    expect(screen).not.toMatch(/no defects|looks good|all clear|nothing wrong/i);
  });

  it('keeps an approved page and a publication two sentences apart', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest ?? '' },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const c = capture();

    await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    const screen = c.text();
    expect(screen).toMatch(/human approval\s+CURRENT/i);
    expect(screen).toMatch(/remote publication\s+DISABLED/i);
    expect(screen).not.toMatch(/pr ready|ready to (publish|merge)|published/i);
    expect(screen).toContain('No files were changed.');
  });

  it('offers only the commands the current facts justify, and never a way back', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const c = capture();

    await run(['node', 'mergesutra', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    const screen = c.text();
    expect(screen).toContain(`mergesutra verify ${fixture.record.runId}`);
    expect(screen).not.toContain(`mergesutra pr ${fixture.record.runId}`);
    // A suggestion is the one place this screen could become an action, so the verbs
    // that undo work are excluded by name, in the screen's own words.
    expect(screen).not.toMatch(/\bgit (reset|clean|checkout|stash|revert|push)\b/);
  });

  it('--json prints the whole snapshot, lifecycle states and all', async () => {
    const fixture = await reviewedRun(tempDirs);
    const c = capture();

    const code = await run(['node', 'mergesutra', '--json', 'status', fixture.record.runId], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    const snapshot = statusSnapshotSchema.parse(JSON.parse(c.text()));
    expect(code).toBe(EXIT.OK);
    expect(snapshot.runId).toBe(fixture.record.runId);
    expect(snapshot.lifecycle.states.verification).toBe('CURRENT');
    expect(snapshot.safeNextActions.map((action) => action.command)).toContain('repair');
  });

  it('names the run it chose when it was given none', async () => {
    const fixture = await reviewedRun(tempDirs);
    const older = fixture.record.runId;
    // A deliberately unrelated id, not `${older}-b`: a newer id that *contains* the
    // older one would make the assertion below unsatisfiable no matter what the
    // screen printed, and the bug would read as a production failure.
    const newer = 'run-selected-newest';
    await fixture.store.save(
      recordWith(fixture.record, { runId: newer, createdAt: '2026-09-26T09:00:00.000Z' }),
    );
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status'], {
      ...depsFor(fixture),
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    // Newest first, and the id printed so a wrong guess is at least visible.
    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain(newer);
    expect(c.text()).not.toContain(older);
  });

  it('fails when there is no record, instead of describing a repository it found', async () => {
    const store = memoryRunStore();
    const cwd = await scratch('mergesutra-status-empty-');
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status'], {
      status: { store, cwd },
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    // §28: nothing was reported, so this is a command failure, not a blocked run.
    expect(code).toBe(EXIT.ERROR);
    expect(c.text()).toBe('');
    expect(c.errorText()).toMatch(/no run has been recorded|no run record/i);
  });

  it('says which records it could not read instead of saying none exists', async () => {
    const cwd = await scratch('mergesutra-status-unreadable-');
    const root = path.join(cwd, '.mergesutra', 'runs');
    await mkdir(root, { recursive: true });
    // A record from an older run schema: valid JSON, and not something this build
    // can read. This is the state a real working directory gets into after a stage
    // bump, so the answer cannot be that nothing was ever recorded.
    await writeFile(
      path.join(root, 'run-oldschema.json'),
      '{"runId":"run-oldschema","schemaVersion":1,"outcome":"BLOCKED"}\n',
      'utf8',
    );
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status'], {
      status: { cwd },
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    expect(code).toBe(EXIT.ERROR);
    expect(c.text()).toBe('');
    expect(c.errorText()).toMatch(/could not be read|unreadable/i);
    expect(c.errorText()).not.toMatch(/no run has been recorded/i);
    // The file is named so a person can go look at it; its bytes are not, which is
    // §27's rule against quoting back a record that may hold anything.
    expect(c.errorText()).toContain('run-oldschema.json');
  });

  it('names a few unreadable records and counts the rest', async () => {
    const cwd = await scratch('mergesutra-status-many-');
    const root = path.join(cwd, '.mergesutra', 'runs');
    await mkdir(root, { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      await writeFile(path.join(root, `run-bad-${String(i)}.json`), '{"runId":', 'utf8');
    }
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status'], {
      status: { cwd },
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    // §38's compactness applies to the failure path too: a directory with a long
    // history must not turn one error line into a wall of file names.
    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toMatch(/and 2 more/);
    expect((c.errorText().match(/run-bad-\d\.json/g) ?? []).length).toBeLessThanOrEqual(5);
  });

  it('refuses to read a corrupt record and does not quote it back', async () => {
    const cwd = await scratch('mergesutra-status-corrupt-');
    const root = path.join(cwd, '.mergesutra', 'runs');
    await mkdir(root, { recursive: true });
    const secret = 'sk-bharatcode-SHOULD-NEVER-BE-ECHOED-1234';
    await writeFile(
      path.join(root, 'broken-run.json'),
      `{"runId":"broken-run","api_key":"${secret}","stage":"`,
      'utf8',
    );
    const c = capture();

    const code = await run(['node', 'mergesutra', 'status', 'broken-run'], {
      status: { cwd },
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
    });

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toMatch(/not valid JSON|cannot be read/i);
    expect(c.errorText()).not.toContain(secret);
    expect(c.text()).toBe('');
  });
});

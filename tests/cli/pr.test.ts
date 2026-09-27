import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { recordWith } from '../helpers/review.js';
import { onItsOwnBranch, proposedRun, type PublicationFixture } from '../helpers/publicationRun.js';
import { cleanUp, hasGit, implementedRun } from '../helpers/verifyRun.js';
import type { PrStageDeps } from '../../src/pr/stage.js';

/**
 * `mergesutra pr <run-id>` — Stage 10 judged as output.
 *
 * A publication command's screen is the last place a person can be told the truth
 * before a decision they cannot undo, so the two failures worth testing here are
 * both speech failures: a screen that reads like a pull request already exists, and
 * a screen that lets somebody approve a page they were never shown. So the digest is
 * captured *off the printed line* before being typed back — the assertion is that
 * what the command prints and what it accepts are the same string, which is the one
 * property that makes `--approve` a reading act rather than a guessing game.
 *
 * The flags are the other half. There is exactly one way to say yes, and no way to
 * say it in advance, broadly, or on someone else's behalf — a `--yes` here would
 * stand for opening a page in a stranger's repository. And nothing on the screen
 * may claim a remote was touched, because this build has no hands to touch one with:
 * `published` is a literal false all the way down, and no pull request address
 * exists in any output shape.
 *
 * These run against the same fixture as the stage's own suite — a real Git
 * workspace, real gate receipts, a pack rendered to disk — because the command must
 * not have a softer path to a filing than the module does. No BharatCode client is
 * wired in at all: Stage 10 asks nothing of a model, and a test that supplied one
 * could not tell whether the stage had used it.
 */

vi.setConfig({ testTimeout: 120_000 });

const AVAILABLE = await hasGit();
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

function depsFor(fixture: PublicationFixture): Partial<PrStageDeps> {
  return {
    store: fixture.store,
    runsRoot: fixture.runsRoot,
    cwd: fixture.workspace,
    now: () => PR_NOW,
  };
}

/** The clock a publication run is judged at — later than every document it reads. */
const PR_NOW = new Date('2026-09-25T12:00:00.000Z');

/** The digest the screen tells a person to type, read off the screen itself. */
function digestOnScreen(text: string): string {
  const typed = text.match(/--approve ([0-9a-f]{64})/)?.[1];
  if (!typed) throw new Error(`the screen printed no approvable digest:\n${text}`);
  return typed;
}

describe.skipIf(!AVAILABLE)('mergesutra pr', () => {
  it('shows the page and the exact words that approve it, and says no remote was touched', async () => {
    const fixture = await proposedRun(tempDirs);
    const io = capture();

    const code = await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--repo', fixture.workspace],
      { ...io, env: {}, pr: depsFor(fixture) },
    );

    const text = io.text();
    // Not the planned stub any more.
    expect(text).not.toMatch(/planned, not yet implemented/);
    expect(text).toContain('Parser accepts invalid empty dates');
    expect(text).toContain('## Summary');
    expect(text).toContain('## Independent Review');
    expect(text).toContain(`mergesutra pr ${fixture.record.runId} --approve`);
    expect(text).toContain('NO REMOTE CHANGE HAS BEEN MADE.');
    // Nothing was agreed to yet, so the readiness word is the waiting one.
    expect(text).toContain('NOT_READY_FOR_PUBLICATION');
    expect(text).not.toContain('HUMAN_APPROVED_FOR_PR');
    // A page a person has not read yet must not be reported as a done publication.
    expect(text).not.toMatch(/PR CREATED|READY TO SHIP|Published:?\s+true/i);
    expect(code).toBe(EXIT.INCONCLUSIVE);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_CANDIDATE_RECORDED');
    expect(saved.publications).toHaveLength(1);
    expect(saved.publications[0]?.approval).toBeNull();
  });

  it('records a typed approval as a local fact, and still says the remote is untouched', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });
    const digest = digestOnScreen(first.text());

    const io = capture();
    const code = await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--approve', digest],
      { ...io, env: {}, pr: depsFor(fixture) },
    );

    const text = io.text();
    expect(text).toContain('HUMAN_APPROVED_FOR_PR');
    expect(text).toContain('NO REMOTE CHANGE HAS BEEN MADE.');
    // The approval is the news; the action it authorises is still not taken.
    expect(text).not.toMatch(/PR CREATED|pull request is open|published to/i);
    expect(code).toBe(EXIT.INCONCLUSIVE);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_APPROVED_LOCAL');
    expect(saved.publications).toHaveLength(1);
    expect(saved.publications[0]?.approval?.action).toBe('CREATE_PULL_REQUEST');
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(digest);
  });

  it('refuses a digest that names another page, and files no yes on top of it', async () => {
    const fixture = await proposedRun(tempDirs);
    const io = capture();

    const code = await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--approve', 'f'.repeat(64)],
      { ...io, env: {}, pr: depsFor(fixture) },
    );

    const text = io.text();
    expect(text).toMatch(/different candidate/i);
    expect(text).toContain('NO REMOTE CHANGE HAS BEEN MADE.');
    expect(code).toBe(EXIT.BLOCKED);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(saved.publications).toEqual([]);
  });

  it('separates approved from published in JSON, and prints no pull request address', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });

    const io = capture();
    const code = await run(
      [
        'node',
        'mergesutra',
        'pr',
        fixture.record.runId,
        '--approve',
        digestOnScreen(first.text()),
        '--json',
      ],
      { ...io, env: {}, pr: depsFor(fixture) },
    );

    const payload = JSON.parse(io.text()) as {
      approved: boolean;
      published: boolean;
      readiness: string;
      outcome: string;
      record: { publications: { approval: unknown }[] };
    };
    expect(payload.approved).toBe(true);
    expect(payload.published).toBe(false);
    expect(payload.readiness).toBe('HUMAN_APPROVED_FOR_PR');
    expect(payload.outcome).toBe('PR_APPROVED_LOCAL');
    expect(payload.record.publications).toHaveLength(1);
    // The one thing a later stage must not be able to add by accident: an address.
    // (The issue's own URL is an input this stage was handed, so it stays; what may
    // not appear is a pull request that does not exist.)
    expect(io.text()).not.toMatch(/prUrl|html_url|pullRequestUrl|"published":\s*true/i);
    expect(io.text()).not.toMatch(/github\.com\/[^\s"]*\/pull\/\d+/);
    expect(code).toBe(EXIT.INCONCLUSIVE);
  });

  it('says which earlier stage a run is missing, instead of rerunning it here', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    await prepared.store.save(recordWith(source, { implementation: onItsOwnBranch(source) }));
    const runsRoot = await mkdtemp(path.join(tmpdir(), 'mergesutra-pr-cli-'));
    tempDirs.push(runsRoot);
    const io = capture();

    const code = await run(['node', 'mergesutra', 'pr', source.runId], {
      ...io,
      env: {},
      pr: { store: prepared.store, runsRoot, cwd: source.local?.toplevel ?? process.cwd() },
    });

    const text = io.text();
    expect(code).toBe(EXIT.BLOCKED);
    expect(text).toMatch(/mergesutra verify/);
    expect(text).toMatch(/mergesutra report/);
    expect(text).toMatch(/not re-run|will not re-run|no gate was re-run/i);
    expect((await prepared.store.load(source.runId)).publications).toEqual([]);
  });

  it('leaves a gap between every row label and its sentence, on every row it prints', async () => {
    const fixture = await proposedRun(tempDirs);
    const io = capture();

    const code = await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...io,
      env: { NO_COLOR: '1' },
      pr: depsFor(fixture),
    });
    // This stage's rows carry longer labels than any earlier screen's — a readiness
    // row is named `Readiness · verification-current`, which overruns the column the
    // other commands use — and a label that runs into its sentence is a screen that
    // cannot be read on the one page where a person is deciding something. So the
    // check is over every row the run files, not over a chosen few.
    const text = io.text();
    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.checks.length).toBeGreaterThan(10);
    for (const check of saved.checks) {
      const pattern = new RegExp(
        `^\\S+\\s+${check.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +\\S`,
        'm',
      );
      expect(pattern.test(text), `${check.name} ran into its detail`).toBe(true);
    }
    expect(code).toBe(EXIT.INCONCLUSIVE);
  });

  it('takes no flag that approves in advance, and files nothing when one is typed', async () => {
    for (const forbidden of [
      '--yes',
      '--force',
      '--approve-all',
      '--all',
      '--dangerously-skip-approval',
    ]) {
      const fixture = await proposedRun(tempDirs);
      const io = capture();

      const code = await run(['node', 'mergesutra', 'pr', fixture.record.runId, forbidden], {
        ...io,
        env: {},
        pr: depsFor(fixture),
      });

      expect(code).not.toBe(EXIT.OK);
      expect(io.errorText() + io.text()).toMatch(/unknown option/i);
      expect((await fixture.store.load(fixture.record.runId)).publications).toEqual([]);
    }
  });

  it('names itself in help, with the digest it takes and none of the bypasses', async () => {
    const io = capture();

    // Help must not need a run, a store or a credential, or a reader cannot find
    // out what the command requires before supplying them.
    const code = await run(['node', 'mergesutra', 'pr', '--help'], { ...io, env: {} });

    const text = io.text();
    expect(code).toBe(0);
    // The run id is required, not optional: a command that speaks about somebody
    // else's repository must never guess which run it was pointed at.
    expect(text).toMatch(/pr \[options\] <run-id>/);
    expect(text).toMatch(/--approve <digest>/);
    expect(text.toLowerCase()).not.toMatch(/--yes|--force|--approve-all|--all|--dangerously/);
  });
});

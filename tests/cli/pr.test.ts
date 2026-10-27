import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { AppError } from '../../src/core/errors.js';
import { recordWith } from '../helpers/review.js';
import { onItsOwnBranch, proposedRun, type PublicationFixture } from '../helpers/publicationRun.js';
import { cleanUp, hasGit, implementedRun } from '../helpers/verifyRun.js';
import type { PrStageDeps } from '../../src/pr/stage.js';
import type {
  CreatePullRequestInput,
  PublicationRemote,
  PushBranchInput,
} from '../../src/pr/publisher.js';

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
 * stand for opening a page in a stranger's repository. A yes is still not a
 * publication: sending it needs the separate `--publish`. That second act is judged
 * through an injected transport here, so the screen can be checked for the one thing
 * it must never blur — a draft that GitHub reported versus a merge that this product
 * cannot perform. Without `--publish` the screen still refuses to claim any remote
 * event, and a later read of a run whose draft already exists reports the draft as
 * history rather than as something this invocation did.
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

function depsFor(fixture: PublicationFixture, remote?: PublicationRemote): Partial<PrStageDeps> {
  return {
    store: fixture.store,
    runsRoot: fixture.runsRoot,
    cwd: fixture.workspace,
    now: () => PR_NOW,
    ...(remote ? { remote } : {}),
  };
}

const DRAFT_URL = 'https://github.com/projectbharat/datekit/pull/7';
const PUSHED_SHA = 'd'.repeat(40);

/**
 * A publication transport that records what it was asked to send.
 *
 * The real transport is tested against a scripted `gh` in its own suite; here the
 * question is what the command does around it — whether a yes has to exist before a
 * transport is called at all, and whether the screen distinguishes a draft GitHub
 * reported from a merge this product cannot request.
 */
function fakeRemote(options: { pushFails?: boolean } = {}): {
  remote: PublicationRemote;
  pushes: PushBranchInput[];
  pulls: CreatePullRequestInput[];
} {
  const pushes: PushBranchInput[] = [];
  const pulls: CreatePullRequestInput[] = [];
  const remote: PublicationRemote = {
    async pushBranch(input) {
      pushes.push(input);
      if (options.pushFails) {
        throw new AppError({
          kind: 'server',
          message: 'gh api refused the ref: HTTP 422',
          remediation: 'Inspect the remote branch before asking again.',
        });
      }
      return { branch: input.branch, commitSha: PUSHED_SHA };
    },
    async createPullRequest(input) {
      pulls.push(input);
      return { url: DRAFT_URL, number: 7, draft: true };
    },
  };
  return { remote, pushes, pulls };
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
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--repo', fixture.primaryDir],
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

  it('sends the approved page only on --publish, and reports a draft rather than a merge', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });
    const digest = digestOnScreen(first.text());
    const sent = fakeRemote();

    const io = capture();
    const code = await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--approve', digest, '--publish'],
      { ...io, env: {}, pr: depsFor(fixture, sent.remote) },
    );

    expect(sent.pushes).toHaveLength(1);
    expect(sent.pulls).toHaveLength(1);
    const push = sent.pushes[0]!;
    const pull = sent.pulls[0]!;
    expect(push.directory).toBe(fixture.workspace);
    expect(push.repository).toBe('projectbharat/datekit');
    expect(push.branch).toBe(`mergesutra/${fixture.record.runId}`);
    expect(push.runId).toBe(fixture.record.runId);
    expect(push.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(push.patchIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(pull.head).toBe(push.branch);
    expect(pull.base).toBe('main');
    expect(pull.title).toBe('Parser accepts invalid empty dates');
    expect(pull.body).toContain('## Summary');

    const text = io.text();
    expect(text).toContain(DRAFT_URL);
    expect(text).toContain('DRAFT PULL REQUEST OPENED');
    expect(text).toContain('NOT MERGED');
    // A draft that exists is a remote change; the old "nothing changed" footer would
    // now be false on this path.
    expect(text).not.toContain('NO REMOTE CHANGE HAS BEEN MADE.');
    expect(code).toBe(EXIT.OK);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_DRAFT_OPENED');
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(digest);
    expect(saved.publications[0]?.result?.url).toBe(DRAFT_URL);
  });

  it('prints the draft in JSON as a publication, and never as a merge', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });
    const digest = digestOnScreen(first.text());
    const sent = fakeRemote();

    const io = capture();
    const code = await run(
      [
        'node',
        'mergesutra',
        'pr',
        fixture.record.runId,
        '--approve',
        digest,
        '--publish',
        '--json',
      ],
      { ...io, env: {}, pr: depsFor(fixture, sent.remote) },
    );

    const payload = JSON.parse(io.text()) as {
      approved: boolean;
      published: boolean;
      outcome: string;
      publication: {
        url: string;
        number: number;
        branch: string;
        commitSha: string;
        draft: boolean;
      };
      recordedPublication: unknown;
    };
    expect(payload.approved).toBe(true);
    expect(payload.published).toBe(true);
    expect(payload.outcome).toBe('PR_DRAFT_OPENED');
    expect(payload.publication).toEqual({
      url: DRAFT_URL,
      number: 7,
      branch: `mergesutra/${fixture.record.runId}`,
      commitSha: PUSHED_SHA,
      draft: true,
    });
    expect(payload.recordedPublication).toBeNull();
    // The run's next-step prose may say a human could merge; what may not exist is
    // any field reporting a merge this product performed.
    expect(io.text()).not.toMatch(/mergeUrl|mergedAt|mergeCommit|"merged":\s*true/i);
    expect(code).toBe(EXIT.OK);
  });

  it('never calls a transport for --publish without an approval, and says nothing was attempted', async () => {
    const fixture = await proposedRun(tempDirs);
    const sent = fakeRemote();
    const io = capture();

    const code = await run(['node', 'mergesutra', 'pr', fixture.record.runId, '--publish'], {
      ...io,
      env: {},
      pr: depsFor(fixture, sent.remote),
    });

    expect(sent.pushes).toEqual([]);
    expect(sent.pulls).toEqual([]);
    const text = io.text();
    expect(text).toContain('REMOTE PUBLICATION NOT ATTEMPTED');
    expect(text).toContain('NO REMOTE CHANGE HAS BEEN MADE.');
    expect(text).not.toContain('DRAFT PULL REQUEST OPENED');
    expect(code).toBe(EXIT.INCONCLUSIVE);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.publications[0]?.approval).toBeNull();
    expect(saved.publications[0]?.result).toBeNull();
  });

  it('reports a failed send as a changed remote, and keeps the yes without inventing a draft', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });
    const digest = digestOnScreen(first.text());
    const sent = fakeRemote({ pushFails: true });

    const io = capture();
    const code = await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--approve', digest, '--publish'],
      { ...io, env: {}, pr: depsFor(fixture, sent.remote) },
    );

    const text = io.text();
    expect(text).toContain('REMOTE PUBLICATION FAILED');
    expect(text).toContain('THE REMOTE MAY HAVE CHANGED');
    expect(text).not.toContain('DRAFT PULL REQUEST OPENED');
    expect(code).toBe(EXIT.BLOCKED);

    const saved = await fixture.store.load(fixture.record.runId);
    expect(saved.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect(saved.publications[0]?.approval?.publicationDigest).toBe(digest);
    expect(saved.publications[0]?.result).toBeNull();
  });

  it("prints a read-back refusal's do-not-retry remediation rather than advising a retry", async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });
    const digest = digestOnScreen(first.text());
    const remote: PublicationRemote = {
      async pushBranch() {
        throw new AppError({
          kind: 'invalid-response',
          retryable: false,
          message:
            "GitHub accepted the request to create branch 'mergesutra/x' at commit " +
            `${'d'.repeat(40)}, but MergeSutra could not verify what it stored: ` +
            'the tree listing was truncated.',
          remediation:
            'Do not retry this command; inspect the branch and any pull request on GitHub, and ' +
            'decide what it should carry. MergeSutra will not move, force or delete a branch it created.',
        });
      },
      async createPullRequest() {
        throw new Error('a read-back refusal must not reach the pull request');
      },
    };

    const io = capture();
    const code = await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--approve', digest, '--publish'],
      { ...io, env: {}, pr: depsFor(fixture, remote) },
    );

    const text = io.text();
    expect(text).toContain('REMOTE PUBLICATION FAILED');
    expect(text).toMatch(/do not retry this command/i);
    expect(text).not.toMatch(/before retrying|retry only|try again/i);
    expect(text).not.toContain('DRAFT PULL REQUEST OPENED');
    expect(code).toBe(EXIT.BLOCKED);
  });

  it('shows a draft recorded earlier as history, not as an event of this read', async () => {
    const fixture = await proposedRun(tempDirs);
    const first = capture();
    await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...first,
      env: {},
      pr: depsFor(fixture),
    });
    const digest = digestOnScreen(first.text());
    const sent = fakeRemote();
    await run(
      ['node', 'mergesutra', 'pr', fixture.record.runId, '--approve', digest, '--publish'],
      { ...capture(), env: {}, pr: depsFor(fixture, sent.remote) },
    );

    const reread = capture();
    const code = await run(['node', 'mergesutra', 'pr', fixture.record.runId], {
      ...reread,
      env: {},
      pr: depsFor(fixture),
    });

    const text = reread.text();
    expect(text).toContain('DRAFT PULL REQUEST ALREADY RECORDED');
    expect(text).toContain('NOTHING WAS SENT BY THIS COMMAND');
    expect(text).toContain(DRAFT_URL);
    // The approval is still current, so the readiness word remains the approved one;
    // what changed is that no remote action is on offer a second time.
    expect(text).toContain('HUMAN_APPROVED_FOR_PR');
    expect(text).not.toContain('NO REMOTE CHANGE HAS BEEN MADE.');
    expect(text).not.toMatch(/--publish\b/);
    expect(code).toBe(EXIT.OK);

    expect(sent.pushes).toHaveLength(1);
    expect(sent.pulls).toHaveLength(1);
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

  it('names itself in help, with the digest and the explicit publish act, and none of the bypasses', async () => {
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
    // Sending is its own named act, and the help says what it cannot do.
    expect(text).toMatch(/--publish/);
    expect(text).toMatch(/never merges/);
    expect(text.toLowerCase()).not.toMatch(/--yes|--force|--approve-all|--all|--dangerously/);
  });
});

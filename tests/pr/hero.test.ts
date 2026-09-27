import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { defaultRunner } from '../../src/core/runner.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { writeEvidencePack } from '../../src/report/write.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { runRepairStage } from '../../src/repair/stage.js';
import { runReviewStage } from '../../src/review/stage.js';
import { describePatch } from '../../src/verify/patch.js';
import type { PrStageDeps } from '../../src/pr/stage.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { cleanUp, hasGit, NOW, put } from '../helpers/verifyRun.js';
import { parserOf, REPAIRED, repairedAnswers, reviewedRun } from '../helpers/repairRun.js';
import { recordWith } from '../helpers/review.js';
import {
  FIXTURE_ISSUE,
  FIXTURE_ISSUE_DOCUMENT,
  onItsOwnBranch,
} from '../helpers/publicationRun.js';

/**
 * The Stage 10 hero: a repaired run, read and approved by a person, and one byte of
 * the remote moved — no.
 *
 * Stages 7, 8 and 9 each end their own story at the honest limit of what a green
 * suite proves. This file picks the story up where Stage 9's hero puts it down:
 * patch B on disk, verified on those bytes, reviewed a second time by a reader who
 * objects to nothing, and rendered into a pack a reviewer can open. From there the
 * only thing left is the thing no earlier stage is allowed to do — ask a human
 * whether this is what they want sent — and the entire risk of that question is
 * answered by one property: between the first screen and the recorded approval,
 * nothing may leave the machine.
 *
 * So the hero measures that rather than asserting it. The patch identity is read
 * before every `pr` invocation and after the last one, by real Git, over a real
 * workspace with a real dirty patch; the repository's remotes are listed before and
 * after; and the approval a person types is taken off the printed screen rather
 * than recomputed in the test, so the string that made the page is the string that
 * accepted it. A run whose bytes moved under it would show up as a different patch
 * identity, which is the most direct way this product has of noticing.
 *
 * The lifecycle itself is not simulated. Stage 9R's repair cycle runs through
 * Stage 6's loop and Stage 5's confined writer over the fixture's real workspace,
 * Stage 7 re-verifies the bytes it left, and Stage 9 reviews them a second time —
 * because Stage 10's claim is precisely that it consumes facts it did not produce,
 * and a fixture that hand-wrote those facts would test a weaker stage than the
 * product has. Only the model turns are scripted, for the standing reason: no
 * credential belongs in a test run, and a model's agreement is not evidence.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/** Later than every document the publication run reads, so nothing looks pre-approved. */
const PR_NOW = new Date('2026-09-25T12:00:00.000Z');

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

/** A reviewer that reads the new bytes and files nothing against them. */
function silentReviewer(): BharatCodeClient {
  return {
    async complete() {
      return {
        text: JSON.stringify({
          summary: 'The guard now rejects the day the calendar does not have. Nothing to report.',
          findings: [],
        }),
        model: 'bharatcode-deepseek-reviewer',
        finishReason: 'stop',
        usage: { promptTokens: 5_900, completionTokens: 120, totalTokens: 6_020 },
      };
    },
    async listModels() {
      throw new Error('the reviewer may not enumerate models');
    },
    async completeStructured() {
      throw new Error('the reviewer may not ask for structured output');
    },
    async healthCheck() {
      throw new Error('the reviewer may not probe the service');
    },
  };
}

function prDeps(workspace: string, fixture: { store: PrStageDeps['store']; runsRoot: string }) {
  const deps: Partial<PrStageDeps> = {
    store: fixture.store,
    runsRoot: fixture.runsRoot,
    cwd: workspace,
    now: () => PR_NOW,
  };
  return deps;
}

/** Every readiness row that did not pass, named by its id. */
function waitingRows(checks: readonly { name: string; status: string }[]): string[] {
  return checks
    .filter((check) => check.name.startsWith('Readiness · ') && check.status !== 'INFO')
    .map((check) => check.name.replace('Readiness · ', ''));
}

/** The last three lines of a screen, which is where a command says what it did. */
function closingLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3);
}

/** The digest the screen tells a person to type, read off the screen itself. */
function digestOnScreen(text: string): string {
  const typed = text.match(/--approve ([0-9a-f]{64})/)?.[1];
  if (!typed) throw new Error(`the screen printed no approvable digest:\n${text}`);
  return typed;
}

describe.skipIf(!AVAILABLE)(
  'the Stage 10 hero: a repaired run approved by a person, with nothing sent',
  () => {
    it('proposes the page, refuses a wrong digest, records the right one, and changes no byte or ref', async () => {
      // ---- The state Stage 9 left, with the two facts only Stage 10 needs. ----
      const fixture = await reviewedRun(tempDirs, { findings: true });
      const runId = fixture.record.runId;
      const seeded = recordWith(fixture.record, {
        issueRef: FIXTURE_ISSUE,
        issue: FIXTURE_ISSUE_DOCUMENT,
        implementation: onItsOwnBranch(fixture.record),
      });
      await fixture.store.save(seeded);
      const patchA = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
      expect(patchA.identity).toBe(fixture.identityA);

      // ---- Stage 9R, approved: the edit through Stage 6's loop, then re-verified. ----
      const before = await parserOf(fixture.workspace);
      const repaired = await runRepairStage(
        { runId, approvePlan: repairPlanDigest(fixture.plan) },
        {
          store: fixture.store,
          client: scriptedClient(repairedAnswers(before, fixture.criteria)),
          now: () => NOW,
          runsRoot: fixture.runsRoot,
          runFor: fixture.runFor,
          cwd: fixture.workspace,
        },
      );
      const patchB = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
      expect(repaired.executed).toBe(true);
      expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
      expect(patchB.identity).not.toBe(patchA.identity);
      expect(repaired.round?.run.result).toBe('PASS');
      expect(repaired.record.repairExecutions[0]?.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');

      // ---- A second reading of the bytes that exist now, and it objects to nothing. ----
      const second = await runReviewStage(
        { runId },
        { store: fixture.store, cwd: fixture.workspace, now: () => NOW, client: silentReviewer() },
      );
      expect(second.review?.reviewedPatchIdentity).toBe(patchB.identity);
      expect(second.review?.findings).toEqual([]);

      // ---- Stage 8's pack over the repaired, re-reviewed record. ----
      const pack = buildEvidencePack(second.record);
      const written = await writeEvidencePack(fixture.runsRoot, pack);
      const rendered = await readFile(path.join(written.dir, 'report.md'), 'utf8');
      expect(rendered).toContain(patchB.identity);

      // Every fact a page is built from now exists and is current. What is left is
      // the question, and the answer can only come from a person.
      const deps = prDeps(fixture.workspace, fixture);
      const refsBefore = await refs(fixture.workspace);
      const remotesBefore = await remotes(fixture.workspace);

      // ---- `mergesutra pr <run>`: the page, and nothing sent. ----
      const proposed = capture();
      const proposedCode = await run(
        ['node', 'mergesutra', 'pr', runId, '--repo', fixture.workspace],
        { ...proposed, env: { NO_COLOR: '1' }, pr: deps },
      );
      const page = proposed.text();
      const digest = digestOnScreen(page);

      expect(proposedCode).toBe(EXIT.INCONCLUSIVE);
      expect(page).toContain('NOT_READY_FOR_PUBLICATION');
      expect(page).toContain('PR_CANDIDATE_RECORDED');
      expect(page).toContain('## Summary');
      expect(page).toContain('## Independent Review');
      expect(page).toContain('## Limitations');
      expect(page).toContain('#123');
      expect(page).toContain('NO REMOTE CHANGE HAS BEEN MADE.');
      // The waiting screen ends on the same three facts, with the first one worded
      // as the absence it is: nothing was agreed to, nothing was sent, nothing moved.
      expect(closingLines(page)).toEqual([
        'NO HUMAN APPROVAL RECORDED',
        'REMOTE PUBLICATION NOT ENABLED',
        'NO REMOTE CHANGE HAS BEEN MADE.',
      ]);
      expect(page).not.toMatch(/PR CREATED|published to|pull request is open/i);
      const afterPropose = await fixture.store.load(runId);
      expect(waitingRows(afterPropose.checks)).toEqual(['human-approved']);
      expect(afterPropose.publications).toHaveLength(1);
      expect(afterPropose.publications[0]?.approval).toBeNull();

      // ---- A digest that names some other page: refused, and still nothing sent. ----
      const wrong = capture();
      const wrongCode = await run(
        [
          'node',
          'mergesutra',
          'pr',
          runId,
          '--repo',
          fixture.workspace,
          '--approve',
          'f'.repeat(64),
        ],
        { ...wrong, env: { NO_COLOR: '1' }, pr: deps },
      );
      expect(wrongCode).toBe(EXIT.BLOCKED);
      expect(wrong.text()).toMatch(/different candidate/i);
      // The refusal is stated on the same line the approval would have used, so a
      // reader who compares the two screens sees the same field change value rather
      // than a sentence appearing somewhere in the middle.
      expect(wrong.text()).toContain('NO HUMAN APPROVAL RECORDED');
      const afterWrong = await fixture.store.load(runId);
      expect(afterWrong.publications.every((entry) => entry.approval === null)).toBe(true);

      // ---- The typed digest: the approval is a local fact, and it is only that. ----
      const approved = capture();
      const approvedCode = await run(
        ['node', 'mergesutra', 'pr', runId, '--repo', fixture.workspace, '--approve', digest],
        { ...approved, env: { NO_COLOR: '1' }, pr: deps },
      );
      const screen = approved.text();
      expect(approvedCode).toBe(EXIT.INCONCLUSIVE);
      expect(screen).toContain('HUMAN_APPROVED_FOR_PR');
      expect(screen).toContain('PR_APPROVED_LOCAL');
      // §34 asks for an ending, so this reads the ending rather than hunting for a
      // phrase a longer sentence could also contain: the last three lines of the
      // screen, in order, are what a person takes away from the command.
      expect(closingLines(screen)).toEqual([
        'HUMAN APPROVAL RECORDED',
        'REMOTE PUBLICATION NOT ENABLED',
        'NO REMOTE CHANGE HAS BEEN MADE.',
      ]);
      expect(screen).not.toMatch(/PR CREATED|CONTRIBUTION_READY|AI APPROVED|LGTM/i);

      const filed = await fixture.store.load(runId);
      expect(filed.publications).toHaveLength(1);
      expect(filed.publications[0]?.approval?.publicationDigest).toBe(digest);
      expect(filed.publications[0]?.approval?.action).toBe('CREATE_PULL_REQUEST');
      expect(filed.publications[0]?.approval?.approvedAt).toBe(PR_NOW.toISOString());
      expect(filed.outcome).toBe('PR_APPROVED_LOCAL');
      expect(JSON.stringify(filed.publications)).not.toMatch(
        /"url"|prUrl|html_url|pullRequestUrl|github\.com\/[^"]*\/pull\//i,
      );

      // ---- The measurement, not the promise: nothing left this machine. ----
      // The same patch, the same remotes, and the same refs the run started with —
      // each list read once before the first `pr` and once after the last, so "no
      // remote mutation" is a fact about the repository rather than a word about the
      // stage's intentions. A build with no remote cannot push, and this states that
      // in the form a reader can check: nothing in the ref store moved either, which
      // is the local half of the claim and the part an accidental `git commit` here
      // would break.
      expect(
        (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base })).identity,
      ).toBe(patchB.identity);
      expect(await remotes(fixture.workspace)).toEqual(remotesBefore);
      expect(await refs(fixture.workspace)).toEqual(refsBefore);

      if (process.env.MERGESUTRA_HERO_CAPTURE) {
        process.stdout.write(`\n--- mergesutra pr ${runId} ---\n${page}\n`);
        process.stdout.write(`\n--- mergesutra pr ${runId} --approve ${digest} ---\n${screen}\n`);
        process.stdout.write(`\n--- evidence pack a reviewer could open ---\n${rendered}`);
      }

      // ---- Teeth: the approval is bound to these bytes, not to this run id. ----
      // One more byte in the workspace and the yes a person gave no longer describes
      // the page, which is the whole reason the digest exists.
      await put(fixture.workspace, 'notes.md', 'a person wrote here after the approval\n');
      const moved = capture();
      const movedCode = await run(
        ['node', 'mergesutra', 'pr', runId, '--repo', fixture.workspace],
        { ...moved, env: { NO_COLOR: '1' }, pr: deps },
      );
      expect(movedCode).toBe(EXIT.BLOCKED);
      const afterMove = await fixture.store.load(runId);
      // The single yes on file still names the page it was typed against. The moved
      // bytes assembled a different page, and nothing carried the old approval onto
      // it — which is why this screen says no approval was recorded even a moment
      // after one genuinely was.
      expect(afterMove.outcome).toBe('PR_PUBLICATION_BLOCKED');
      expect(afterMove.publications).toHaveLength(1);
      expect(afterMove.publications[0]?.approval?.publicationDigest).toBe(digest);
      expect(waitingRows(afterMove.checks)).toEqual(
        expect.arrayContaining(['verification-current', 'review-current', 'pack-current']),
      );
      expect(moved.text()).toContain('NO HUMAN APPROVAL RECORDED');
      expect(moved.text()).toMatch(/no gate was re-run/);
    }, 600_000);
  },
);

/** The repository's remotes — the list a push would have to appear in. */
async function remotes(workspace: string): Promise<string[]> {
  const result = await defaultRunner('git', ['-C', workspace, 'remote', '-v']);
  return result.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/** Every ref the repository holds, names and objects together. */
async function refs(workspace: string): Promise<string[]> {
  const result = await defaultRunner('git', [
    '-C',
    workspace,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
  ]);
  return result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .sort();
}

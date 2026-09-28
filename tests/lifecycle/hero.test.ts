import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRunner } from '../../src/core/runner.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { runRepairStage } from '../../src/repair/stage.js';
import { runStatusStage } from '../../src/lifecycle/status.js';
import { readRunLock } from '../../src/lifecycle/lock.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { defaultRunStoreRoot } from '../../src/state/run-store.js';
import { describePatch } from '../../src/verify/patch.js';
import { formatStatus } from '../../src/cli/status.js';
import { createRenderer } from '../../src/cli/render.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { resumeAction, type ResumeCommandDeps } from '../../src/cli/resume.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { headOf, hasGit, statusOf } from '../helpers/git.js';
import { cleanUp, NOW } from '../helpers/verifyRun.js';
import { recordWith } from '../helpers/review.js';
import { parserOf, REPAIRED, repairedAnswers, reviewedRun } from '../helpers/repairRun.js';
import {
  FIXTURE_ISSUE,
  FIXTURE_ISSUE_DOCUMENT,
  onItsOwnBranch,
} from '../helpers/publicationRun.js';
import { storeThatCannotSave } from '../helpers/store.js';
import type { LifecycleArtifact } from '../../src/lifecycle/staleness.js';
import type { StatusSnapshot } from '../../src/lifecycle/snapshot.js';

/**
 * §52: the recovery hero — a run stopped with an edit landed, brought back through the
 * command a person would actually type, one honest step at a time.
 *
 * Stage 9R ends with a repair, Stage 10 with a page, and Stage 11's own files each prove
 * one mechanism in isolation: the graph says `STALE`, the plan says what is next, the
 * lock says who holds the run. None of those files can answer the question the stage
 * exists for, which is whether the parts add up to a *recovery* — whether a run that was
 * cut off between an edit and its record can be brought forward by `mergesutra resume`
 * without anybody re-earning a fact they never earned, or destroying the one artifact
 * the interrupted cycle produced.
 *
 * So this file is one sequence, in the order §52 gives it, driven through the shipped CLI
 * entry point rather than the modules behind it. That choice is the test: a preview that
 * spends no request, an execution that runs the same Stage 7 `mergesutra verify` runs, and
 * a boundary that stops the chain where a person's decision belongs are all properties of
 * the command. Reached through the modules, each would be a claim about an executor this
 * command could have chosen not to use — which is why
 * `tests/lifecycle/source-shape.test.ts` walks the same dispatcher from the other side and
 * names every Git call site it can reach.
 *
 * Three assertions carry most of the weight, and each names the production change that
 * would defeat it. If `resume` answered a moved patch with the receipts that describe the
 * patch *before* it — the shortcut every reporting tool is tempted by — the graph rows
 * below would still read `CURRENT` and the run would reach a page built on bytes nobody
 * measured. If it treated a crash as licence to put the workspace back, the file contents
 * and `git status` read off the real checkout after the recovery would not be the repair's.
 * And if it read `resume` as consent, the last step would have assembled an approval
 * instead of refusing to.
 *
 * Only the model is scripted, for the standing reason (§32): no credential belongs in a
 * test run, and a model's agreement is not evidence either way. The Git here is real, the
 * gate processes are the fixture's own scripted answers to the repository's declared
 * commands, and every identity asserted was measured from the filesystem, not typed in.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

// The fixture at the top of this chain builds a real repository and runs Stage 7 twice
// through it, then a repair cycle and four resumed stages follow. The budget is raised for
// that cost, not for contention; no assertion below is widened, and a stage that truly
// hung would still fail. Compare `tests/lifecycle/interruption.test.ts`.
vi.setConfig({ testTimeout: 150_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

describe.skipIf(!AVAILABLE)('§52 the recovery hero', () => {
  it('brings a run stopped mid-repair forward to a page, re-earning every fact on the way', async () => {
    // ── 1-2. A real scratch repository, and a run that has reached a repair. ──────────
    const fixture = await reviewedRun(tempDirs);
    // The two things Stage 10 refuses to invent. Left at `main` the run would be refused
    // for proposing a pull request into itself, and a page with no issue behind it is a
    // page that cannot say what it closes.
    const reviewed = recordWith(fixture.record, {
      issueRef: FIXTURE_ISSUE,
      issue: FIXTURE_ISSUE_DOCUMENT,
      implementation: onItsOwnBranch(fixture.record),
    });
    await fixture.store.save(reviewed);
    const runId = reviewed.runId;

    // The state directory a person would have, outside the repository: a pack written
    // inside it would join the patch it is meant to describe.
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'mergesutra-hero-state-'));
    tempDirs.push(stateRoot);
    const runsRoot = defaultRunStoreRoot(stateRoot);

    const identityA = fixture.identityA;
    // The pack the run *would* have had, rendered from the record before the edit. Held
    // on to so step 12 can prove the page a reader opens is not this one.
    const stalePack = buildEvidencePack(reviewed);
    const renderer = createRenderer({ color: false });

    /** What the shipped status service says about this run, read from disk each time. */
    const truth = async (): Promise<StatusSnapshot> => {
      const { snapshot } = await runStatusStage(
        { runId },
        {
          store: fixture.store,
          cwd: fixture.workspace,
          runsRoot,
          now: () => new Date('2026-09-26T09:00:00.000Z'),
        },
      );
      return snapshot;
    };
    const stateOf = (snapshot: StatusSnapshot, artifact: LifecycleArtifact): unknown =>
      snapshot.lifecycle.states[artifact];
    const offered = (snapshot: StatusSnapshot): string[] =>
      snapshot.safeNextActions.map((action) => action.command);
    const stored = async (): Promise<string> => JSON.stringify(await fixture.store.load(runId));

    // Every stage `resume` may route to, wired the way `src/cli.ts` wires them. The two
    // clients that must never answer are the tripwire on §18: a plan that reached a
    // model on this path would throw rather than quietly spend a request.
    const reviewClient = scriptedClient([
      { summary: 'Nothing to report on these bytes.', findings: [] },
    ]);
    const neverModel = scriptedClient([]);
    const screens: Record<string, string[]> = {};
    const show = (label: string) => (line: string) => {
      (screens[label] ??= []).push(line);
    };
    const page = (label: string): string => (screens[label] ?? []).join('\n');
    const deps = {
      resume: {
        store: fixture.store,
        cwd: fixture.workspace,
        runsRoot,
        now: () => NOW,
        pid: 42_42,
        host: 'hero-host',
        isProcessAlive: () => true,
      },
      verify: {
        store: fixture.store,
        cwd: fixture.workspace,
        now: () => NOW,
        runFor: fixture.runFor,
      },
      review: { store: fixture.store, now: () => NOW, client: reviewClient },
      report: { store: fixture.store, cwd: stateRoot },
      pr: { store: fixture.store, runsRoot, now: () => NOW },
      plan: { client: neverModel },
      implement: { client: neverModel },
    } satisfies ResumeCommandDeps;

    // ── 3. The repair changes A into B. ──────────────────────────────────────────────
    const beforeRepair = await parserOf(fixture.workspace);
    const repairClient = scriptedClient(repairedAnswers(beforeRepair, fixture.criteria));

    // ── 4. …and is interrupted before re-verification is filed. ─────────────────────
    // §22's dangerous case: the edit is the only artifact the cycle produced, and the
    // record of it is the thing that was lost.
    const recordBeforeTheCrash = await stored();
    const crashed = await runRepairStage(
      { runId, approvePlan: repairPlanDigest(fixture.plan) },
      {
        store: storeThatCannotSave(fixture.store),
        client: repairClient,
        now: () => NOW,
        runsRoot,
        runFor: fixture.runFor,
      },
    );
    const identityB = (await describePatch({ workspace: fixture.workspace, baseSha: fixture.base }))
      .identity;

    expect(crashed.executed).toBe(true);
    expect(crashed.recordFile).toBeNull();
    expect(crashed.packError).toMatch(/the disk went away/);
    expect(identityB).not.toBe(identityA);
    // Nothing was filed: the record on disk is still byte for byte the reviewed one, so
    // everything the recovery has to work from is a workspace that disagrees with it.
    expect(await stored()).toBe(recordBeforeTheCrash);

    // ── 5-6. A fresh status service starts, and reports B current, A's receipts stale. ─
    const afterCrash = await truth();
    expect(afterCrash.workspace.currentPatchIdentity).toBe(identityB);
    expect(afterCrash.verification?.patchIdentity).toBe(identityA);
    expect(stateOf(afterCrash, 'verification')).toBe('STALE');
    expect(stateOf(afterCrash, 'review')).toBe('STALE');
    expect(stateOf(afterCrash, 'evidence')).toBe('STALE');
    // And the run is not blocked: the crash was a lost write, not an unusable workspace,
    // which is why there is a next action to offer at all.
    expect(afterCrash.blockers).toEqual([]);
    expect(offered(afterCrash)).toEqual(['verify', 'report']);
    // The screen a person reads says the same thing in words, in the same places.
    const crashPage = formatStatus(afterCrash, renderer);
    expect(crashPage).toContain('STALE');
    expect(crashPage).toContain(identityB.slice(0, 12));
    expect(crashPage).toContain('mergesutra verify');
    expect(crashPage).toContain('The bytes here measure');

    // ── 7. `resume` previews, and calls no model. ───────────────────────────────────
    const gatesBefore = fixture.gateCalls.length;
    const previewExit = await resumeAction(
      runId,
      { noColor: true, env: {} },
      deps,
      show('preview'),
    );
    expect(previewExit).toBe(EXIT.OK);
    expect(reviewClient.calls).toHaveLength(0);
    expect(neverModel.calls).toHaveLength(0);
    // A preview that started no process and wrote nothing is a preview that previewed.
    expect(fixture.gateCalls).toHaveLength(gatesBefore);
    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    expect(await stored()).toBe(recordBeforeTheCrash);

    const preview = page('preview');
    expect(preview).toContain('VERIFY_CURRENT_PATCH');
    expect(preview).toContain('mergesutra verify');
    expect(preview).toContain('Model request');
    expect(preview).toContain('none — this is arithmetic and Git');
    // Every cost row is printed whether or not it is the interesting one (§16): a screen
    // that reads as safe because it is short is not a screen that says it is.
    for (const row of [
      'Model request',
      'Credential',
      'Workspace',
      'Repository gates',
      'Approval',
      'Remote',
    ]) {
      expect(preview).toContain(row);
    }
    expect(preview).toContain('none — this build has no remote action in any command');
    expect(preview).toContain(`mergesutra resume ${runId} --execute`);
    expect(preview).toContain('NOTHING HAS BEEN RUN.');

    // ── 8. Explicit execution, with the gate consent already given, runs real Stage 7. ─
    const verifyExit = await resumeAction(
      runId,
      { noColor: true, env: {}, execute: true, allow: [...fixture.repoGateIds] },
      deps,
      show('verify'),
    );
    expect(verifyExit).toBe(EXIT.OK);
    // The stage that ran is Stage 7 and not a description of it: the repository's own
    // gate commands were started, against the bytes that are here now.
    expect(fixture.gateCalls.length).toBeGreaterThan(gatesBefore);
    expect(page('verify')).toContain('THE STAGE NAMED ABOVE RAN, AND FILED WHAT IT FOUND.');
    expect(page('verify')).toContain('VERIFICATION_PASS');
    // The lock was taken for the action and given back after it.
    expect((await readRunLock({ runId }, { runsRoot, cwd: fixture.workspace })).state).toBe('FREE');

    // ── 9. The evidence is current for B, and the review of A is not current at all. ─
    const afterVerify = await truth();
    expect(afterVerify.verification?.patchIdentity).toBe(identityB);
    expect(stateOf(afterVerify, 'verification')).toBe('CURRENT');
    expect(stateOf(afterVerify, 'evidence')).toBe('CURRENT');
    expect(afterVerify.evidence?.verified).toBe(afterVerify.evidence?.total);
    expect(afterVerify.evidence?.total ?? 0).toBeGreaterThan(0);
    expect(stateOf(afterVerify, 'review')).toBe('STALE');
    expect(afterVerify.review?.reviewedPatchIdentity).toBe(identityA);

    // ── 10-11. Resume again routes the review; the reviewer finds nothing. ───────────
    const reviewExit = await resumeAction(
      runId,
      { noColor: true, env: {}, execute: true },
      deps,
      show('review'),
    );
    expect(reviewExit).toBe(EXIT.INCONCLUSIVE);
    // One round trip for the whole recovery, and this is it: nothing upstream asked a
    // model anything, and nothing downstream will.
    expect(reviewClient.calls).toHaveLength(1);
    expect(neverModel.calls).toHaveLength(0);

    const afterReview = await truth();
    expect(stateOf(afterReview, 'review')).toBe('CURRENT');
    expect(afterReview.review?.reviewedPatchIdentity).toBe(identityB);
    expect(afterReview.review?.findings.total).toBe(0);
    expect(afterReview.review?.routedToRepair).toBe(false);
    // The finding that drove the repair is gone with the review that replaced it, so the
    // plan built from it has nothing to be current *for*.
    expect(stateOf(afterReview, 'repairPlan')).toBe('ABSENT');
    expect(offered(afterReview)).toEqual(['report']);

    // ── 12. The pack is regenerated — from this record, about these bytes. ───────────
    const reportExit = await resumeAction(
      runId,
      { noColor: true, env: {}, execute: true },
      deps,
      show('report'),
    );
    expect(reportExit).toBe(EXIT.INCONCLUSIVE);
    const afterPack = await truth();
    expect(afterPack.report.packOnDisk).not.toBeNull();
    expect(afterPack.report.packOnDisk).not.toBe(stalePack.identity);
    expect(afterPack.report.packOnDisk).toBe(
      buildEvidencePack(await fixture.store.load(runId)).identity,
    );
    expect((await readdir(path.join(runsRoot, runId))).sort()).toEqual([
      'commands.jsonl',
      'report.json',
      'report.md',
    ]);
    expect(offered(afterPack)).toEqual(['pr']);

    // ── 13. The candidate is regenerated, and binds that pack and those bytes. ───────
    const prExit = await resumeAction(
      runId,
      { noColor: true, env: {}, execute: true },
      deps,
      show('pr'),
    );
    expect(prExit).toBe(EXIT.INCONCLUSIVE);
    const afterPr = await truth();
    expect(afterPr.publication?.candidates).toBe(1);
    expect(afterPr.publication?.latest?.patchIdentity).toBe(identityB);
    expect(afterPr.publication?.latest?.evidencePackIdentity).toBe(afterPr.report.packOnDisk);
    expect(stateOf(afterPr, 'pack')).toBe('CURRENT');
    expect(stateOf(afterPr, 'candidate')).toBe('CURRENT');
    // Assembled is not approved. A page exists to be agreed to, and the agreement is a
    // separate fact on a separate row of the same screen.
    expect(afterPr.publication?.approval).toBeNull();
    expect(stateOf(afterPr, 'publicationApproval')).toBe('ABSENT');
    expect(offered(afterPr)).toEqual(['pr']);

    // ── 14. Nothing reaches a remote, and nothing is approved on the way there. ──────
    const recordBeforeRefusal = await stored();
    const gatesBeforeRefusal = fixture.gateCalls.length;
    const finalExit = await resumeAction(
      runId,
      { noColor: true, env: {}, execute: true, allow: [...fixture.repoGateIds] },
      deps,
      show('final'),
    );
    expect(finalExit).toBe(EXIT.BLOCKED);
    expect(page('final')).toContain('a page approval this command cannot hold');
    expect(page('final')).toContain('NOTHING WAS RUN.');
    // The refusal was a refusal: no gate started, no record written, no state moved.
    expect(fixture.gateCalls).toHaveLength(gatesBeforeRefusal);
    expect(await stored()).toBe(recordBeforeRefusal);
    expect(await truth()).toMatchObject({
      lifecycle: { states: afterPr.lifecycle.states },
    });

    // Of the commands the whole recovery started, none is a push, a fetch, or a
    // publication tool — and there is no remote here to have been sent to, which is
    // read off the checkout rather than asserted from a config flag.
    const commands = fixture.gateCalls.join('\n');
    expect(commands).not.toMatch(/\bpush\b|\bfetch\b|\bgh\b|publish|deploy/);
    const remotes = await defaultRunner('git', ['-C', fixture.workspace, 'remote']);
    expect(remotes.code).toBe(0);
    expect(remotes.stdout.trim()).toBe('');
    expect(afterPr.publication?.remote).toBe('NOT_ATTEMPTED_BY_THIS_BUILD');

    // §22, measured at the end rather than promised at the start: recovery did not put
    // the workspace back. The repair's bytes are still here, the commit the run started
    // from is still HEAD, and the checkout is still dirty with the edit that was nearly
    // lost. `git reset --hard`, `checkout -- .`, `clean` and `stash` would each have
    // destroyed the only artifact the interrupted cycle produced — and their absence from
    // this build's source is what `tests/lifecycle/source-shape.test.ts` proves, which
    // makes this the other half of that claim: nobody reaches for them, and here is the
    // workspace that shows they were not reached for.
    expect(await parserOf(fixture.workspace)).toBe(REPAIRED);
    expect(await headOf(fixture.workspace)).toBe(fixture.base);
    expect((await statusOf(fixture.workspace)).trim()).not.toBe('');

    if (process.env.MERGESUTRA_HERO_CAPTURE) {
      const out = (title: string, body: string): void => {
        process.stdout.write(`\n--- ${title} ---\n${body}\n`);
      };
      out(`mergesutra status ${runId}`, crashPage);
      out(`mergesutra resume ${runId}`, page('preview'));
      out(`mergesutra resume ${runId} --execute --allow <the five gate ids>`, page('verify'));
      out(`mergesutra status ${runId}`, formatStatus(afterVerify, renderer));
      out(`mergesutra resume ${runId} --execute`, page('review'));
      out(`mergesutra resume ${runId} --execute`, page('report'));
      out(`mergesutra resume ${runId} --execute`, page('pr'));
      out(`mergesutra status ${runId}`, formatStatus(afterPr, renderer));
      out(`mergesutra resume ${runId} --execute`, page('final'));
    }
  });
});

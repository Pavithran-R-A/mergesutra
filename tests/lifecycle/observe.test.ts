import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRunner, type Runner } from '../../src/core/runner.js';
import {
  observeRun,
  WORKSPACE_STATES,
  type LifecycleObservation,
  type WorkspaceState,
} from '../../src/lifecycle/observe.js';
import { publicationDigestOf } from '../../src/pr/digest.js';
import { runPrStage } from '../../src/pr/stage.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { writeEvidencePack } from '../../src/report/write.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { scopeDigest } from '../../src/verify/consent.js';
import { describePatch } from '../../src/verify/patch.js';
import { headOf, hasGit, initRepository, statusOf } from '../helpers/git.js';
import { cycleFor } from '../helpers/repair.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';
import { recordWith } from '../helpers/review.js';
import { implementedRun, put } from '../helpers/verifyRun.js';
import { REPAIRED, reviewedRun } from '../helpers/repairRun.js';
import { proposedRun } from '../helpers/publicationRun.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * Stage 11's eyes: what a run recorded, and what is actually on this machine.
 *
 * Every other Stage 11 module is going to be judged by whether it tells the
 * truth, and the truth starts here — so the cases worth testing are the ones where
 * a tool could quietly reassure: a workspace that is gone is not "unchanged", a
 * checkout standing on another commit is not the run's workspace, a patch Git
 * refuses to describe is a patch nobody may call clean, and a directory that
 * happens to share a name with the real repository is not the real repository.
 *
 * These run against real Git repositories, because the whole module is a claim
 * about bytes a person could go and look at. None of them deletes a fixture's own
 * checkout to simulate it being absent: observing a path that was never created is
 * the same fact, without the test also depending on its own cleanup.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/** The fixtures build real repositories; the budget is for that work, not for softened assertions. */
vi.setConfig({ testTimeout: 180_000 });

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function observe(
  record: RunRecord,
  runsRoot: string,
  extra: { repo?: string; run?: Runner } = {},
): Promise<LifecycleObservation> {
  return observeRun({ record, runsRoot, cwd: record.local?.toplevel ?? runsRoot, ...extra });
}

function stateOf(observation: LifecycleObservation): WorkspaceState {
  return observation.workspace.state;
}

/** Point a run's own record at another absolute path, leaving every document intact. */
function relocated(record: RunRecord, to: string): RunRecord {
  if (!record.local) throw new Error('the fixture record holds no local snapshot');
  return recordWith(record, {
    local: { ...record.local, requestedPath: to, toplevel: to },
  });
}

/** Commit everything in a workspace, the way a person would, and return the new HEAD. */
async function commitEverything(workspace: string): Promise<string> {
  await put(workspace, 'PERSON.md', 'a person works here\n');
  for (const args of [
    ['add', '-A'],
    ['commit', '-q', '-m', 'a person committed here'],
  ]) {
    const result = await defaultRunner('git', ['-C', workspace, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return headOf(workspace);
}

describe.skipIf(!AVAILABLE)('the workspace a run recorded', () => {
  it('says no workspace was created for a run that has never been implemented', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const runsRoot = await scratch('mergesutra-observe-runs-');
    const noProcesses: Runner = () => Promise.reject(new Error('a refused process'));

    const observation = await observe(prepared.record, runsRoot, { run: noProcesses });

    expect(stateOf(observation)).toBe('NOT_CREATED');
    expect(observation.workspace.path).toBeNull();
    expect(observation.workspace.currentPatchIdentity).toBeNull();
    expect(observation.verdict.states.verification).toBe('ABSENT');
  });

  it('reports a workspace that is not there, and does not create it on the way', async () => {
    const fixture = await reviewedRun(tempDirs);
    const missing = path.join(path.dirname(fixture.workspace), 'never-created-workspace');
    await expect(stat(missing)).rejects.toThrow();

    const observation = await observe(relocated(fixture.record, missing), fixture.runsRoot);

    expect(stateOf(observation)).toBe('MISSING');
    expect(observation.workspace.path).toBe(missing);
    expect(observation.workspace.currentPatchIdentity).toBeNull();
    expect(observation.workspace.detail).toMatch(/recreate/i);
    // Recovery observes. The directory the run pointed at is still not there.
    await expect(stat(missing)).rejects.toThrow();
    // §6: an absent workspace is not an unchanged patch, and old receipts may not
    // be read as though they described whatever is here now.
    expect(observation.facts.verification).toEqual({
      recorded: fixture.identityA,
      current: null,
    });
    expect(observation.verdict.states.verification).toBe('UNMEASURABLE');
    expect(observation.verdict.states.evidence).toBe('UNMEASURABLE');
    expect(observation.verdict.states.review).toBe('UNMEASURABLE');
  });

  it('calls a directory that is not a Git workspace unreadable rather than unchanged', async () => {
    const fixture = await reviewedRun(tempDirs);
    const plain = await scratch('mergesutra-observe-not-a-repo-');

    const observation = await observe(relocated(fixture.record, plain), fixture.runsRoot);

    expect(stateOf(observation)).toBe('UNREADABLE');
    expect(observation.workspace.observedHead).toBeNull();
    expect(observation.workspace.currentPatchIdentity).toBeNull();
    expect(observation.verdict.states.verification).toBe('UNMEASURABLE');
  });

  it('reports the base mismatch when the checkout has moved on, and leaves the commit alone', async () => {
    const fixture = await reviewedRun(tempDirs);
    const moved = await commitEverything(fixture.workspace);

    const observation = await observe(fixture.record, fixture.runsRoot);

    expect(stateOf(observation)).toBe('BASE_MISMATCH');
    expect(observation.workspace.recordedBaseSha).toBe(fixture.base);
    expect(observation.workspace.observedHead).toBe(moved);
    expect(observation.workspace.currentPatchIdentity).toBeNull();
    expect(observation.workspace.detail).toMatch(/will not reset/i);
    expect(observation.verdict.states.verification).toBe('UNMEASURABLE');
    // It reported the mismatch instead of putting the checkout back.
    expect(await headOf(fixture.workspace)).toBe(moved);
  });

  it('refuses to treat another repository as this run’s workspace', async () => {
    const fixture = await reviewedRun(tempDirs);
    const elsewhere = await initRepository({ 'README.md': '# an unrelated project\n' });
    tempDirs.push(elsewhere.dir);

    const observation = await observe(fixture.record, fixture.runsRoot, { repo: elsewhere.dir });

    expect(stateOf(observation)).toBe('BASE_MISMATCH');
    // A different cause, said in different words: this repository does not hold
    // this run's history at all, rather than holding it and having moved on.
    expect(observation.workspace.detail).toMatch(/not the repository/i);
    expect(observation.workspace.currentPatchIdentity).toBeNull();
  });

  it('recognises the run’s own workspace and the patch its documents describe', async () => {
    const fixture = await reviewedRun(tempDirs);

    const observation = await observe(fixture.record, fixture.runsRoot);

    expect(stateOf(observation)).toBe('PRESENT_MATCHED');
    expect(observation.workspace.path).toBe(fixture.workspace);
    expect(observation.workspace.currentPatchIdentity).toBe(fixture.identityA);
    expect(observation.workspace.recordedPatchIdentity).toBe(fixture.identityA);
    expect(observation.verdict.states.verification).toBe('CURRENT');
    expect(observation.verdict.states.review).toBe('CURRENT');
  });

  it('says the patch changed when somebody wrote in the workspace after the last document', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const measured = await describePatch({
      workspace: fixture.workspace,
      baseSha: fixture.base,
    });

    const observation = await observe(fixture.record, fixture.runsRoot);

    expect(stateOf(observation)).toBe('PRESENT_PATCH_CHANGED');
    expect(observation.workspace.currentPatchIdentity).toBe(measured.identity);
    expect(observation.verdict.states.verification).toBe('STALE');
    expect(observation.verdict.states.publicationApproval).toBe('ABSENT');
  });

  it('says a workspace is present when nothing has recorded a patch identity for it yet', async () => {
    const { source, repoDir, base } = await implementedRun(tempDirs);
    const runsRoot = await scratch('mergesutra-observe-runs-');
    const measured = await describePatch({ workspace: repoDir, baseSha: base });

    const observation = await observe(source, runsRoot);

    // `PRESENT_MATCHED` would claim these bytes agree with a document that does
    // not exist, and `PRESENT_PATCH_CHANGED` would claim they disagree with one.
    expect(stateOf(observation)).toBe('PRESENT');
    expect(observation.workspace.recordedPatchIdentity).toBeNull();
    expect(observation.workspace.currentPatchIdentity).toBe(measured.identity);
    expect(observation.verdict.states.verification).toBe('ABSENT');
    expect(observation.verdict.states.review).toBe('ABSENT');
  });

  it('does not downgrade a patch Git will not describe to an unchanged one', async () => {
    const fixture = await reviewedRun(tempDirs);
    const refusesDiff: Runner = async (file, args) => {
      if (args.includes('diff'))
        return { code: 1, stdout: '', stderr: 'git says no\n', signal: null };
      return defaultRunner(file, args);
    };

    const observation = await observe(fixture.record, fixture.runsRoot, { run: refusesDiff });

    expect(stateOf(observation)).toBe('PRESENT');
    expect(observation.workspace.currentPatchIdentity).toBeNull();
    expect(observation.workspace.detail).toMatch(/cannot be measured/i);
    expect(observation.facts.verification).toEqual({ recorded: fixture.identityA, current: null });
    expect(observation.verdict.states.verification).toBe('UNMEASURABLE');
  });

  it('names exactly the workspace states Stage 11 reports, and no others', () => {
    expect([...WORKSPACE_STATES].sort()).toEqual(
      [
        'BASE_MISMATCH',
        'MISSING',
        'NOT_CREATED',
        'PRESENT',
        'PRESENT_MATCHED',
        'PRESENT_PATCH_CHANGED',
        'UNREADABLE',
      ].sort(),
    );
  });
});

describe.skipIf(!AVAILABLE)('what an observation feeds the graph', () => {
  it('binds each patch-bound artifact to the field that recorded it', async () => {
    const fixture = await reviewedRun(tempDirs);
    const record = fixture.record;

    const { facts } = await observe(record, fixture.runsRoot);

    expect(facts.verification.recorded).toBe(record.verification?.patchIdentity ?? null);
    expect(facts.evidence.recorded).toBe(record.evidence?.patchIdentity ?? null);
    expect(facts.review.recorded).toBe(record.review?.reviewedPatchIdentity ?? null);
    expect(facts.repairPlan.recorded).toBe(record.repairPlan?.reviewedPatchIdentity ?? null);
    expect(facts.candidate.recorded).toBeNull();
    expect(facts.publicationApproval.recorded).toBeNull();
    expect(facts.repairApproval.recorded).toBeNull();
  });

  it('binds a review to the bytes it read, not to others it noticed later', async () => {
    const fixture = await reviewedRun(tempDirs, { movePatchAfterPlan: true });
    const noticed = await describePatch({
      workspace: fixture.workspace,
      baseSha: fixture.base,
    });
    const review = fixture.record.review;
    if (!review) throw new Error('the fixture run was never reviewed');

    const { facts } = await observe(
      recordWith(fixture.record, { review: { ...review, currentPatchIdentity: noticed.identity } }),
      fixture.runsRoot,
    );

    expect(facts.review).toEqual({ recorded: fixture.identityA, current: noticed.identity });
  });

  it('judges execution consent by the scope of the plan now on record', async () => {
    const fixture = await reviewedRun(tempDirs);
    const plan = fixture.record.verificationPlan;
    const consent = fixture.record.executionConsent;
    if (!plan || !consent) throw new Error('the fixture run has no consent to bind');

    const { facts } = await observe(fixture.record, fixture.runsRoot);

    expect(facts.executionConsent).toEqual({
      recorded: consent.planDigest,
      current: scopeDigest(plan),
    });
  });

  it('judges the repair approval by the plan on record, not by the bytes it changed', async () => {
    const fixture = await reviewedRun(tempDirs);
    const plan = fixture.record.repairPlan;
    if (!plan) throw new Error('the fixture run froze no plan');

    const { facts } = await observe(fixture.record, fixture.runsRoot);

    // Nothing has been approved for this plan yet, so the approval's *recorded*
    // side is empty while its observable side is already computable.
    expect(facts.repairApproval).toEqual({ recorded: null, current: repairPlanDigest(plan) });
    expect(facts.repairPlan.current).toBe(fixture.identityA);
  });

  it('takes a finished repair’s own post-repair bytes as what the workspace should hold', async () => {
    const fixture = await reviewedRun(tempDirs);
    const before = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    await put(fixture.workspace, 'src/parse.ts', REPAIRED);
    const after = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
    const implementation = fixture.record.implementation;
    if (!implementation) throw new Error('the fixture run has no loop record');
    const execution = cycleFor({
      plan: fixture.plan,
      patch: before,
      patchAfter: after,
      implementation,
      createdAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });

    const observation = await observe(
      recordWith(fixture.record, {
        repairExecutions: [...fixture.record.repairExecutions, execution],
      }),
      fixture.runsRoot,
    );

    // §23: the repair did the one thing it was approved to do. These are the bytes
    // a re-verification is for — not a workspace that drifted out from under a plan.
    expect(stateOf(observation)).toBe('PRESENT_MATCHED');
    expect(observation.workspace.currentPatchIdentity).toBe(after.identity);
    expect(observation.verdict.states.verification).toBe('STALE');
    expect(observation.verdict.states.repairPlan).toBe('STALE');
    expect(observation.verdict.states.repairApproval).toBe('CURRENT');
    expect(observation.verdict.states.candidate).toBe('ABSENT');
  });

  it('reads the pack from the files on disk and compares it with the page’s', async () => {
    const fixture = await proposedRun(tempDirs);
    const shown = await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    if (!shown.digest) throw new Error('the page was never proposed');
    await runPrStage(
      { runId: fixture.record.runId, approve: shown.digest },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const record = await fixture.store.load(fixture.record.runId);
    const filed = record.publications.at(-1);
    if (!filed?.approval) throw new Error('Stage 10 filed no approval');

    const observation = await observe(record, fixture.runsRoot);

    expect(stateOf(observation)).toBe('PRESENT_MATCHED');
    expect(observation.packOnDisk).toBe(fixture.packIdentity);
    expect(observation.facts.pack).toEqual({
      recorded: filed.candidate.evidencePackIdentity,
      current: fixture.packIdentity,
    });
    expect(observation.facts.candidate).toEqual({
      recorded: filed.candidate.patchIdentity,
      current: fixture.identityA,
    });
    expect(observation.facts.publicationApproval).toEqual({
      recorded: filed.approval.publicationDigest,
      current: publicationDigestOf(filed.candidate),
    });
    for (const artifact of ['pack', 'candidate', 'publicationApproval'] as const) {
      expect(observation.verdict.states[artifact], artifact).toBe('CURRENT');
    }
  });

  it('says the page expired when its pack no longer holds the files it was written from', async () => {
    const fixture = await proposedRun(tempDirs);
    await runPrStage(
      { runId: fixture.record.runId },
      { store: fixture.store, runsRoot: fixture.runsRoot, now: () => NOW },
    );
    const record = await fixture.store.load(fixture.record.runId);
    // §32's consequence, stated instead of hidden: a regenerated pack is a
    // different pack, and a page written from the old one describes other evidence.
    const rebuilt = buildEvidencePack(
      recordWith(record, { limitations: [...record.limitations, 'the pack was re-rendered'] }),
    );
    await writeEvidencePack(fixture.runsRoot, rebuilt);

    const observation = await observe(record, fixture.runsRoot);

    expect(observation.facts.pack).toEqual({
      recorded: fixture.packIdentity,
      current: rebuilt.identity,
    });
    expect(observation.verdict.states.pack).toBe('STALE');
    expect(observation.verdict.states.candidate).toBe('STALE');
    expect(observation.workspace.state).toBe('PRESENT_MATCHED');
  });

  it('leaves the page and its approval absent for a run that never reached Stage 10', async () => {
    const fixture = await reviewedRun(tempDirs);

    const observation = await observe(fixture.record, fixture.runsRoot);

    expect(observation.packOnDisk).toBeNull();
    expect(observation.facts.pack).toEqual({ recorded: null, current: null });
    expect(observation.facts.publicationApproval).toEqual({ recorded: null, current: null });
    // A candidate has nothing recorded and a perfectly measurable patch in front
    // of it. That is `ABSENT`, not `STALE`: nothing expired, Stage 10 just never ran.
    expect(observation.facts.candidate.recorded).toBeNull();
    expect(observation.facts.candidate.current).toBe(fixture.identityA);
    for (const artifact of ['pack', 'candidate', 'publicationApproval'] as const) {
      expect(observation.verdict.states[artifact], artifact).toBe('ABSENT');
    }
  });
});

describe.skipIf(!AVAILABLE)('looking changes nothing', () => {
  it('observes with read-only Git commands and writes nothing anywhere', async () => {
    const fixture = await reviewedRun(tempDirs);
    const calls: string[][] = [];
    const watched: Runner = async (file, args) => {
      calls.push([file, ...args]);
      return defaultRunner(file, args);
    };
    const dirtyBefore = await statusOf(fixture.workspace, '--untracked-files=all');
    const headBefore = await headOf(fixture.workspace);
    const recordBefore = JSON.stringify(fixture.record);
    const runsBefore = await readdir(fixture.runsRoot);

    const observation = await observe(fixture.record, fixture.runsRoot, { run: watched });

    expect(stateOf(observation)).toBe('PRESENT_MATCHED');
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv[0]).toBe('git');
      expect(argv[1]).toBe('-C');
      // The subcommand follows the directory argument: git -C <dir> <subcommand> …
      const subcommand = argv[3] ?? '';
      expect(['cat-file', 'diff', 'ls-files', 'rev-parse'], subcommand).toContain(subcommand);
    }
    expect(await statusOf(fixture.workspace, '--untracked-files=all')).toBe(dirtyBefore);
    expect(await headOf(fixture.workspace)).toBe(headBefore);
    expect(JSON.stringify(await fixture.store.load(fixture.record.runId))).toBe(recordBefore);
    expect(await readdir(fixture.runsRoot)).toEqual(runsBefore);
  });
});

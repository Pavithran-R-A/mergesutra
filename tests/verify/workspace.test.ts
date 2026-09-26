import { afterEach, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import type { RunRecord } from '../../src/state/run-record.js';
import { scopeDigest } from '../../src/verify/consent.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import {
  IMPLEMENT_LOOP_CLAIM_SOURCE,
  loopClaim,
  verifyWorkspace,
  type VerifyWorkspaceDeps,
  type VerifyWorkspaceInput,
} from '../../src/verify/workspace.js';
import {
  cleanUp,
  errorFrom,
  hasGit,
  implementedRun,
  put,
  scriptedGates,
  NOW,
  type VerifyFixture,
} from '../helpers/verifyRun.js';

/**
 * One round of Stage 7, asked for by name.
 *
 * `mergesutra verify` is one caller of this. Stage 9R's repair cycle is the
 * other, and that second caller is the reason the module exists: a patch that
 * has been repaired has to be judged by the same measurement, the same
 * discovery, the same consent rule and the same evidence mapper, or the second
 * verdict means something different from the first and a reviewer is reading two
 * dialects of one document.
 *
 * So these tests describe a round by what it is given — a contract, a directory,
 * the base it was cut from, and optionally the plan it revises — and never by a
 * run record it has to go and load. Every repository here is real, because a
 * patch identity borrowed from a stub would prove exactly nothing about which
 * bytes a receipt describes.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function parts(fixture: VerifyFixture) {
  const contract = fixture.source.acceptanceContract;
  const implementation = fixture.source.implementation;
  if (!contract || !implementation) {
    throw new Error('the fixture must have contracted and implemented before it verifies');
  }
  return {
    runId: fixture.source.runId,
    contract,
    implementation,
    workspace: fixture.repoDir,
    baseSha: fixture.base,
  };
}

/** A round over the fixture's real workspace, with only the gate processes scripted. */
function verify(
  fixture: VerifyFixture,
  input: Partial<Omit<VerifyWorkspaceInput, 'runId' | 'contract' | 'workspace' | 'baseSha'>> = {},
  deps: VerifyWorkspaceDeps = {},
) {
  const { runId, contract, implementation, workspace, baseSha } = parts(fixture);
  return verifyWorkspace(
    {
      runId,
      contract,
      workspace,
      baseSha,
      claims: loopClaim(IMPLEMENT_LOOP_CLAIM_SOURCE, implementation.finishClaim),
      ...input,
    },
    { now: () => NOW, ...deps },
  );
}

/** The ids of the repository's own gates, which are the only ones needing a yes. */
function repositoryIds(plan: { gates: readonly { id: string; provenance: { source: string } }[] }) {
  return plan.gates
    .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
    .map((gate) => gate.id);
}

describe.skipIf(!AVAILABLE)('one verification round over a workspace', () => {
  it('plans and judges the patch that is actually there, from a contract and a directory', async () => {
    const fixture = await implementedRun(tempDirs);

    const round = await verify(fixture, {}, scriptedGates());

    expect(round.patch.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(round.plan.patchIdentity).toBe(round.patch.identity);
    expect(round.run.patchPrecondition.status).toBe('MATCHED');
    expect(round.evidence.patchIdentity).toBe(round.patch.identity);
    expect(round.evidence.planRevision).toBe(1);
    // MergeSutra's own check is in the plan exactly once, and says who wrote it.
    const builtins = round.plan.gates.filter(
      (gate) => gate.provenance.source === 'MERGESUTRA_BUILTIN',
    );
    expect(builtins.map((gate) => gate.argv.join(' '))).toEqual(['git diff --check']);
    expect(round.checks.map((check) => check.name)).toEqual([
      'Verification plan',
      'Execution consent',
      'Verification run',
      'Acceptance evidence',
    ]);
  });

  it('runs no repository command until the operator names one, and records that it did not', async () => {
    const fixture = await implementedRun(tempDirs);
    const gates = scriptedGates();

    const round = await verify(fixture, {}, gates);

    expect(gates.calls).toEqual(['git diff --check']);
    expect(round.run.result).toBe('BLOCKED');
    expect(round.consent).toBeNull();
    expect(round.checks.find((check) => check.name === 'Execution consent')).toMatchObject({
      status: 'WARN',
    });
  });

  it('runs exactly the gates the operator names, under a consent bound to this round', async () => {
    const fixture = await implementedRun(tempDirs);
    const first = await verify(fixture, {}, scriptedGates());
    const ids = repositoryIds(first.plan);
    expect(ids.length).toBeGreaterThan(0);
    const gates = scriptedGates();

    const round = await verify(fixture, { allow: ids }, gates);

    expect(round.consent).not.toBeNull();
    expect(round.consent?.planDigest).toBe(scopeDigest(round.plan));
    expect(round.consent?.gateIds).toEqual(ids);
    expect(round.run.result).toBe('PASS');
    expect(round.evidence.verification).toBe('PASS');
    expect(round.evidence.contributionReady).toBe(false);
    for (const gate of round.plan.gates) {
      expect(gates.calls, gate.command).toContain(gate.argv.join(' '));
    }
    expect(round.evidence.criteria.some((entry) => entry.status === 'PASS')).toBe(true);
  });

  it('files the loop’s claim beside the receipts and lets no status rest on it', async () => {
    const fixture = await implementedRun(tempDirs);

    const withClaim = await verify(fixture, {}, scriptedGates());
    const withoutClaim = await verify(fixture, { claims: [] }, scriptedGates());

    expect(withClaim.evidence.claims).toEqual([
      {
        source: expect.stringContaining('implement'),
        text: expect.stringContaining('all criteria'),
      },
    ]);
    const { claims: _dropped, ...judged } = withClaim.evidence;
    const { claims: _alsoDropped, ...sameJudged } = withoutClaim.evidence;
    expect(judged).toEqual(sameJudged);
  });

  it('says the receipts are stale when the patch here is not the patch it verified', async () => {
    const fixture = await implementedRun(tempDirs);
    const first = await verify(fixture, {}, scriptedGates());
    const moved = 'c'.repeat(64);

    const round = await verify(
      fixture,
      { allow: repositoryIds(first.plan) },
      { currentPatchIdentity: async () => moved, ...scriptedGates() },
    );

    expect(round.run.result).toBe('PASS');
    expect(round.evidence.patchIdentity).not.toBe(moved);
    expect(round.evidence.currentPatchIdentity).toBe(moved);
    // Nothing that ran against the old bytes may be called a pass for the new ones.
    for (const entry of round.evidence.criteria) {
      expect(entry.status, entry.criterionId).not.toBe('PASS');
    }
    expect(
      round.evidence.criteria.some((entry) =>
        entry.limitations.some((limitation) => /STALE/i.test(limitation)),
      ),
    ).toBe(true);
  });

  it('revises the plan it is handed instead of renumbering the gates', async () => {
    const fixture = await implementedRun(tempDirs);
    const first = await verify(fixture, {}, scriptedGates());
    await put(fixture.repoDir, 'src/parse.ts', 'export const parseDate = () => new Date(0);\n');

    const second = await verify(
      fixture,
      {
        previous: {
          plan: first.plan,
          reason: 'a repair cycle moved the patch',
        },
      },
      scriptedGates(),
    );

    expect(second.patch.identity).not.toBe(first.patch.identity);
    expect(second.plan.revision).toBe(2);
    expect(second.plan.patchIdentity).toBe(second.patch.identity);
    expect(second.plan.gates.map((gate) => gate.id)).toEqual(
      first.plan.gates.map((gate) => gate.id),
    );
    expect(second.plan.gates.map((gate) => gate.argv.join(' '))).toEqual(
      first.plan.gates.map((gate) => gate.argv.join(' ')),
    );
    expect(second.plan.revisions[0]).toMatchObject({
      revision: 2,
      reason: 'a repair cycle moved the patch',
      added: [],
      removed: [],
    });
    expect(second.plan.revisions[0]?.source).toMatchObject({ source: 'MERGESUTRA_BUILTIN' });
    expect(second.evidence.planRevision).toBe(2);
  });

  it('refuses to revise a plan without saying why', async () => {
    const fixture = await implementedRun(tempDirs);
    const first = await verify(fixture, {}, scriptedGates());

    await expect(
      verify(fixture, { previous: { plan: first.plan, reason: '   ' } }, scriptedGates()),
    ).rejects.toThrow(/reason/i);
  });

  it('refuses a workspace that has moved off the commit the round was cut from', async () => {
    const fixture = await implementedRun(tempDirs);
    await put(fixture.repoDir, 'unrelated.ts', 'export const x = 1;\n');
    await defaultRunner('git', ['-C', fixture.repoDir, 'add', '-A']);
    await defaultRunner('git', ['-C', fixture.repoDir, 'commit', '-q', '-m', 'moved on']);

    const error = await errorFrom(() => verify(fixture, {}, scriptedGates()));

    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/Cannot name a patch/);
  });

  it('is the same round `mergesutra verify` runs, not a second implementation of it', async () => {
    const fixture = await implementedRun(tempDirs);
    const source: RunRecord = fixture.source;

    const stage = await runVerifyStage(
      { runId: source.runId },
      { store: fixture.prepared.store, now: () => NOW, ...scriptedGates() },
    );
    const round = await verify(fixture, {}, scriptedGates());

    const judged = (over: { plan: unknown; run: unknown; evidence: unknown; consent: unknown }) =>
      JSON.parse(
        JSON.stringify({
          plan: over.plan,
          run: over.run,
          evidence: over.evidence,
          consent: over.consent,
        }),
      );
    expect(judged(round)).toEqual(judged(stage));
    expect(round.checks).toEqual(stage.record.checks);
  });
});

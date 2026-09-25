import { afterEach, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { scopeDigest } from '../../src/verify/consent.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import {
  cleanUp,
  errorFrom,
  hasGit,
  implementedRun,
  put,
  scriptedGates,
  NOW,
} from '../helpers/verifyRun.js';

/**
 * `mergesutra verify`'s stage — the wiring, not the engine.
 *
 * The engine's own suite already proves gates are judged by exit codes. These
 * tests prove the *command* has nothing to fake: it reads the run record for
 * the run it was given, plans against the real patch on disk, runs only what
 * the operator named, and writes documents back that a resume can re-read.
 * Every repository here is a real Git repository, because a patch identity
 * borrowed from a stub would prove exactly nothing.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

describe.skipIf(!AVAILABLE)('runVerifyStage', () => {
  it('refuses a run whose implementation loop never ran', async () => {
    const { contractBackedRun } = await import('../helpers/plan.js');
    const bare = await contractBackedRun(tempDirs);
    const error = await errorFrom(() =>
      runVerifyStage({ runId: bare.record.runId }, { store: bare.store, now: () => NOW }),
    );
    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/has not implemented/);
    expect(error.remediation).toMatch(/implement/);
  });

  it('plans the patch that is really on disk and runs no repository command without a named yes', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const gates = scriptedGates();

    const stage = await runVerifyStage(
      { runId: source.runId },
      { store: prepared.store, now: () => NOW, ...gates },
    );

    expect(stage.run.patchPrecondition.status).toBe('MATCHED');
    expect(stage.plan.patchIdentity).toMatch(/^[0-9a-f]{64}$/);
    const repositoryGates = stage.plan.gates.filter(
      (gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN',
    );
    expect(repositoryGates.length).toBeGreaterThan(0);
    expect(
      stage.plan.gates.some(
        (gate) =>
          gate.provenance.source === 'MERGESUTRA_BUILTIN' &&
          gate.argv.join(' ') === 'git diff --check',
      ),
    ).toBe(true);

    for (const gate of repositoryGates) {
      expect(stage.run.gates.find((entry) => entry.gateId === gate.id)).toMatchObject({
        status: 'BLOCKED',
        requiresConsent: true,
        receipt: { result: 'BLOCKED', termination: 'NOT_EXECUTED' },
      });
    }
    // Only MergeSutra's own check was allowed to speak.
    expect(gates.calls).toEqual(['git diff --check']);

    expect(stage.run.result).toBe('BLOCKED');
    expect(stage.record.outcome).toBe('VERIFICATION_BLOCKED');
    expect(stage.record.executionConsent).toBeNull();
    expect(stage.record.nextStage).toMatch(/REVIEW/);
    expect(stage.record.nextStage).not.toMatch(/CONTRIBUTION_READY/);
    expect(stage.record.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['Verification plan', 'Execution consent', 'Verification run']),
    );
  });

  it('runs exactly the gates the operator names, under a consent bound to this plan', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const first = await runVerifyStage(
      { runId: source.runId },
      { store: prepared.store, now: () => NOW, ...scriptedGates() },
    );
    const repositoryIds = first.plan.gates
      .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
      .map((gate) => gate.id);
    const gates = scriptedGates();

    const stage = await runVerifyStage(
      { runId: source.runId, allow: repositoryIds },
      { store: prepared.store, now: () => NOW, ...gates },
    );

    for (const gate of first.plan.gates) {
      expect(gates.calls, gate.command).toContain(gate.argv.join(' '));
    }
    expect(stage.consent).not.toBeNull();
    expect(stage.consent?.planDigest).toBe(scopeDigest(stage.plan));
    expect(stage.consent?.gateIds).toEqual(repositoryIds);
    expect(stage.run.result).toBe('PASS');
    expect(stage.record.outcome).toBe('VERIFICATION_PASS');
    expect(stage.record.stage).toBe('verify');
    expect(stage.evidence.verification).toBe('PASS');
    expect(stage.evidence.contributionReady).toBe(false);

    const loaded = await prepared.store.load(source.runId);
    expect(JSON.parse(JSON.stringify(loaded.verification))).toEqual(
      JSON.parse(JSON.stringify(stage.run)),
    );
  });

  it('files the loop’s FINISH as a claim and lets no status rest on it', async () => {
    const { prepared, source } = await implementedRun(tempDirs);
    const repositoryIds = (
      await runVerifyStage(
        { runId: source.runId },
        { store: prepared.store, now: () => NOW, ...scriptedGates() },
      )
    ).plan.gates
      .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
      .map((gate) => gate.id);

    const stage = await runVerifyStage(
      { runId: source.runId, allow: repositoryIds },
      { store: prepared.store, now: () => NOW, ...scriptedGates() },
    );

    expect(stage.evidence.claims).toEqual([
      {
        source: expect.stringContaining('implement'),
        text: expect.stringContaining('all criteria'),
      },
    ]);
    // The criteria this contract derives are the repository's own, quoted as
    // their manifests spell them. If none of them reaches a receipt, the trace
    // from a requirement to the command that proved it has broken somewhere.
    const passed = stage.evidence.criteria.filter((entry) => entry.status === 'PASS');
    expect(passed.length, 'no criterion was carried by a receipt').toBeGreaterThan(0);
    for (const entry of passed) {
      expect(entry.sufficiency, entry.criterionId).toBe('VERIFIED');
      expect(entry.gateIds.length, entry.criterionId).toBeGreaterThan(0);
    }
  });

  it('refuses a workspace that has moved off the commit its run recorded', async () => {
    const { prepared, source, repoDir } = await implementedRun(tempDirs);
    await put(repoDir, 'unrelated.ts', 'export const x = 1;\n');
    const add = await defaultRunner('git', ['-C', repoDir, 'add', '-A']);
    const commit = await defaultRunner('git', ['-C', repoDir, 'commit', '-q', '-m', 'moved on']);
    expect(add.code).toBe(0);
    expect(commit.code).toBe(0);

    const error = await errorFrom(() =>
      runVerifyStage(
        { runId: source.runId },
        { store: prepared.store, now: () => NOW, ...scriptedGates() },
      ),
    );
    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/Cannot name a patch/);
  });
});

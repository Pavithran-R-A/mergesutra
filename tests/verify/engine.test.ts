import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult, Runner } from '../../src/core/runner.js';
import { scopeDigest } from '../../src/verify/consent.js';
import {
  parseVerificationRun,
  runVerification,
  verdictIsPassed,
  type VerificationRun,
} from '../../src/verify/engine.js';
import {
  WORKSPACE,
  EXITED_FAILING,
  SUCCEEDED,
  builtinGate,
  consentFor,
  identitiesProbe,
  planOf,
  plannedGate,
  steppingClock,
  verifyScripted,
} from '../helpers/verification.js';

/**
 * Running a plan, and writing down what came back.
 *
 * Every command is answered by a scripted runner, so these tests measure the
 * engine's judgement and not what this machine happens to have installed. No
 * BharatCode credential appears anywhere in this file: nothing here asks a model
 * anything, which is the point of a deterministic engine.
 *
 * The shared `verifyScripted` injects a patch probe that reports "nothing changed",
 * because a test about a gate's exit code has no business discovering git on a fake
 * path.
 */

const OK = SUCCEEDED;
const FAILED = EXITED_FAILING;
const TIMED_OUT: RunResult = {
  code: 1,
  stdout: 'half a suite',
  stderr: 'command timed out after 120000ms',
  timedOut: true,
  truncated: false,
};
const TOO_MUCH_OUTPUT: RunResult = {
  code: 1,
  stdout: 'aaaaaaaaaa',
  stderr: 'output exceeded 1048576 bytes; command aborted',
  timedOut: false,
  truncated: true,
};

const UNCHANGED = 'b'.repeat(64);

function entry(run: VerificationRun, gateId: string) {
  const found = run.gates.find((gate) => gate.gateId === gateId);
  if (!found) throw new Error(`the run reported no outcome for ${gateId}`);
  return found;
}

describe('running the gates a plan names', () => {
  it('runs a gate MergeSutra wrote itself and records what it reported', async () => {
    const plan = planOf([builtinGate({ id: 'VG-001' })]);
    const calls: string[] = [];

    const run = await verifyScripted(plan, calls, { 'git diff --check': OK });

    expect(calls).toEqual(['git diff --check']);
    expect(entry(run, 'VG-001').receipt).toMatchObject({
      result: 'PASS',
      exitCode: 0,
      termination: 'EXITED',
      gateId: 'VG-001',
    });
    expect(run.result).toBe('PASS');
  });

  it('hands the runner the directory and the timeout this gate was planned with', async () => {
    const gate = plannedGate({ id: 'VG-001', cwd: 'packages/core', timeoutMs: 45_000 });
    const plan = planOf([gate]);
    const seen: { cwd: string; timeoutMs: number }[] = [];

    await runVerification(
      { plan, workspace: WORKSPACE, consent: consentFor(plan, ['VG-001']) },
      {
        now: steppingClock(),
        runFor: (spec) => {
          seen.push(spec);
          return async () => OK;
        },
        currentPatchIdentity: identitiesProbe([UNCHANGED]),
      },
    );

    expect(seen).toEqual([{ cwd: path.resolve(WORKSPACE, 'packages/core'), timeoutMs: 45_000 }]);
  });

  it('leaves a repository gate unrun when nobody consented to it', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001' })]);
    const calls: string[] = [];

    const run = await verifyScripted(plan, calls, { 'npm test': OK });
    const gate = entry(run, 'VG-001');

    expect(calls).toEqual([]);
    expect(gate.status).toBe('BLOCKED');
    expect(gate.code).toBe('BLOCKED_REPO_EXECUTION_APPROVAL_REQUIRED');
    expect(gate.requiresConsent).toBe(true);
    expect(gate.receipt).toMatchObject({
      result: 'BLOCKED',
      exitCode: null,
      termination: 'NOT_EXECUTED',
    });
    expect(run.result).toBe('BLOCKED');
  });

  it('says a stale yes is what is missing, and that a fresh one would fix it', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001' })]);
    // The same gate id, for a plan whose commands are not the ones agreed to —
    // which is what a repaired patch's re-verification looks like.
    const elsewhere = planOf([plannedGate({ id: 'VG-001', argv: ['npm', 'run', 'test'] })]);
    const calls: string[] = [];

    const run = await verifyScripted(
      plan,
      calls,
      { 'npm test': OK },
      consentFor(elsewhere, ['VG-001']),
    );
    const gate = entry(run, 'VG-001');

    expect(calls).toEqual([]);
    expect(gate.code).toBe('BLOCKED_REPO_EXECUTION_CONSENT_STALE');
    // The remedy for a stale yes has the same shape as the remedy for no yes:
    // name these gates against this plan. Reporting `false` here would send the
    // operator off to do something that changes nothing.
    expect(gate.requiresConsent).toBe(true);
  });

  it('refuses a destructive gate even when the operator consented to it', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001', argv: ['rm', '-rf', 'node_modules'] })]);
    const calls: string[] = [];

    const run = await verifyScripted(plan, calls, {}, consentFor(plan, ['VG-001']));

    expect(calls).toEqual([]);
    expect(entry(run, 'VG-001').status).toBe('REFUSED');
    expect(entry(run, 'VG-001').receipt.result).toBe('REFUSED');
    expect(run.result).toBe('BLOCKED');
  });

  it('refuses a gate whose working directory is not inside the workspace it owns', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001', cwd: '../sibling-run' })]);
    const calls: string[] = [];

    const run = await verifyScripted(plan, calls, {}, consentFor(plan, ['VG-001']));

    expect(calls).toEqual([]);
    expect(entry(run, 'VG-001').reason).toMatch(/outside/i);
    expect(entry(run, 'VG-001').receipt.termination).toBe('NOT_EXECUTED');
  });
});

describe('what one gate contributed', () => {
  it('keeps running independent gates after one fails', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'] }),
    ]);
    const calls: string[] = [];

    const run = await verifyScripted(
      plan,
      calls,
      { 'npm test': FAILED, 'npm run lint': OK },
      consentFor(plan, ['VG-001', 'VG-002']),
    );

    expect(calls).toEqual(['npm test', 'npm run lint']);
    expect(entry(run, 'VG-001').receipt.result).toBe('FAIL');
    expect(entry(run, 'VG-002').receipt.result).toBe('PASS');
    expect(run.result).toBe('FAIL');
  });

  it('records a timed-out gate as inconclusive, never as a pass', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001' })]);

    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': TIMED_OUT },
      consentFor(plan, ['VG-001']),
    );

    expect(entry(run, 'VG-001').receipt).toMatchObject({
      result: 'INCONCLUSIVE',
      termination: 'TIMED_OUT',
      exitCode: null,
    });
    expect(run.result).toBe('INCONCLUSIVE');
  });

  it('records an output-limit kill as inconclusive, with the status it did return', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001' })]);

    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': TOO_MUCH_OUTPUT },
      consentFor(plan, ['VG-001']),
    );

    expect(entry(run, 'VG-001').receipt).toMatchObject({
      result: 'INCONCLUSIVE',
      termination: 'OUTPUT_LIMIT',
      exitCode: 1,
    });
    // The reason has to survive into the record, or a reader cannot tell an
    // output ceiling from a command that chose to exit 1.
    expect(entry(run, 'VG-001').receipt.stderrSummary).toMatch(/output exceeded \d+ bytes/);
  });

  it('carries on when one gate could not be started, and says so', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'] }),
    ]);
    const hostile: Runner = async (file, args) => {
      if ([file, ...args].join(' ') === 'npm test') throw new Error('spawn npm ENOENT');
      return OK;
    };

    const run = await runVerification(
      { plan, workspace: WORKSPACE, consent: consentFor(plan, ['VG-001', 'VG-002']) },
      {
        now: steppingClock(),
        runFor: () => hostile,
        currentPatchIdentity: identitiesProbe([UNCHANGED]),
      },
    );

    expect(entry(run, 'VG-001').receipt).toMatchObject({
      result: 'INCONCLUSIVE',
      termination: 'NOT_EXECUTED',
      exitCode: null,
    });
    expect(entry(run, 'VG-001').reason).toMatch(/ENOENT/);
    expect(entry(run, 'VG-002').receipt.result).toBe('PASS');
    expect(run.result).toBe('INCONCLUSIVE');
  });
});

describe('which patch each gate describes', () => {
  it('refuses to run any gate when the plan no longer describes the workspace', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001' })]);
    const calls: string[] = [];

    const run = await verifyScripted(
      plan,
      calls,
      { 'npm test': OK },
      consentFor(plan, ['VG-001']),
      ['c'.repeat(64)],
    );

    expect(calls).toEqual([]);
    expect(run.patchPrecondition).toMatchObject({
      status: 'STALE',
      expectedIdentity: UNCHANGED,
      observedIdentity: 'c'.repeat(64),
    });
    expect(entry(run, 'VG-001').receipt.termination).toBe('NOT_EXECUTED');
    expect(entry(run, 'VG-001').reason).toMatch(/stale|changed/i);
    expect(run.result).toBe('BLOCKED');
  });

  it('binds every receipt to the patch the run verified', async () => {
    const plan = planOf([plannedGate({ id: 'VG-001' })]);

    const run = await verifyScripted(plan, [], { 'npm test': OK }, consentFor(plan, ['VG-001']), [
      UNCHANGED,
      UNCHANGED,
    ]);

    expect(entry(run, 'VG-001').receipt.patchIdentity).toBe(UNCHANGED);
    expect(run.contamination).toBeNull();
  });

  it('records that a gate left the workspace different, and cleans up nothing', async () => {
    const rewritten = 'd'.repeat(64);
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'] }),
    ]);
    const calls: string[] = [];

    const run = await verifyScripted(
      plan,
      calls,
      { 'npm test': OK, 'npm run lint': OK },
      consentFor(plan, ['VG-001', 'VG-002']),
      [UNCHANGED, rewritten, rewritten],
    );

    expect(run.contamination).toMatchObject({
      gateId: 'VG-001',
      expectedIdentity: UNCHANGED,
      observedIdentity: rewritten,
    });
    expect(entry(run, 'VG-001').receipt.patchIdentity).toBe(UNCHANGED);
    expect(entry(run, 'VG-002').receipt.patchIdentity).toBe(rewritten);
    expect(run.result).toBe('INCONCLUSIVE');
    expect(calls.some((call) => /reset|clean|checkout/.test(call))).toBe(false);
  });

  it('stops when the workspace can no longer be described as a patch at all', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'] }),
    ]);
    const calls: string[] = [];

    const run = await verifyScripted(
      plan,
      calls,
      { 'npm test': OK },
      consentFor(plan, ['VG-001', 'VG-002']),
      [UNCHANGED, null],
    );

    expect(calls).toEqual(['npm test']);
    expect(run.patchPrecondition).toMatchObject({ status: 'MATCHED' });
    expect(entry(run, 'VG-002').receipt).toMatchObject({
      result: 'NOT_RUN',
      termination: 'NOT_EXECUTED',
    });
    expect(entry(run, 'VG-002').reason).toMatch(/describ|patch/i);
    expect(run.result).toBe('INCONCLUSIVE');
  });
});

describe('stopping a run', () => {
  it('stops at a cancellation and keeps every receipt already earned', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'] }),
    ]);
    const controller = new AbortController();
    const cancelling: Runner = async () => {
      controller.abort();
      return OK;
    };

    const run = await runVerification(
      {
        plan,
        workspace: WORKSPACE,
        consent: consentFor(plan, ['VG-001', 'VG-002']),
        signal: controller.signal,
      },
      {
        now: steppingClock(),
        runFor: () => cancelling,
        currentPatchIdentity: identitiesProbe([UNCHANGED]),
      },
    );

    expect(entry(run, 'VG-001').receipt.result).toBe('PASS');
    expect(entry(run, 'VG-002').receipt).toMatchObject({
      result: 'NOT_RUN',
      termination: 'CANCELLED',
      exitCode: null,
    });
    expect(run.result).toBe('CANCELLED');
  });
});

describe('what the run as a whole is allowed to say', () => {
  it('says PASS only when every gate passed and the patch stayed put', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      builtinGate({ id: 'VG-002', argv: ['git', 'diff', '--check'] }),
    ]);

    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': OK, 'git diff --check': OK },
      consentFor(plan, ['VG-001']),
    );

    expect(run.result).toBe('PASS');
    expect(run.finishedAt).not.toBe(run.startedAt);
    expect(run.planDigest).toBe(scopeDigest(plan));
    expect(run.gates.map((gate) => gate.gateId)).toEqual(['VG-001', 'VG-002']);
  });

  it('is not PASS when a required gate never ran, even though the rest passed', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'] }),
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'] }),
    ]);

    const run = await verifyScripted(plan, [], { 'npm test': OK }, consentFor(plan, ['VG-001']));

    expect(entry(run, 'VG-001').receipt.result).toBe('PASS');
    expect(entry(run, 'VG-002').status).toBe('BLOCKED');
    expect(run.result).toBe('BLOCKED');
  });

  it('repeats what the plan already said was missing', async () => {
    const plan = planOf([builtinGate({ id: 'VG-001' })], {
      missingPrerequisites: ['pnpm is not installed, so `pnpm test` was not made a gate'],
    });

    const run = await verifyScripted(plan, [], { 'git diff --check': OK });

    expect(run.notes.join('\n')).toMatch(/pnpm is not installed/);
  });

  it('will not hand back a run record for a plan that named no gates', async () => {
    await expect(verifyScripted(planOf([]), [], {})).rejects.toThrow(/gates|shape/i);
  });

  it('has no room for a criterion verdict', async () => {
    const plan = planOf([builtinGate({ id: 'VG-001' })]);
    const run = await verifyScripted(plan, [], { 'git diff --check': OK });
    const document = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;

    expect(() =>
      parseVerificationRun({
        ...document,
        criteriaSatisfied: ['AC-1'],
        verdict: 'CONTRIBUTION_READY',
      }),
    ).toThrow(/shape|unknown|invalid/i);
    expect(JSON.stringify(run)).not.toContain('CONTRIBUTION_READY');
  });
});

describe('asking the engine’s verdict whether it passed', () => {
  /**
   * A re-verification after a repair has to tell a passing round from a blocked
   * one, and it may not hold the word for green itself. `PASS` is the engine's
   * vocabulary — it is what `verdictOf` returns after weighing every receipt — so
   * a caller that typed the comparison out would be keeping a second, drifting
   * definition of what passed. This is the one question a caller may ask.
   */
  it('says yes only for the verdict all the gates passed under', () => {
    expect(verdictIsPassed('PASS')).toBe(true);
  });

  it('says no for every verdict that left a gate unpassed', () => {
    for (const verdict of ['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'CANCELLED'] as const) {
      expect(verdictIsPassed(verdict), verdict).toBe(false);
    }
  });
});

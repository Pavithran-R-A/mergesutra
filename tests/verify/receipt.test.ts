import { describe, expect, it } from 'vitest';
import {
  buildReceipt,
  parseGateReceipt,
  summarizeOutput,
  type GateReceipt,
} from '../../src/verify/receipt.js';
import type { PlannedGate } from '../../src/verify/plan.js';

/**
 * A receipt says what MergeSutra did, not what it hoped.
 *
 * The tests below are therefore mostly about the places a receipt could be made
 * to look better than the run was: an exit code that is not there, output that
 * was cut, a credential that rode along in a stack trace.
 */

const GATE: PlannedGate = {
  id: 'VG-001',
  name: 'test',
  command: 'npm test',
  argv: ['npm', 'test'],
  cwd: '.',
  commandForms: ['npm test'],
  requirementLevel: 'REPOSITORY_REQUIRED',
  provenance: {
    source: 'CI_WORKFLOW',
    file: '.github/workflows/ci.yml',
    detail: 'runs `npm test`',
    line: 11,
  },
  corroboratedBy: [],
  relevantCriteria: ['AC-1'],
  executionClass: 'READ_ONLY',
  risk: 'EXECUTE',
  timeoutMs: 120_000,
};

const IDENTITY = 'a'.repeat(64);

function input(over: Record<string, unknown> = {}) {
  return {
    gate: GATE,
    workspace: '/repo/.mergesutra/worktrees/run-1',
    baseSha: 'b'.repeat(40),
    patchIdentity: IDENTITY,
    startedAt: new Date('2026-09-25T10:00:00.000Z'),
    finishedAt: new Date('2026-09-25T10:00:04.500Z'),
    result: 'PASS' as const,
    exitCode: 0,
    termination: 'EXITED' as const,
    stdout: '42 tests passed\n',
    stderr: '',
    ...over,
  };
}

describe('what a receipt records', () => {
  it('carries the gate, the command and where it ran', () => {
    const receipt = buildReceipt(input());

    expect(receipt).toMatchObject({
      gateId: 'VG-001',
      argv: ['npm', 'test'],
      cwd: '.',
      workspace: '/repo/.mergesutra/worktrees/run-1',
      baseSha: 'b'.repeat(40),
      patchIdentity: IDENTITY,
      requirementLevel: 'REPOSITORY_REQUIRED',
      provenanceSource: 'CI_WORKFLOW',
      provenanceFile: '.github/workflows/ci.yml',
    });
  });

  it('states the duration the clock was actually held', () => {
    expect(buildReceipt(input()).durationMs).toBe(4_500);
  });

  it('hashes the whole output and keeps only a bounded tail', () => {
    const long = 'x'.repeat(9_000);
    const receipt = buildReceipt(input({ stdout: long }));

    expect(receipt.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.stdoutSummary.length).toBeLessThanOrEqual(4_096);
    expect(receipt.outputTruncated).toBe(true);
  });

  it('hashes what really ran, so two different runs cannot share a digest', () => {
    const one = buildReceipt(input({ stdout: 'ok\n' }));
    const two = buildReceipt(input({ stdout: 'not ok\n' }));

    expect(one.outputSha256).not.toBe(two.outputSha256);
  });

  it('masks a credential that a failing tool printed', () => {
    const receipt = buildReceipt(
      input({
        result: 'FAIL',
        exitCode: 1,
        stderr: 'failed with Authorization: Bearer sk-secretvalue1234567890abcdef',
      }),
    );

    expect(receipt.stderrSummary).not.toContain('sk-secretvalue1234567890abcdef');
    expect(receipt.redacted).toBe(true);
  });

  it('records that the digest covers the unredacted bytes, not what is quoted', () => {
    const secret = 'token=ghp_abcdefghijklmnopqrstuvwxyz123456';
    const receipt = buildReceipt(input({ stderr: secret }));

    expect(receipt.stderrSummary).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(receipt.digestsUnredactedOutput).toBe(true);
  });

  it('tells two runs apart whose quoted output is identical', () => {
    // Both streams mask to exactly `token=[REDACTED]`, so the only thing that can
    // separate these receipts is a digest taken over the bytes before masking.
    const one = buildReceipt(input({ stderr: 'token=ghp_AAAAAAAAAAAAAAAAAAAA\n' }));
    const two = buildReceipt(input({ stderr: 'token=ghp_BBBBBBBBBBBBBBBBBBBB\n' }));

    expect(one.stderrSummary).toBe(two.stderrSummary);
    expect(one.redacted).toBe(true);
    expect(one.outputSha256).not.toBe(two.outputSha256);
  });

  it('names why the command ended, including when nothing ran at all', () => {
    expect(
      buildReceipt(
        input({
          result: 'BLOCKED',
          exitCode: null,
          termination: 'NOT_EXECUTED',
          stdout: '',
          stderr: '',
        }),
      ),
    ).toMatchObject({ exitCode: null, termination: 'NOT_EXECUTED', result: 'BLOCKED' });
  });

  it('keeps a timeout an inconclusive fact and never a pass', () => {
    const receipt = buildReceipt(
      input({
        result: 'INCONCLUSIVE',
        exitCode: null,
        termination: 'TIMED_OUT',
        stdout: 'half a suite',
      }),
    );

    expect(receipt.result).toBe('INCONCLUSIVE');
    expect(receipt.termination).toBe('TIMED_OUT');
  });

  it('has no field a caller can use to claim a criterion passed', () => {
    const smuggled = { ...input(), criteriaSatisfied: ['AC-1'], verdict: 'CONTRIBUTION_READY' };

    expect(() => buildReceipt(smuggled)).toThrow(/shape|unknown|invalid/i);
  });

  it('refuses an exit code for a gate that never ran', () => {
    expect(() =>
      buildReceipt(
        input({
          result: 'BLOCKED',
          exitCode: 0,
          termination: 'NOT_EXECUTED',
          stdout: '',
          stderr: '',
        }),
      ),
    ).toThrow(/exit|never ran|not execute/i);
  });

  it('refuses a result word that does not exist', () => {
    expect(() => buildReceipt(input({ result: 'MOSTLY_PASSED' }))).toThrow(/result|shape/i);
  });

  it('refuses a receipt that disagrees with itself', () => {
    expect(() =>
      buildReceipt(input({ result: 'PASS', exitCode: 1, termination: 'EXITED' })),
    ).toThrow(/PASS|exit/i);
  });
});

describe('reading a receipt back', () => {
  it('survives a JSON round trip', () => {
    const receipt: GateReceipt = buildReceipt(input());

    expect(parseGateReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it('refuses a document from a schema it does not know', () => {
    const receipt = buildReceipt(input());

    expect(() => parseGateReceipt({ ...receipt, schemaVersion: 99 })).toThrow(/schema|version/i);
  });
});

describe('summarizing output that will be printed', () => {
  it('keeps the end of a long log, where the failure is', () => {
    const summary = summarizeOutput(['line'.repeat(400), 'THE ACTUAL FAILURE'].join('\n'), '');

    expect(summary.text).toContain('THE ACTUAL FAILURE');
    expect(summary.truncated).toBe(true);
  });

  it('leaves short output alone', () => {
    expect(summarizeOutput('all of it\n', '')).toMatchObject({
      text: 'all of it\n',
      truncated: false,
    });
  });
});

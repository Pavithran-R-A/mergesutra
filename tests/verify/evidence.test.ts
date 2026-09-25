import { describe, expect, it } from 'vitest';
import {
  compareRegressionEvidence,
  mapAcceptanceEvidence,
  parseAcceptanceEvidence,
} from '../../src/verify/evidence.js';
import { buildReceipt } from '../../src/verify/receipt.js';
import type { VerificationStep } from '../../src/contract/schema.js';
import type { AcceptanceCriterion } from '../../src/contract/schema.js';
import {
  EXITED_FAILING,
  SUCCEEDED,
  consentFor,
  planOf,
  plannedGate,
  verifyScripted,
} from '../helpers/verification.js';

/**
 * What a criterion is allowed to claim, worked out from receipts alone.
 *
 * A gate result and a criterion status are two different things, and this file
 * is where the gap between them gets either bridged honestly or papered over.
 * Every test here therefore starts from a real run of the engine — the receipts
 * are the ones the engine wrote — and asks only whether the status attached to
 * them is one they can carry.
 *
 * Nothing in this file talks to BharatCode. A model's sentence about its own
 * work is recorded, and changes nothing, which is the point of one of the tests
 * below.
 */

type CriterionView = Pick<AcceptanceCriterion, 'id' | 'statement' | 'verificationPlan'>;

function runs(command: string): VerificationStep {
  return {
    kind: 'test',
    command,
    source: 'REPOSITORY_REQUIRED',
    from: '.github/workflows/ci.yml',
  };
}

function byHand(what: string): VerificationStep {
  return { kind: 'manual', source: 'MERGESUTRA_ADDITIONAL', from: what };
}

function criterion(
  id: string,
  verificationPlan: readonly VerificationStep[],
  statement = `${id} holds`,
): CriterionView {
  return { id, statement, verificationPlan: [...verificationPlan] };
}

function forCriterion(id: string) {
  return { relevantCriteria: [id] };
}

describe('a criterion backed by the gate it asked for', () => {
  it('reaches PASS with the receipt that carries it', async () => {
    const argv = ['vitest', 'run', 'tests/regression.test.ts'];
    const plan = planOf([plannedGate({ id: 'VG-001', argv, ...forCriterion('AC-1') })]);
    const run = await verifyScripted(
      plan,
      [],
      { [argv.join(' ')]: SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs(argv.join(' '))])],
      plan,
      run,
    });

    const one = record.criteria[0];
    if (!one) throw new Error('the record holds no entry for AC-1');
    expect(one).toMatchObject({
      criterionId: 'AC-1',
      status: 'PASS',
      sufficiency: 'VERIFIED',
      gateIds: ['VG-001'],
    });
    expect(one.evidence).toEqual([
      {
        executed: true,
        command: 'vitest run tests/regression.test.ts',
        result: {
          status: 'PASS',
          exitCode: 0,
          outputRef: null,
          durationMs: expect.any(Number),
        },
        provenance: expect.stringContaining('VG-001'),
      },
    ]);
    expect(record.verification).toBe('PASS');
  });

  it('credits the gate that runs the command the repository spelled inside a script', async () => {
    // Stage 3 records a repository gate as the manifest's own body — `vitest
    // run` — while Stage 7 plans the invocation CI spells, `npm test`. One
    // command, two spellings; a matcher that knows only one leaves every real
    // criterion reporting that nothing checked it.
    const plan = planOf([
      plannedGate({
        id: 'VG-001',
        argv: ['npm', 'test'],
        commandForms: ['npm test', 'vitest run'],
        ...forCriterion('AC-1'),
      }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('vitest run')])],
      plan,
      run,
    });

    expect(record.criteria[0]).toMatchObject({
      status: 'PASS',
      sufficiency: 'VERIFIED',
      gateIds: ['VG-001'],
    });
  });

  it('binds a command the contract copied with a shell prompt to the same gate', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('$  npm    test')])],
      plan,
      run,
    });

    expect(record.criteria[0]?.status).toBe('PASS');
  });

  it('will not let a green suite verify a criterion it never mentioned', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [
        criterion('AC-1', [runs('npm test')]),
        criterion('AC-2', [runs('node scripts/check-banner.js')]),
      ],
      plan,
      run,
    });

    expect(
      record.criteria.map((entry) => [entry.criterionId, entry.status, entry.sufficiency]),
    ).toEqual([
      ['AC-1', 'PASS', 'VERIFIED'],
      ['AC-2', 'NOT_AVAILABLE', 'NOT_VERIFIED'],
    ]);
    expect(record.criteria[1]?.limitations.join(' ')).toMatch(/check-banner/);
  });

  it('reports a failed gate as failed evidence, with the exit code it really had', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': EXITED_FAILING },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
    });

    expect(record.criteria[0]).toMatchObject({
      status: 'FAIL',
      sufficiency: 'FAILED',
    });
    expect(record.criteria[0]?.evidence[0]).toMatchObject({
      executed: true,
      result: { status: 'FAIL', exitCode: 1 },
    });
  });

  it('says a gate nobody consented to blocked the criterion, rather than leaving it out', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(plan, [], { 'npm test': SUCCEEDED });

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
    });

    expect(record.criteria[0]).toMatchObject({ status: 'BLOCKED', sufficiency: 'BLOCKED' });
    expect(record.criteria[0]?.evidence[0]).toMatchObject({ executed: false });
    expect(JSON.stringify(record.criteria[0]?.evidence[0])).toMatch(/consent|approv/i);
    expect(record.verification).toBe('BLOCKED');
  });

  it('will not call a criterion verified while one of its own commands never ran', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test'), runs('npm run lint')])],
      plan,
      run,
    });

    expect(record.criteria[0]).toMatchObject({
      status: 'INCONCLUSIVE',
      sufficiency: 'PARTIALLY_VERIFIED',
    });
    expect(record.criteria[0]?.limitations.join(' ')).toMatch(/npm run lint/);
    expect(record.criteria[0]?.evidence).toHaveLength(2);
  });

  it('counts a gate the plan gained after the run as evidence nobody has', async () => {
    const before = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      before,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(before, ['VG-001']),
    );
    const after = planOf([
      ...before.gates,
      plannedGate({ id: 'VG-002', argv: ['npm', 'run', 'lint'], ...forCriterion('AC-1') }),
    ]);

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test'), runs('npm run lint')])],
      plan: after,
      run,
    });

    expect(record.criteria[0]?.status).not.toBe('PASS');
    expect(record.criteria[0]?.limitations.join(' ')).toMatch(/no outcome|did not report/i);
  });

  it('keeps asking for a human when the criterion asked for one', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test'), byHand('the issue')])],
      plan,
      run,
    });

    expect(record.criteria[0]).toMatchObject({
      status: 'INCONCLUSIVE',
      sufficiency: 'MANUAL_REVIEW_REQUIRED',
    });
    expect(record.criteria[0]?.limitations.join(' ')).toMatch(/manual|human/i);
  });

  it('has nothing to mark available when a criterion names no command at all', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-7', [byHand('a reviewer')])],
      plan,
      run,
    });

    expect(record.criteria[0]).toMatchObject({
      status: 'NOT_AVAILABLE',
      sufficiency: 'MANUAL_REVIEW_REQUIRED',
      gateIds: [],
    });
  });

  it('treats a gate that ran out of time as no answer, not a failure of the change', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      {
        'npm test': {
          code: 1,
          stdout: '',
          stderr: 'command timed out after 120000ms',
          timedOut: true,
          truncated: false,
        },
      },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
    });

    expect(record.criteria[0]?.status).toBe('INCONCLUSIVE');
    expect(record.criteria[0]?.evidence[0]).toMatchObject({ executed: false });
  });

  it('drops evidence that describes a patch that is gone', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
      currentPatchIdentity: 'c'.repeat(64),
    });

    expect(record.criteria[0]?.status).toBe('NOT_AVAILABLE');
    expect(record.criteria[0]?.limitations.join(' ')).toMatch(/STALE/i);
    expect(record.currentPatchIdentity).toBe('c'.repeat(64));
    expect(record.patchIdentity).toBe('b'.repeat(64));
  });

  it('files a sentence from the model as a claim, and changes no status with it', async () => {
    const plan = planOf([
      plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
    ]);
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );

    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')]), criterion('AC-2', [runs('node check.js')])],
      plan,
      run,
      claims: [
        {
          source: 'BharatCode FINISH, attempt 3',
          text: 'AC-2 implemented correctly, tests should pass',
        },
      ],
    });

    const ac2 = record.criteria[1];
    expect(ac2).toMatchObject({ criterionId: 'AC-2', status: 'NOT_AVAILABLE' });
    expect(JSON.stringify(ac2)).not.toMatch(/implemented correctly/);
    expect(record.claims).toEqual([
      {
        source: 'BharatCode FINISH, attempt 3',
        text: 'AC-2 implemented correctly, tests should pass',
      },
    ]);
  });
});

describe('the shape of an acceptance evidence record', () => {
  const plan = planOf([
    plannedGate({ id: 'VG-001', argv: ['npm', 'test'], ...forCriterion('AC-1') }),
  ]);

  it('survives being written out and read back', async () => {
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );
    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
    });

    expect(parseAcceptanceEvidence(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('has no field a run could use to declare the contribution ready', async () => {
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );
    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
    });
    const document = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

    expect(record.contributionReady).toBe(false);
    expect(() => parseAcceptanceEvidence({ ...document, contributionReady: true })).toThrow(
      /shape|invalid/i,
    );
    expect(() => parseAcceptanceEvidence({ ...document, verdict: 'CONTRIBUTION_READY' })).toThrow(
      /shape|unknown|invalid/i,
    );
    expect(JSON.stringify(record)).not.toContain('CONTRIBUTION_READY');
  });

  it('carries the run it came from, so a reader can find the receipts', async () => {
    const run = await verifyScripted(
      plan,
      [],
      { 'npm test': SUCCEEDED },
      consentFor(plan, ['VG-001']),
    );
    const record = mapAcceptanceEvidence({
      criteria: [criterion('AC-1', [runs('npm test')])],
      plan,
      run,
    });

    expect(record.runId).toBe(run.runId);
    expect(record.planRevision).toBe(plan.revision);
    expect(record.notes.join(' ')).toMatch(/contribution/i);
  });
});

describe('regression evidence', () => {
  const gate = plannedGate({
    id: 'VG-001',
    argv: ['vitest', 'run', 'tests/regression.test.ts'],
    ...forCriterion('AC-1'),
  });

  function receiptOn(identity: string, result: 'PASS' | 'FAIL', base = gate) {
    return buildReceipt({
      gate: base,
      workspace: '/repo/.mergesutra/worktrees/run-1',
      baseSha: 'a'.repeat(40),
      patchIdentity: identity,
      startedAt: new Date('2026-09-25T10:00:00.000Z'),
      finishedAt: new Date('2026-09-25T10:00:02.000Z'),
      result,
      exitCode: result === 'PASS' ? 0 : 1,
      termination: 'EXITED',
      stdout: '',
      stderr: result === 'PASS' ? '' : 'expected invalid input to be rejected',
    });
  }

  it('calls base FAIL and patched PASS regression evidence', () => {
    const comparison = compareRegressionEvidence(
      receiptOn('e'.repeat(64), 'FAIL'),
      receiptOn('b'.repeat(64), 'PASS'),
    );

    expect(comparison).toMatchObject({
      gateId: 'VG-001',
      demonstrated: true,
      baseResult: 'FAIL',
      patchedResult: 'PASS',
      baseIdentity: 'e'.repeat(64),
      patchedIdentity: 'b'.repeat(64),
    });
    expect(comparison.statement).toMatch(/regression/i);
  });

  it('does not call base PASS and patched PASS a demonstrated regression', () => {
    const comparison = compareRegressionEvidence(
      receiptOn('e'.repeat(64), 'PASS'),
      receiptOn('b'.repeat(64), 'PASS'),
    );

    expect(comparison.demonstrated).toBe(false);
    expect(comparison.statement).toMatch(/not regression evidence|did not need the fix/i);
  });

  it('refuses to compare a gate with a different one', () => {
    const other = plannedGate({ id: 'VG-001', argv: ['npm', 'test'] });

    expect(() =>
      compareRegressionEvidence(
        receiptOn('e'.repeat(64), 'FAIL'),
        receiptOn('b'.repeat(64), 'PASS', other),
      ),
    ).toThrow(/same|different/i);
  });

  it('refuses to compare a patch against itself', () => {
    expect(() =>
      compareRegressionEvidence(
        receiptOn('b'.repeat(64), 'FAIL'),
        receiptOn('b'.repeat(64), 'PASS'),
      ),
    ).toThrow(/same patch|identical/i);
  });

  it('says plainly when one side never produced a result to compare', () => {
    const never = buildReceipt({
      gate,
      workspace: '/repo/.mergesutra/worktrees/run-1',
      baseSha: 'a'.repeat(40),
      patchIdentity: 'e'.repeat(64),
      startedAt: new Date('2026-09-25T10:00:00.000Z'),
      finishedAt: new Date('2026-09-25T10:00:01.000Z'),
      result: 'BLOCKED',
      exitCode: null,
      termination: 'NOT_EXECUTED',
      stdout: '',
      stderr: '',
    });

    const comparison = compareRegressionEvidence(never, receiptOn('b'.repeat(64), 'PASS'));

    expect(comparison.demonstrated).toBe(false);
    expect(comparison.statement).toMatch(/never|not run|no result/i);
  });
});

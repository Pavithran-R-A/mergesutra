import { deriveAcceptanceCriteria } from '../../src/contract/derive.js';
import type { VerificationRun } from '../../src/verify/engine.js';
import { mapAcceptanceEvidence } from '../../src/verify/evidence.js';
import {
  createRunRecord,
  type NewRunRecordInput,
  type RunRecord,
} from '../../src/state/run-record.js';
import { SUCCEEDED, consentFor, planOf, plannedGate, verifyScripted } from './verification.js';

/**
 * Records for the Stage 8 tests.
 *
 * Both the pack builder and the `report` command are tested against records a
 * real Stage 7 would have written: the contract comes from the derivation, the
 * receipts from the engine, and the evidence from the mapper. Nothing here
 * hand-writes a status, because a fixture that types its own `PASS` proves only
 * that the fixture agrees with itself.
 */

export const PACK_RUN_ID = 'run-20260925T000000Z-pack001';
export const PACK_NOW = '2026-09-25T00:00:00.000Z';

export const packContract = deriveAcceptanceCriteria({
  runId: PACK_RUN_ID,
  issue: {
    url: 'https://github.com/projectbharat/datekit/issues/123',
    title: 'Parser accepts invalid empty dates',
    body: '## Acceptance criteria\n\n- [ ] Empty input is rejected.\n',
  },
  repository: {
    fullName: 'projectbharat/datekit',
    baseSha: '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182',
    localPath: null,
  },
  contract: null,
});

export function recordAt(overrides: Partial<NewRunRecordInput> = {}): RunRecord {
  return createRunRecord({
    runId: PACK_RUN_ID,
    createdAt: PACK_NOW,
    stage: 'contract',
    outcome: 'CONTRACT_DERIVED',
    issueRef: {
      host: 'github.com',
      owner: 'projectbharat',
      repo: 'datekit',
      number: 123,
      url: 'https://github.com/projectbharat/datekit/issues/123',
      canonical: 'projectbharat/datekit#123',
    },
    issue: null,
    repository: null,
    base: null,
    local: null,
    contract: null,
    acceptanceContract: packContract,
    checks: [],
    nextStage: 'PLAN',
    ...overrides,
  });
}

export interface VerifiedOptions {
  readonly runId?: string;
  readonly currentPatchIdentity?: string;
  /**
   * The bytes the engine finds when it measures the workspace, when they are not
   * the ones the plan named. Only the engine decides what that means; this
   * helper does not get to call the result stale on its own.
   */
  readonly observedPatchIdentity?: string;
  readonly claims?: readonly { source: string; text: string }[];
  /** Caveats the earlier stages of this run left on the record. */
  readonly recordLimitations?: readonly string[];
}

/** The record outcome `verify` writes for each engine verdict — copied, not judged. */
const OUTCOME_BY_VERDICT: Record<VerificationRun['result'], RunRecord['outcome']> = {
  PASS: 'VERIFICATION_PASS',
  FAIL: 'VERIFICATION_FAIL',
  BLOCKED: 'VERIFICATION_BLOCKED',
  INCONCLUSIVE: 'VERIFICATION_INCONCLUSIVE',
  CANCELLED: 'VERIFICATION_CANCELLED',
};

/** A record holding a real engine run over a scripted process, and its evidence. */
export async function verifiedRecord(
  argv: readonly string[],
  options: VerifiedOptions = {},
): Promise<RunRecord> {
  const runId = options.runId ?? PACK_RUN_ID;
  const contract = deriveAcceptanceCriteria({
    runId,
    issue: {
      url: 'https://github.com/projectbharat/datekit/issues/123',
      title: 'Parser accepts invalid empty dates',
      body: 'The suite must stay green.',
    },
    repository: {
      fullName: 'projectbharat/datekit',
      baseSha: '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182',
      localPath: null,
    },
    contract: null,
    injectedCriteria: [
      {
        statement: 'The suite passes.',
        by: 'pavithran (issue reporter)',
        requirementType: 'functional',
        check: { command: argv.join(' '), kind: 'test' },
      },
    ],
  });
  const plan = planOf([plannedGate({ id: 'VG-001', argv, relevantCriteria: ['AC-1'] })]);
  const consent = consentFor(plan, ['VG-001']);
  const observed = options.observedPatchIdentity ?? plan.patchIdentity;
  const run = await verifyScripted(plan, [], { [argv.join(' ')]: SUCCEEDED }, consent, [
    observed,
    observed,
  ]);
  const evidence = mapAcceptanceEvidence({
    criteria: contract.criteria.map((c) => ({
      id: c.id,
      statement: c.statement,
      verificationPlan: c.verificationPlan,
    })),
    plan,
    run,
    ...(options.currentPatchIdentity ? { currentPatchIdentity: options.currentPatchIdentity } : {}),
    ...(options.claims ? { claims: options.claims } : {}),
  });

  return recordAt({
    runId,
    stage: 'verify',
    outcome: OUTCOME_BY_VERDICT[run.result],
    acceptanceContract: contract,
    verificationPlan: plan,
    executionConsent: consent,
    verification: run,
    evidence,
    limitations: options.recordLimitations ?? [],
    nextStage: 'REVIEW',
  });
}

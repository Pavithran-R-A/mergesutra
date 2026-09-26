import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.js';
import {
  RUN_SCHEMA_VERSION,
  createRunRecord,
  newRunId,
  parseRunRecord,
  type NewRunRecordInput,
  type RunRecord,
} from '../../src/state/run-record.js';
import { deriveAcceptanceCriteria } from '../../src/contract/derive.js';
import { mapAcceptanceEvidence } from '../../src/verify/evidence.js';
import { toIssueDocument, toRepositoryIdentity } from '../../src/github/schemas.js';
import { issuePayload, repositoryPayload } from '../fixtures/github-payloads.js';
import { TEST_REPO } from '../helpers/github.js';
import {
  SUCCEEDED,
  builtinGate,
  consentFor,
  planOf,
  verifyScripted,
} from '../helpers/verification.js';

function minimalRecord(overrides: Partial<NewRunRecordInput> = {}): RunRecord {
  return createRunRecord({
    runId: 'run-20260924T213207Z-abc123',
    createdAt: '2026-09-24T21:32:07.000Z',
    stage: 'intake',
    outcome: 'INTAKE_COMPLETE',
    issueRef: {
      ...TEST_REPO,
      number: 123,
      canonical: 'projectbharat/datekit#123',
      url: 'https://x',
    },
    issue: toIssueDocument(issuePayload),
    repository: toRepositoryIdentity(repositoryPayload, TEST_REPO),
    base: {
      sha: '3f2a1c9d8e7b6a5041322314f5e6d7c8b9a09182',
      shortSha: '3f2a1c9d8e',
      source: 'local-git',
    },
    local: null,
    contract: null,
    checks: [{ name: 'Issue URL', status: 'PASS', detail: 'projectbharat/datekit#123' }],
    nextStage: 'DISCOVERY',
    limitations: [],
    ...overrides,
  });
}

describe('createRunRecord', () => {
  it('stamps the schema version, stage and product version', () => {
    const record = minimalRecord();
    expect(record.schemaVersion).toBe(RUN_SCHEMA_VERSION);
    expect(record.stage).toBe('intake');
    expect(record.mergeSutraVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(record.nextStage).toBe('DISCOVERY');
  });

  it('carries the issue body provenance, not just prose', () => {
    const record = minimalRecord();
    expect(record.issue?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.issue?.untrusted).toBe(true);
    expect(record.base?.source).toBe('local-git');
    expect(record.repository?.source).toBe('github-api');
  });

  it('keeps an Acceptance Contract in the record that stores it', () => {
    // A v3 record may carry criteria for a later stage to verify. If the field
    // were dropped on write, `resume` would silently lose the whole contract.
    const contract = deriveAcceptanceCriteria({
      runId: 'run-20260924T213207Z-abc123',
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
    const record = minimalRecord({
      stage: 'contract',
      outcome: 'CONTRACT_DERIVED',
      acceptanceContract: contract,
    });
    expect(record.acceptanceContract?.criteria.map((c) => c.statement)).toEqual([
      'Empty input is rejected.',
    ]);
    expect(parseRunRecord(JSON.parse(JSON.stringify(record))).acceptanceContract).toEqual(contract);
  });

  it('copies its inputs so a later mutation cannot rewrite history', () => {
    const checks = [{ name: 'Issue URL', status: 'PASS' as const, detail: 'x' }];
    const record = minimalRecord({ checks });
    checks.push({ name: 'Extra', status: 'PASS', detail: 'y' });
    expect(record.checks).toHaveLength(1);
  });
});

describe('a record that carries Stage 7 verification', () => {
  it('keeps the plan, the run, the consent and the derived evidence, round-tripped exactly', async () => {
    const argv = ['git', 'diff', '--check'];
    const verificationPlan = planOf([builtinGate({ id: 'VG-001', argv })]);
    const run = await verifyScripted(verificationPlan, [], { [argv.join(' ')]: SUCCEEDED });
    const evidence = mapAcceptanceEvidence({ criteria: [], plan: verificationPlan, run });

    const record = minimalRecord({
      stage: 'verify',
      outcome: 'VERIFICATION_PASS',
      verificationPlan,
      verification: run,
      executionConsent: consentFor(verificationPlan, ['VG-001']),
      evidence,
    });

    expect(record.stage).toBe('verify');
    expect(record.evidence?.contributionReady).toBe(false);
    expect(parseRunRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('leaves every verification field null until Stage 7 fills one', () => {
    const record = minimalRecord();
    expect(record.verificationPlan).toBeNull();
    expect(record.verification).toBeNull();
    expect(record.evidence).toBeNull();
    expect(record.executionConsent).toBeNull();
  });
});

describe('a record that has reached the review stage', () => {
  /**
   * Stage 9 needs a place in the record for "a second pass read these bytes",
   * and the names are chosen so the record never says more than that.
   * `REVIEW_RECORDED` is not `REVIEW_PASS`: a model that found nothing is not a
   * run that passed. The five names below exist so a script can tell a recorded
   * review from a stale one from an interrupted one without reading a sentence.
   */
  it('records that a review happened, and round-trips it', () => {
    const record = minimalRecord({ stage: 'review', outcome: 'REVIEW_RECORDED' });

    expect(record.stage).toBe('review');
    expect(parseRunRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('names a review that went stale differently from one that was interrupted', () => {
    const stale = minimalRecord({ stage: 'review', outcome: 'REVIEW_STALE' });
    const stopped = minimalRecord({ stage: 'review', outcome: 'REVIEW_CANCELLED' });

    expect(stale.outcome).toBe('REVIEW_STALE');
    expect(stopped.outcome).toBe('REVIEW_CANCELLED');
  });

  it('still refuses a stage nobody defined', () => {
    const written = JSON.parse(JSON.stringify(minimalRecord({ stage: 'review' })));

    let caught: unknown;
    try {
      parseRunRecord({ ...written, stage: 'reviewing' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
  });
});

/**
 * Stage 9R's slot: what each repair cycle did, in the order it did it.
 *
 * The list is empty rather than null for a run that never repaired, because there
 * is no second meaning an empty list could carry here — unlike `review`, where null
 * and "reviewed, found nothing" are different claims. An entry, in turn, is not
 * evidence that the repair worked: a cycle that changed nothing is stored, and says
 * so, which is the distinction the tests below keep apart.
 */
describe('a record that has reached a repair cycle', () => {
  it('lists no executions for a run that never repaired', () => {
    expect(minimalRecord().repairExecutions).toEqual([]);
  });

  it('defaults the slot instead of inventing one when the field is absent', () => {
    const { repairExecutions: _executions, ...written } = minimalRecord();

    expect(parseRunRecord(written).repairExecutions).toEqual([]);
  });

  it('names a repair that ran differently from one that never started', () => {
    const applied = minimalRecord({ stage: 'repair', outcome: 'REPAIR_APPLIED' });
    const refused = minimalRecord({ stage: 'repair', outcome: 'REPAIR_BLOCKED' });

    expect(applied.outcome).toBe('REPAIR_APPLIED');
    expect(refused.outcome).toBe('REPAIR_BLOCKED');
    expect(parseRunRecord(JSON.parse(JSON.stringify(applied)))).toEqual(applied);
  });

  it('still refuses a repair outcome nobody defined', () => {
    const written = JSON.parse(JSON.stringify(minimalRecord({ stage: 'repair' })));

    expect(capture(() => parseRunRecord({ ...written, outcome: 'REPAIR_READY' })).kind).toBe(
      'validation',
    );
  });
});

describe('parseRunRecord', () => {
  it('round-trips through JSON', () => {
    const record = minimalRecord();
    expect(parseRunRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('rejects a record from a future schema version', () => {
    const record = { ...minimalRecord(), schemaVersion: 99 } as unknown as RunRecord;
    const error = capture(() => parseRunRecord(record));
    expect(error.kind).toBe('validation');
    expect(error.message).toMatch(/not readable/);
    expect(error.remediation).toMatch(/version/);
  });

  it('rejects extra fields instead of ignoring them', () => {
    const record = { ...minimalRecord(), api_key: 'sk-leak' } as unknown as RunRecord;
    expect(() => parseRunRecord(record)).toThrow(AppError);
  });

  it('rejects a malformed base sha', () => {
    const record = minimalRecord();
    const broken = { ...record, base: { ...record.base!, sha: 'latest' } };
    expect(capture(() => parseRunRecord(broken)).kind).toBe('validation');
    expect(parseRunRecord({ ...record, base: null }).base).toBeNull();
  });

  it('names the offending path so a broken file is diagnosable', () => {
    const record = { ...minimalRecord(), outcome: 'PROBABLY_FINE' } as unknown as RunRecord;
    const error = capture(() => parseRunRecord(record));
    expect(error.details?.['reason']).toContain('outcome');
  });
});

describe('newRunId', () => {
  it('is deterministic for a fixed clock and source of randomness', () => {
    const id = newRunId(new Date('2026-09-24T21:32:07.481Z'), () => 0.5);
    expect(id).toMatch(/^run-20260924T213207Z-[0-9a-f]{6}$/);
    expect(newRunId(new Date('2026-09-24T21:32:07.481Z'), () => 0.5)).toBe(id);
  });

  it('never contains a separator that could escape the run directory', () => {
    for (const value of [0, 0.5, 0.999999]) {
      const id = newRunId(new Date(), () => value);
      expect(id).toMatch(/^[a-zA-Z0-9._-]+$/);
    }
  });

  it('separates two runs taken in the same second', () => {
    const now = new Date('2026-09-24T21:32:07.000Z');
    expect(newRunId(now, () => 0.1)).not.toBe(newRunId(now, () => 0.9));
  });
});

function capture(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a validation error');
}

import { describe, expect, it } from 'vitest';
import { bindIssueChecks, deriveAcceptanceCriteria } from '../../src/contract/derive.js';
import { parseAcceptanceContract } from '../../src/contract/schema.js';
import { decideExecution } from '../../src/verify/consent.js';
import { buildVerificationPlan } from '../../src/verify/plan.js';
import { operatorBoundGates } from '../../src/verify/workspace.js';

function original() {
  return deriveAcceptanceCriteria({
    runId: 'run-test',
    issue: {
      url: 'https://github.com/acme/repo/issues/1',
      title: 'A bug',
      body: '## Acceptance criteria\n1. Fix case A.\n2. Preserve case B.',
    },
    repository: { fullName: 'acme/repo', baseSha: 'a'.repeat(40), localPath: null },
    contract: null,
  });
}

describe('operator-origin acceptance gates', () => {
  it('never promotes model suggestions or issue prose into an executable gate', () => {
    expect(operatorBoundGates(original())).toEqual([]);
  });

  it('deduplicates identical commands, keeps both criterion ids and human provenance', () => {
    const contract = bindIssueChecks(
      original(),
      [
        { id: 'AC-1', by: 'Maintainer', check: { kind: 'test', command: 'node --test test/acceptance.test.js' } },
        { id: 'AC-2', by: 'Maintainer', check: { kind: 'test', command: 'node --test test/acceptance.test.js' } },
      ],
      '2026-11-09T00:00:00Z',
    );
    const checks = operatorBoundGates(contract);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'test',
      argv: ['node', '--test', 'test/acceptance.test.js'],
      operatorBy: 'Maintainer',
      relevantCriteria: ['AC-1', 'AC-2'],
    });
    const plan = buildVerificationPlan({
      runId: contract.runId,
      baseSha: 'a'.repeat(40),
      patchIdentity: 'b'.repeat(64),
      discovered: { gates: [], refused: [], missingPrerequisites: [], notes: [] },
      additional: checks,
    });
    const gate = plan.gates[0]!;
    expect(gate).toMatchObject({
      requirementLevel: 'USER_REQUESTED',
      provenance: { source: 'USER_SUPPLIED', file: null },
      relevantCriteria: ['AC-1', 'AC-2'],
    });
    expect(decideExecution(gate, { plan, workspace: '/workspace' }).status).toBe(
      'OPERATOR_SUPPLIED',
    );
  });

  it('refuses forged operator labels on repository criteria and invalid commands', () => {
    const bound = bindIssueChecks(
      original(),
      [{ id: 'AC-1', by: 'Maintainer', check: { kind: 'test', command: 'node --test test/a.test.js' } }],
      'now',
    );
    const malformed = parseAcceptanceContract({
      ...bound,
      criteria: bound.criteria.map((criterion) =>
        criterion.id === 'AC-1'
          ? { ...criterion, verificationPlan: [{
              kind: 'test',
              command: 'npm install',
              source: 'MERGESUTRA_ADDITIONAL',
              from: 'operator:Maintainer',
            }] }
          : criterion,
      ),
    });
    expect(() => operatorBoundGates(malformed)).toThrow('operator-bound');
    const repoCriterion = parseAcceptanceContract({
      ...bound,
      criteria: bound.criteria.map((criterion) =>
        criterion.id === 'AC-1'
          ? { ...criterion, source: { kind: 'repository_policy', file: 'ci.yml', line: 1 } }
          : criterion,
      ),
    });
    expect(() => operatorBoundGates(repoCriterion)).toThrow('operator-bound');
  });
});

import { describe, expect, it } from 'vitest';
import type { Gate, RepositoryContract } from '../../src/discovery/contract.js';
import {
  AcceptanceContractUnavailable,
  deriveAcceptanceCriteria,
  withRevision,
  type InjectedCriterion,
} from '../../src/contract/derive.js';
import {
  acceptanceContractSchema,
  parseAcceptanceContract,
  type AcceptanceCriterion,
} from '../../src/contract/schema.js';

const WORKFLOW = '.github/workflows/ci.yml';

function gate(
  kind: Gate['kind'],
  status: Gate['status'],
  command: string | null,
  line: number | null,
): Gate {
  return {
    kind,
    status,
    source: status === 'REPOSITORY_REQUIRED' ? 'REPOSITORY_REQUIRED' : 'OPTIONAL',
    command,
    provenance:
      status === 'REPOSITORY_REQUIRED' && line !== null
        ? {
            file: WORKFLOW,
            detail: `${WORKFLOW}:${line} runs 'npm run check'; package.json:scripts.${kind} declares it`,
            line,
          }
        : status === 'DECLARED_ONLY'
          ? { file: 'package.json', detail: `scripts.${kind}`, line: null }
          : null,
    why:
      status === 'REPOSITORY_REQUIRED'
        ? `CI runs 'check', which reaches the '${kind}' this gate needs`
        : `'${kind}' exists but no CI step was found that runs it`,
  } as Gate;
}

const REQUIRED = [
  gate('format', 'REPOSITORY_REQUIRED', 'prettier --check .', 34),
  gate('lint', 'REPOSITORY_REQUIRED', 'eslint .', 34),
  gate('test', 'REPOSITORY_REQUIRED', 'vitest run', 34),
];

function contractWith(gates: Gate[]): RepositoryContract {
  return {
    schemaVersion: 1,
    mergeSutraVersion: '0.0.1',
    untrusted: true,
    ecosystem: 'node',
    packageManager: {
      name: 'npm',
      source: { file: 'package-lock.json', detail: 'package-lock.json exists' },
    },
    runtimeVersion: {
      value: '22',
      source: { file: 'package.json', detail: 'engines.node = ">=22"' },
    },
    gates,
    ci: {
      provider: 'github-actions',
      workflows: [{ path: WORKFLOW, jobs: ['checks'] }],
      coverage: 'full',
      caveats: [],
      observedCommandCount: 2,
    },
    protectedAreas: { declaredIn: null, status: 'absent', entryCount: 0, samplePaths: [] },
    contributionDocs: [
      {
        path: 'CONTRIBUTING.md',
        status: 'read',
        bytes: 2345,
        truncated: false,
        instructionLikeRules: [],
      },
    ],
    limitations: [],
  } as RepositoryContract;
}

const REPO = {
  fullName: 'datekit/app',
  baseSha: 'a'.repeat(40),
  localPath: null,
};

function derive(overrides: Partial<Parameters<typeof deriveAcceptanceCriteria>[0]> = {}) {
  return deriveAcceptanceCriteria({
    runId: 'run-test-1',
    issue: { url: 'https://github.com/datekit/app/issues/12', title: 't', body: null },
    repository: REPO,
    contract: contractWith(REQUIRED),
    ...overrides,
  });
}

const body = (text: string) => ({
  url: 'https://github.com/datekit/app/issues/12',
  title: 'Reject empty date input',
  body: text,
});

describe('deriveAcceptanceCriteria — from the repository', () => {
  it('turns each CI-required gate into a criterion that cites the workflow', () => {
    const contract = derive();
    const lint = contract.criteria.filter((c) => c.statement.includes('`lint`'));
    expect(lint).toHaveLength(1);
    expect(lint[0]).toMatchObject({
      requirementType: 'convention',
      source: { kind: 'repository_policy', file: WORKFLOW, line: 34 },
      verificationPlan: [{ kind: 'lint', command: 'eslint .', source: 'REPOSITORY_REQUIRED' }],
      status: 'PENDING',
    });
    expect(lint[0]?.limitations[0]).toContain("CI runs 'check'");
  });

  it('adds no criterion for a gate the repository does not enforce', () => {
    const gates = [
      gate('format', 'REPOSITORY_REQUIRED', 'prettier --check .', 34),
      gate('build', 'DECLARED_ONLY', 'tsc -p tsconfig.build.json', null),
      gate('test', 'NOT_DECLARED', null, null),
    ];
    const contract = derive({ contract: contractWith(gates) });
    expect(contract.criteria.map((c) => c.statement)).toEqual([
      "The repository's required `format` check passes.",
    ]);
  });

  it('says to run inspect when no repository contract was compiled', () => {
    const contract = derive({
      contract: null,
      issue: body('- [ ] Empty input is rejected'),
    });
    expect(contract.criteria.every((c) => c.source.kind === 'issue')).toBe(true);
    expect(contract.limitations.join(' ')).toContain('Run `mergesutra inspect` first');
  });

  it('records that a repository enforcing nothing is enforced by nothing', () => {
    const contract = derive({
      contract: contractWith([gate('lint', 'DECLARED_ONLY', 'eslint .', null)]),
      issue: body('- [ ] Empty input is rejected'),
    });
    expect(contract.limitations.join(' ')).toContain('requires no gate CI enforces');
  });
});

describe('deriveAcceptanceCriteria — from the issue', () => {
  it('copies an explicit acceptance list verbatim, in order, without interpreting it', () => {
    const contract = derive({
      issue: body(
        [
          'Parser accepts empty strings.',
          '',
          '## Acceptance criteria',
          '1. Empty input is rejected with a validation error.',
          '2. Existing valid ISO dates still parse.',
          '- [ ] No change to the public function signature.',
        ].join('\n'),
      ),
    });
    const fromIssue = contract.criteria.filter((c) => c.source.kind === 'issue');
    expect(fromIssue.map((c) => c.statement)).toEqual([
      'Empty input is rejected with a validation error.',
      'Existing valid ISO dates still parse.',
      'No change to the public function signature.',
    ]);
    expect(fromIssue.every((c) => c.status === 'PENDING')).toBe(true);
    expect(fromIssue[0]?.limitations[0]).toContain('verbatim');
  });

  it('gives a checkbox list outside any heading the same standing', () => {
    const contract = derive({ issue: body('Fix it.\n- [ ] Rejects empty input\n') });
    expect(contract.criteria[0]?.statement).toBe('Rejects empty input');
  });

  it('does not mine a heading that is not about acceptance', () => {
    const contract = derive({
      issue: body(['## Steps to reproduce', '1. Open the form', '2. Press save'].join('\n')),
    });
    expect(contract.criteria.some((c) => c.source.kind === 'issue')).toBe(false);
    expect(contract.limitations.join(' ')).toContain('no explicit acceptance list');
  });

  it('does not treat a link or a note as a requirement', () => {
    const contract = derive({
      issue: body('## Acceptance criteria\n- see https://example.com/spec\n- note: flaky CI\n'),
    });
    expect(contract.criteria.some((c) => c.source.kind === 'issue')).toBe(false);
  });

  it('merges a repeated item instead of numbering one sentence twice', () => {
    const contract = derive({
      issue: body('## Acceptance criteria\n- [ ] Rejects empty input\n- [ ] Rejects empty input'),
    });
    expect(contract.criteria.filter((c) => c.source.kind === 'issue')).toHaveLength(1);
    expect(contract.limitations.join(' ')).toContain('merged into one criterion');
  });

  it('takes a human-supplied criterion at its word, and says who', () => {
    const injected: InjectedCriterion[] = [
      {
        statement: 'The migration must be reversible.',
        by: 'maintainer comment, approved by @pavithran',
        requirementType: 'safety',
        check: { command: 'npm run test:migration', kind: 'test' },
      },
      {
        statement: 'Copy must be reviewed by product.',
        by: 'human',
        requirementType: 'convention',
        check: null,
      },
    ];
    const contract = derive({ injectedCriteria: injected });
    const human = contract.criteria.filter((c) => c.source.kind === 'human');
    expect(human).toHaveLength(2);
    expect(human[0]?.verificationPlan[0]).toMatchObject({
      kind: 'test',
      source: 'MERGESUTRA_ADDITIONAL',
    });
    expect(human[1]?.verificationPlan[0]).toMatchObject({ kind: 'manual' });
    expect(human[1]?.limitations[0]).toContain('needs human review');
  });

  it('issues come first, then the repository, so the ids read like the work', () => {
    const contract = derive({ issue: body('- [ ] Rejects empty input') });
    expect(contract.criteria.map((c) => [c.id, c.source.kind])).toEqual([
      ['AC-1', 'issue'],
      ['AC-2', 'repository_policy'],
      ['AC-3', 'repository_policy'],
      ['AC-4', 'repository_policy'],
    ]);
  });

  it('is deterministic: the same facts produce the same contract', () => {
    const input = { issue: body('- [ ] Rejects empty input'), repository: REPO };
    const once = derive(input);
    const twice = derive(input);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('refuses to invent an empty contract', () => {
    expect(() =>
      derive({
        contract: null,
        issue: { url: null, title: 'no list here', body: 'Just prose about a bug.' },
      }),
    ).toThrow(AcceptanceContractUnavailable);
    try {
      derive({ contract: null, issue: body('Just prose about a bug.') });
      expect.unreachable();
    } catch (error) {
      expect((error as AcceptanceContractUnavailable).limitations.join(' ')).toContain(
        'refuses to emit an empty contract',
      );
    }
  });
});

describe('the schema refuses unearned success', () => {
  function passCovenant(): Record<string, unknown> {
    const contract = derive({ issue: body('- [ ] Rejects empty input') });
    return JSON.parse(JSON.stringify(contract)) as Record<string, unknown>;
  }

  it('rejects a PASS with no evidence', () => {
    const inflated = passCovenant();
    const criteria = inflated.criteria as Record<string, unknown>[];
    criteria[0] = { ...criteria[0]!, status: 'PASS', evidence: [] };
    expect(() => parseAcceptanceContract(inflated)).toThrow();
  });

  it('rejects a PENDING that already carries evidence', () => {
    const inflated = passCovenant();
    const criteria = inflated.criteria as Record<string, unknown>[];
    criteria[0] = {
      ...criteria[0]!,
      status: 'PENDING',
      evidence: [{ executed: true, command: 'eslint .', provenance: 'x' }],
    };
    expect(() => parseAcceptanceContract(inflated)).toThrow();
  });

  it('rejects an executed evidence with no exit code or reason', () => {
    const inflated = passCovenant();
    const criteria = inflated.criteria as Record<string, unknown>[];
    criteria[0] = {
      ...criteria[0]!,
      status: 'PASS',
      evidence: [{ executed: true, command: 'eslint .', provenance: 'ci' }],
    };
    expect(() => parseAcceptanceContract(inflated)).toThrow();
  });

  it('rejects a field nobody declared', () => {
    const inflated = passCovenant();
    inflated.confidence = 'high';
    expect(() => parseAcceptanceContract(inflated)).toThrow();
    expect(() => acceptanceContractSchema.parse({ ...inflated, confidence: undefined })).toThrow();
  });

  it('round-trips a contract it produced', () => {
    const contract = derive({ issue: body('- [ ] Rejects empty input') });
    expect(parseAcceptanceContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
  });
});

describe('withRevision', () => {
  const base = () => derive({ issue: body('- [ ] Rejects empty input') });

  it('demands a reason', () => {
    expect(() => withRevision(base(), base().criteria, '   ', 'now')).toThrow(/requires a reason/);
  });

  it('keeps history and names what moved', () => {
    const contract = base();
    const kept = contract.criteria.filter((c) => c.source.kind === 'issue');
    const real = withRevision(contract, kept, 'AC-2 duplicated AC-1', '2026-09-25T00:00:00Z');
    expect(real.version).toBe(2);
    expect(real.revisions).toHaveLength(1);
    expect(real.revisions[0]).toMatchObject({
      version: 2,
      reason: 'AC-2 duplicated AC-1',
      createdAt: '2026-09-25T00:00:00Z',
    });
    expect(real.revisions[0]?.affectedCriterionIds).toEqual(['AC-2', 'AC-3', 'AC-4']);
    expect(real.criteria.map((c) => c.id)).toEqual(['AC-1']);
  });

  it('refuses criteria that no longer satisfy the schema', () => {
    const contract = base();
    const broken = [{ id: 'AC-99', status: 'PASS' }] as unknown as AcceptanceCriterion[];
    expect(() => withRevision(contract, broken, 'trying', 'now')).toThrow();
  });
});

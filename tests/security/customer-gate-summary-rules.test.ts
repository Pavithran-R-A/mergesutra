import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'customer-gate-summary.mjs');
const runChild = promisify(execFile);

interface OracleRow {
  id: string;
  verdict: string;
  detail?: string;
}

interface ScenarioRecord {
  scenario: string;
  verdict: string;
  reason?: string;
  problems?: string[];
  exitCodes?: string[];
  oracle?: OracleRow[];
  damage?: string[];
  secrets?: string[];
  productStateFiles?: number;
  cleanup?: Cleanup;
}

interface Cleanup {
  removed: boolean;
  remaining: number;
  lastError: string | null;
}

interface Identity {
  revision?: string;
  platform?: string;
  nodeVersion?: string;
  sandboxImage?: string;
  fixtureBaseSha?: string;
}

interface Summary {
  startedAt?: string;
  finishedAt?: string;
  mergeSutraVersion?: string;
  identity?: Identity;
  scenarios: ScenarioRecord[];
}

interface HarnessOutput {
  failures: Record<string, string[]>;
  scenarioOrder: string[];
  oracleIds: string[];
  mustPass: string[];
  thrown: Record<string, string>;
}

/**
 * The rules live under scripts/, which vitest must not bundle — its loader cannot
 * resolve an absolute path containing spaces. Running them in a real Node process
 * is also the point: the hosted gate executes this exact module, so a test that
 * re-implemented it would prove nothing about what CI runs. Every case below is
 * one mutated summary, and one child answers the whole matrix.
 */
const HARNESS = `
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [payloadPath, libPath] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
const input = JSON.parse(await readFile(payloadPath, 'utf8'));

const failures = {};
const thrown = {};
for (const [name, entry] of Object.entries(input.cases)) {
  const summary = entry.summary === undefined ? input.base : entry.summary;
  try {
    failures[name] = lib.customerGateFailures(
      summary,
      Object.assign({}, input.expected, entry.expected ?? {}),
    );
  } catch (error) {
    thrown[name] = error instanceof Error ? error.message : String(error);
    failures[name] = null;
  }
}

process.stdout.write(
  JSON.stringify({
    failures,
    thrown,
    scenarioOrder: lib.CUSTOMER_SCENARIOS,
    oracleIds: lib.ORACLE_CRITERIA,
    mustPass: lib.ORACLE_MUST_PASS,
  }),
);
`;

const REVISION = 'a'.repeat(40);
const FIXTURE_BASE = '6f3a0adb17389b93fd76b95c21a1c9eb7b161998';
const IMAGE = 'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';

const SCENARIOS = [
  'journey',
  'failed-assertion',
  'interruption',
  'repair',
  'stale-patch',
  'forged-metadata',
  'no-sandbox',
  'repeated',
];

/** Every documented journey stops at a deliberate stage, so every row has a label. */
const stageRow = (name: string): string[] =>
  name === 'journey'
    ? [
        'doctor=0',
        'issue=0',
        'inspect=0',
        'contract=0',
        'plan=0',
        'implement=3',
        'report=3',
        'pr=3',
      ]
    : ['doctor=0', 'issue=0', 'implement=3'];

const oracleRows = (verdict = 'PASS'): OracleRow[] =>
  ['1', '2', '3', '4', '5'].map((n) => ({
    id: `ORACLE-AC-${n}`,
    verdict,
    detail: `criterion ${n} ${verdict}`,
  }));

function scenarioRecord(name: string): ScenarioRecord {
  return {
    scenario: name,
    verdict: 'PASS',
    reason: 'the scenario reached its expected outcome',
    problems: [],
    exitCodes: stageRow(name),
    oracle: oracleRows(),
    damage: [],
    secrets: [],
    productStateFiles: 12,
    cleanup: { removed: true, remaining: 0, lastError: null },
  };
}

const BASE_SUMMARY: Summary = {
  startedAt: '2026-10-19T09:00:00.000Z',
  finishedAt: '2026-10-19T09:20:00.000Z',
  mergeSutraVersion: '0.1.0',
  identity: {
    revision: REVISION,
    platform: 'linux',
    nodeVersion: 'v24.18.0',
    sandboxImage: IMAGE,
    fixtureBaseSha: FIXTURE_BASE,
  },
  scenarios: SCENARIOS.map(scenarioRecord),
};

const EXPECTED = {
  revision: REVISION,
  sandboxImage: IMAGE,
  notBefore: '2026-10-19T08:59:00.000Z',
  now: '2026-10-19T10:00:00.000Z',
};

/** Apply a mutation to a deep copy of the clean summary. */
function mutated(change: (summary: Summary) => void): Summary {
  const copy = structuredClone(BASE_SUMMARY);
  change(copy);
  return copy;
}

const withJourney = (change: (record: ScenarioRecord) => void) =>
  mutated((summary) => {
    const journey = summary.scenarios.find((record) => record.scenario === 'journey');
    if (!journey) throw new Error('no journey row in the fixture');
    change(journey);
  });

const CASES: Record<string, { summary?: Summary; expected?: Partial<typeof EXPECTED> }> = {
  clean: {},
  'summary-absent': { summary: null as unknown as Summary },
  'scenarios-not-a-list': {
    summary: { ...structuredClone(BASE_SUMMARY), scenarios: null as unknown as ScenarioRecord[] },
  },
  'scenario-omitted': {
    summary: mutated((summary) => {
      summary.scenarios = summary.scenarios.filter((record) => record.scenario !== 'repeated');
    }),
  },
  'scenario-duplicated': {
    summary: mutated((summary) => {
      summary.scenarios.push(scenarioRecord('repeated'));
    }),
  },
  'scenario-unknown': {
    summary: mutated((summary) => {
      summary.scenarios[7] = { ...scenarioRecord('repeated'), scenario: 'whatever-passed-locally' };
    }),
  },
  'failure-relabeled-pass': {
    summary: withJourney((record) => {
      record.verdict = 'PASS';
      record.problems = ['customer damage: HEAD moved out from under the run'];
    }),
  },
  'not-pass-verdict': {
    summary: withJourney((record) => {
      record.verdict = 'ERROR';
      record.problems = [];
      record.reason = 'the scenario threw';
    }),
  },
  'pass-with-damage': {
    summary: withJourney((record) => {
      record.damage = ['branch changed from issue-1 to main'];
    }),
  },
  'pass-with-secret': {
    summary: withJourney((record) => {
      record.secrets = ['02-issue.log'];
    }),
  },
  'pass-with-leftover-workspace': {
    summary: withJourney((record) => {
      record.cleanup = { removed: false, remaining: 3, lastError: 'EBUSY rmdir' };
    }),
  },
  'cleanup-unrecorded': {
    summary: withJourney((record) => {
      delete record.cleanup;
    }),
  },
  'oracle-disabled': {
    summary: withJourney((record) => {
      record.oracle = [];
    }),
  },
  'oracle-absent-key': {
    summary: withJourney((record) => {
      delete record.oracle;
    }),
  },
  'oracle-short': {
    summary: withJourney((record) => {
      record.oracle = oracleRows().slice(0, 4);
    }),
  },
  'oracle-duplicate-row': {
    summary: withJourney((record) => {
      record.oracle = [...oracleRows(), ...oracleRows().slice(-1)];
    }),
  },
  'oracle-required-criterion-failed': {
    summary: withJourney((record) => {
      record.oracle = oracleRows().map((row) =>
        row.id === 'ORACLE-AC-2' ? { ...row, verdict: 'FAIL' } : row,
      );
    }),
  },
  'oracle-refusal-scenario': {
    summary: mutated((summary) => {
      const record = summary.scenarios.find((row) => row.scenario === 'failed-assertion');
      if (record) record.oracle = oracleRows('FAIL');
    }),
  },
  'exit-code-null': {
    summary: withJourney((record) => {
      record.exitCodes = ['doctor=0', 'implement=null'];
    }),
  },
  'exit-code-killed': {
    summary: withJourney((record) => {
      record.exitCodes = ['doctor=0', 'issue=0', 'implement=null(killed:SIGKILL)'];
    }),
  },
  'exit-code-timed-out': {
    summary: withJourney((record) => {
      record.exitCodes = ['doctor=0', 'implement=null(timed out after 300000ms)'];
    }),
  },
  'exit-code-killed-looking-row': {
    summary: withJourney((record) => {
      record.exitCodes = ['doctor=0', 'implement=null(killed)'];
    }),
  },
  'exit-codes-absent': {
    summary: withJourney((record) => {
      record.exitCodes = [];
    }),
  },
  'identity-absent': {
    summary: mutated((summary) => {
      delete summary.identity;
    }),
  },
  'identity-other-revision': {
    summary: mutated((summary) => {
      if (summary.identity) summary.identity.revision = 'b'.repeat(40);
    }),
  },
  'identity-abbreviated-sha': {
    summary: mutated((summary) => {
      if (summary.identity) summary.identity.revision = 'd2f16e2';
    }),
  },
  'identity-no-sandbox-image': {
    summary: mutated((summary) => {
      if (summary.identity) delete summary.identity.sandboxImage;
    }),
  },
  'identity-mutable-image': {
    summary: mutated((summary) => {
      if (summary.identity) summary.identity.sandboxImage = 'node:24';
    }),
  },
  'identity-other-image': {
    summary: mutated((summary) => {
      if (summary.identity) summary.identity.sandboxImage = `node@sha256:${'c'.repeat(64)}`;
    }),
  },
  'identity-bad-fixture-sha': {
    summary: mutated((summary) => {
      if (summary.identity) summary.identity.fixtureBaseSha = 'main';
    }),
  },
  'identity-fixture-sha-absent': {
    summary: mutated((summary) => {
      if (summary.identity) delete summary.identity.fixtureBaseSha;
    }),
  },
  'version-absent': {
    summary: mutated((summary) => {
      delete summary.mergeSutraVersion;
    }),
  },
  'evidence-from-an-earlier-run': {
    summary: mutated((summary) => {
      summary.startedAt = '2026-10-18T09:00:00.000Z';
    }),
  },
  'evidence-finished-after-the-gate-ran': {
    summary: mutated((summary) => {
      summary.finishedAt = '2026-10-19T11:00:00.000Z';
    }),
  },
  'unfinished-evidence': {
    summary: mutated((summary) => {
      delete summary.finishedAt;
    }),
  },
  'unparseable-timestamp': {
    summary: mutated((summary) => {
      summary.startedAt = 'yesterday';
    }),
  },
  'gate-given-no-revision': {
    expected: { revision: '' },
  },
  'gate-given-no-image': {
    expected: { sandboxImage: '' },
  },
  'gate-given-no-notBefore': {
    expected: { notBefore: '' },
  },
};

let harness: HarnessOutput;
let scratch: string | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'mergesutra-gate-summary-spec-'));
  const payload = path.join(scratch, 'cases.json');
  await writeFile(
    payload,
    JSON.stringify({ base: BASE_SUMMARY, expected: EXPECTED, cases: CASES }),
    'utf8',
  );
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, payload, LIB],
    { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 32 * 1024 * 1024 },
  );
  harness = JSON.parse(stdout) as HarnessOutput;
});

afterAll(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
});

function failuresFor(name: string): string[] {
  const recorded = harness.failures[name];
  if (recorded === undefined) throw new Error(`the harness ran no case named ${name}`);
  if (recorded === null) {
    throw new Error(`case ${name} threw instead of returning failures: ${harness.thrown[name]}`);
  }
  return recorded;
}

const say = (name: string, fragment: string): string => {
  const found = failuresFor(name).find((failure) => failure.includes(fragment));
  expect(
    found,
    `${name} did not report "${fragment}". It said: ${JSON.stringify(failuresFor(name))}`,
  ).toBeTruthy();
  return found as string;
};

describe('the hosted customer gate reads the harness summary', () => {
  it('names the eight documented journeys, and only those', () => {
    expect(harness.scenarioOrder).toEqual(SCENARIOS);
    expect(harness.mustPass).toEqual(['journey', 'interruption', 'repair', 'repeated']);
    expect(harness.oracleIds).toEqual(['1', '2', '3', '4', '5'].map((n) => `ORACLE-AC-${n}`));
  });

  it('accepts a clean summary, so every mutation below is the only difference', () => {
    expect(failuresFor('clean')).toEqual([]);
  });

  it('fires when a scenario is omitted, duplicated, invented or not a list', () => {
    say('scenario-omitted', 'repeated');
    expect(say('scenario-omitted', 'was not run')).toContain('repeated');
    say('scenario-duplicated', 'twice');
    expect(say('scenario-unknown', 'journey')).toContain('journey');
    expect(failuresFor('scenarios-not-a-list')).toHaveLength(1);
    expect(failuresFor('summary-absent')).toHaveLength(1);
  });

  it('refuses to call a recorded failure a PASS', () => {
    expect(say('failure-relabeled-pass', 'problems')).toContain('journey');
    expect(say('not-pass-verdict', 'ERROR')).toContain('journey');
  });

  it('refuses a PASS that carries customer damage or credential-shaped evidence', () => {
    say('pass-with-damage', 'damage');
    say('pass-with-secret', 'credential');
  });

  it('refuses a PASS that leaked its own disposable workspace, or never recorded cleanup', () => {
    expect(say('pass-with-leftover-workspace', 'workspace')).toContain('journey');
    expect(say('pass-with-leftover-workspace', '3')).toContain('EBUSY');
    expect(say('cleanup-unrecorded', 'workspace')).toContain('journey');
  });

  it('sees a disabled or shrunken independent oracle, and does not over-constrain a refusal scenario', () => {
    say('oracle-disabled', 'oracle');
    say('oracle-absent-key', 'oracle');
    expect(say('oracle-short', '4')).toContain('ORACLE');
    say('oracle-duplicate-row', 'ORACLE-AC-5');
    expect(say('oracle-required-criterion-failed', 'ORACLE-AC-2')).toContain('journey');
    expect(failuresFor('oracle-refusal-scenario')).toEqual([]);
  });

  it('requires an exit code actually read from a process', () => {
    expect(say('exit-code-null', 'implement')).toContain('null');
    say('exit-codes-absent', 'exit code');
  });

  it('reads a deliberate kill as a real observation, and a deadline as a failure', () => {
    expect(failuresFor('exit-code-killed')).toEqual([]);
    expect(say('exit-code-timed-out', 'implement')).toContain('timed out');
    expect(say('exit-code-killed-looking-row', 'implement')).toContain('null(killed)');
  });

  it('binds the evidence to the revision, sandbox image and fixture it claims', () => {
    say('identity-absent', 'identity');
    expect(say('identity-other-revision', REVISION)).toContain('b'.repeat(40));
    say('identity-abbreviated-sha', 'full');
    say('identity-no-sandbox-image', 'sandbox');
    say('identity-mutable-image', 'digest');
    expect(say('identity-other-image', 'c'.repeat(64))).toContain('sandbox');
    say('identity-bad-fixture-sha', 'fixture');
    say('identity-fixture-sha-absent', 'fixture');
    expect(say('version-absent', 'version')).toContain('MergeSutra');
  });

  it('refuses evidence that could have come from another run', () => {
    expect(say('evidence-from-an-earlier-run', '2026-10-18')).toContain('before');
    say('evidence-finished-after-the-gate-ran', 'after');
    say('unfinished-evidence', 'finishedAt');
    say('unparseable-timestamp', 'startedAt');
  });

  it('fails rather than passing vacuously when the gate itself is not configured', () => {
    expect(say('gate-given-no-revision', 'revision')).toContain('gate');
    expect(say('gate-given-no-image', 'sandbox')).toContain('gate');
    expect(say('gate-given-no-notBefore', 'before')).toContain('gate');
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'live-qualification.mjs');
const runChild = promisify(execFile);

interface FixtureProof {
  directBehaviorsPass: boolean;
  checkedScriptPass: boolean;
  checkContainsAllThreeAssertions: boolean;
  missingAssertionInputs: string[];
  dependencyFree: boolean;
  changesWithinFixture: boolean;
  changedPaths: string[];
}

interface HarnessOutput {
  proofs: Record<string, FixtureProof>;
  childEnvKeys: string[][];
  childLabels: string[];
  missing: Record<string, string[]>;
  outside: Record<string, string[]>;
  failures: Record<string, string[]>;
}

// The rules live under scripts/, which vitest must not bundle — its loader cannot
// resolve an absolute path containing spaces. Running them in a real Node process
// is also the point: these tests exercise the shipped module against planted
// workspaces and real child processes, not a re-implementation. The whole case
// matrix is answered by one child so the suite stays inside the documented hook
// budget rather than paying a Node start-up per assertion.
const HARNESS = `
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [payloadPath, libPath] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
const input = JSON.parse(await readFile(payloadPath, 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-livequal-'));
const childEnvKeys = [];
const childLabels = [];
const run = (label, file, args, options) => {
  childLabels.push(label);
  childEnvKeys.push(Object.keys(options.env).sort());
  const result = spawnSync(file, args, {
    ...options,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 8 << 20,
  });
  return { exitCode: result.status };
};

let output;
try {
  const workspaceFor = async (caseName) => {
    const dir = path.join(root, caseName, 'fixtures', 'stage14-e2e');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    for (const [name, contents] of Object.entries(input.fixtures[caseName])) {
      await writeFile(path.join(dir, name), contents, 'utf8');
    }
    return path.join(root, caseName);
  };

  const proofs = {};
  for (const entry of input.inspect) {
    proofs[entry.name] = await lib.inspectFixtureAcceptance({
      workspace: await workspaceFor(entry.fixture),
      run,
      env: { PATH: process.env.PATH, NO_COLOR: '1' },
      readFile,
      changedPaths: entry.changedPaths,
    });
  }

  const missing = {};
  for (const [name, source] of Object.entries(input.missing)) {
    missing[name] = lib.missingAssertionInputs(source);
  }

  const outside = {};
  for (const [name, changed] of Object.entries(input.outside)) {
    outside[name] = lib.changesOutsideAllowlist(changed);
  }

  const failures = {};
  for (const [name, qualifyInput] of Object.entries(input.qualify)) {
    failures[name] = lib.liveQualificationFailures(qualifyInput);
  }

  output = { proofs, childEnvKeys, childLabels, missing, outside, failures };
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(output));
`;

const FIXED_SLUGIFY = `export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const UNFIXED_SLUGIFY = `export function slugify(input) {
  return String(input).toLowerCase().replace(/\\s+/g, '-');
}
`;

const CHECK_HEADER = `import assert from 'node:assert/strict';
import { slugify } from './src/slugify.js';

`;

const COMPLETE_CHECK = `${CHECK_HEADER}assert.equal(slugify('  Hello  World  '), 'hello-world');
assert.equal(slugify('a--b'), 'a-b');
assert.equal(slugify('--x--'), 'x');
`;

const DOUBLE_QUOTED_CHECK = COMPLETE_CHECK.replace(/'/g, '"');

const ONE_ASSERTION_SHORT = `${CHECK_HEADER}assert.equal(slugify('  Hello  World  '), 'hello-world');
assert.equal(slugify('a--b'), 'a-b');
`;

// What a model that talks about the requirement without writing it leaves behind:
// every required input appears in the file, and only one of them is asserted.
const COMMENT_ONLY_CHECK = `${CHECK_HEADER}// issue #8 wants slugify('  Hello  World  ') and slugify("--x--") covered as well.
assert.equal(slugify('a--b'), 'a-b');
`;

const BLOCK_COMMENT_CHECK = `${CHECK_HEADER}assert.equal(slugify('  Hello  World  '), 'hello-world');
assert.equal(slugify('a--b'), 'a-b');
/* TODO: also cover slugify('--x--') the way issue #8 asks. */
`;

const MULTILINE_ASSERT_CHECK = `${CHECK_HEADER}assert.equal(
  slugify('  Hello  World  '),
  'hello-world',
);
assert.equal(slugify('a--b'), 'a-b');
assert.deepStrictEqual([slugify('--x--')], ['x']);
`;

// Comment punctuation carried inside a string literal must not hide the real
// assertions that share the line or follow it.
const SLASHES_IN_STRING_CHECK = `${CHECK_HEADER}const url = 'baseline report: https://example.com/a--b'; assert.equal(slugify('a--b'), 'a-b');
const note = 'open question, tracked in docs at /* stage-14'; assert.equal(slugify('  Hello  World  '), 'hello-world');
assert.equal(slugify('--x--'), 'x');
`;

const COMPUTED_NOT_ASSERTED = `${CHECK_HEADER}const value = slugify('a--b');
assert.equal(value, value);
`;

const BASELINE_ONLY_CHECK = `${CHECK_HEADER}assert.equal(slugify('a--b'), 'a-b');
`;

const THROWING_CHECK = `${COMPLETE_CHECK}throw new Error('the script itself is broken');
`;

const CLEAN_PKG = '{"name":"stage14-e2e","private":true,"type":"module"}\n';

const PASSING_REPO_TEST_PKG =
  '{"name":"stage14-e2e","private":true,"type":"module",' +
  '"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n';

const DEPENDENCY_PKG =
  '{"name":"stage14-e2e","private":true,"type":"module",' +
  '"dependencies":{"left-pad":"^1.0.0"}}\n';

const CHANGED_OK = ['fixtures/stage14-e2e/src/slugify.js', 'fixtures/stage14-e2e/check.mjs'];

const planted = (slugifySource: string, checkSource: string, pkg = CLEAN_PKG) => ({
  'src/slugify.js': slugifySource,
  'check.mjs': checkSource,
  'package.json': pkg,
});

const FIXTURES: Record<string, Record<string, string>> = {
  accepted: planted(FIXED_SLUGIFY, COMPLETE_CHECK),
  'double-quoted': planted(FIXED_SLUGIFY, DOUBLE_QUOTED_CHECK),
  'multi-line-assert': planted(FIXED_SLUGIFY, MULTILINE_ASSERT_CHECK),
  'slashes-in-string': planted(FIXED_SLUGIFY, SLASHES_IN_STRING_CHECK),
  'comment-only': planted(FIXED_SLUGIFY, COMMENT_ONLY_CHECK),
  'block-comment': planted(FIXED_SLUGIFY, BLOCK_COMMENT_CHECK),
  'one-short': planted(FIXED_SLUGIFY, ONE_ASSERTION_SHORT),
  'unfixed-implementation': planted(UNFIXED_SLUGIFY, COMPLETE_CHECK),
  'throwing-check': planted(FIXED_SLUGIFY, THROWING_CHECK),
  'added-dependency': planted(FIXED_SLUGIFY, COMPLETE_CHECK, DEPENDENCY_PKG),
  'repo-test-passes': planted(UNFIXED_SLUGIFY, COMMENT_ONLY_CHECK, PASSING_REPO_TEST_PKG),
};

const INSPECT_CASES = [
  ...Object.keys(FIXTURES).map((name) => ({ name, fixture: name, changedPaths: CHANGED_OK })),
  {
    name: 'outside-allowlist',
    fixture: 'accepted',
    changedPaths: [...CHANGED_OK, 'src/implement/loop.ts'],
  },
];

const MISSING_CASES: Record<string, string> = {
  complete: COMPLETE_CHECK,
  'double-quoted': DOUBLE_QUOTED_CHECK,
  'multi-line-assert': MULTILINE_ASSERT_CHECK,
  'slashes-in-string': SLASHES_IN_STRING_CHECK,
  'comment-only': COMMENT_ONLY_CHECK,
  'block-comment': BLOCK_COMMENT_CHECK,
  'one-short': ONE_ASSERTION_SHORT,
  'computed-not-asserted': COMPUTED_NOT_ASSERTED,
  'baseline-only': BASELINE_ONLY_CHECK,
};

const OUTSIDE_CASES: Record<string, string[]> = {
  allowed: CHANGED_OK,
  'readme-allowed': [...CHANGED_OK, 'fixtures/stage14-e2e/README.md'],
  'source-touched': [...CHANGED_OK, 'package.json'],
  none: [],
};

const passingProof = (overrides: Partial<FixtureProof> = {}): FixtureProof => ({
  directBehaviorsPass: true,
  checkedScriptPass: true,
  checkContainsAllThreeAssertions: true,
  missingAssertionInputs: [],
  dependencyFree: true,
  changesWithinFixture: true,
  changedPaths: CHANGED_OK,
  ...overrides,
});

const base = {
  completionCount: 7,
  elapsedMs: 9 * 60_000,
  deadlineMs: 25 * 60_000,
  verifyExit: 0,
  implementation: { status: 'COMPLETED_BY_MODEL' },
  fixtureProof: passingProof(),
  review: { findings: [] },
  repairPlanPresent: false,
};

const QUALIFY_CASES: Record<string, unknown> = {
  passing: base,
  'behaviour-unproven': { ...base, fixtureProof: passingProof({ directBehaviorsPass: false }) },
  'assertions-missing': {
    ...base,
    fixtureProof: passingProof({
      checkContainsAllThreeAssertions: false,
      missingAssertionInputs: ['--x--'],
    }),
  },
  'stopped-at-limit': { ...base, implementation: { status: 'STOPPED_AT_LIMIT' } },
  'required-files-untouched': {
    ...base,
    fixtureProof: passingProof({ changedPaths: ['fixtures/stage14-e2e/README.md'] }),
  },
  'findings-open': { ...base, review: { findings: [{ id: 'F1' }] } },
  'review-incomplete': { ...base, review: null },
  'repair-plan-unapproved': { ...base, repairPlanPresent: true },
  'ceiling-breached': { ...base, completionCount: 13 },
  'clock-breached': { ...base, elapsedMs: 25 * 60_000 + 1 },
  'verify-failed': { ...base, verifyExit: 1 },
  'every-criterion-fails': {
    completionCount: 13,
    elapsedMs: 26 * 60_000,
    deadlineMs: 25 * 60_000,
    verifyExit: 2,
    implementation: null,
    fixtureProof: null,
    review: null,
    repairPlanPresent: true,
  },
};

const CEILING = 'observed model requests exceeded the chain ceiling';
const CLOCK = 'live chain exceeded the 25-minute wall-clock ceiling';
const VERIFY = 'deterministic verification did not pass';
const FINISHED = 'the implementation loop did not finish the requested fixture task';
const ACCEPTANCE = 'the independent fixture acceptance criteria were not all satisfied';
const REVIEW = 'the model review reported findings or could not be completed cleanly';
const REPAIR = 'review produced a repair plan; human digest approval is required before any repair';

let harness: HarnessOutput;
let scratch: string | undefined;
let harnessMs = 0;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'mergesutra-livequal-spec-'));
  const payload = path.join(scratch, 'cases.json');
  await writeFile(
    payload,
    JSON.stringify({
      fixtures: FIXTURES,
      inspect: INSPECT_CASES,
      missing: MISSING_CASES,
      outside: OUTSIDE_CASES,
      qualify: QUALIFY_CASES,
    }),
    'utf8',
  );
  const startedAt = Date.now();
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, payload, LIB],
    { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 32 * 1024 * 1024 },
  );
  harnessMs = Date.now() - startedAt;
  harness = JSON.parse(stdout) as HarnessOutput;
});

afterAll(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
});

const proof = (name: string): FixtureProof => {
  const recorded = harness.proofs[name];
  if (!recorded) throw new Error(`the harness recorded no fixture proof for ${name}`);
  return recorded;
};

describe('the live fixture-acceptance scanner, run against planted workspaces', () => {
  it('passes a workspace where the required behavior is both implemented and asserted', () => {
    expect(proof('accepted')).toEqual({
      directBehaviorsPass: true,
      checkedScriptPass: true,
      checkContainsAllThreeAssertions: true,
      missingAssertionInputs: [],
      dependencyFree: true,
      changesWithinFixture: true,
      changedPaths: CHANGED_OK,
    });
    expect(harness.childLabels.slice(0, 2)).toEqual([
      'fixture-independent-acceptance',
      'fixture-check-file',
    ]);
  });

  it('runs every fixture child with the caller’s credential-free environment', () => {
    expect(harness.childEnvKeys).toHaveLength(INSPECT_CASES.length * 2);
    expect(harness.childEnvKeys.every((keys) => keys.join() === 'NO_COLOR,PATH')).toBe(true);
  });

  it('answers the whole case matrix from one real Node process, inside the hook budget', () => {
    expect(Object.keys(harness.proofs)).toHaveLength(INSPECT_CASES.length);
    expect(harnessMs).toBeLessThan(25_000);
  });

  it('does not count required inputs that only appear in a line comment', () => {
    expect(proof('comment-only').checkContainsAllThreeAssertions).toBe(false);
    expect(harness.missing['comment-only']).toEqual(['  Hello  World  ', '--x--']);
  });

  it('does not count required inputs that only appear in a block comment', () => {
    expect(proof('block-comment').checkContainsAllThreeAssertions).toBe(false);
    expect(harness.missing['block-comment']).toEqual(['--x--']);
  });

  it('does not count a required input that is computed but never asserted', () => {
    expect(harness.missing['computed-not-asserted']).toContain('a--b');
  });

  it('reports the two inputs the untouched baseline check file never covered', () => {
    expect(harness.missing['baseline-only']).toEqual(['  Hello  World  ', '--x--']);
  });

  it('counts a double-quoted assertion call as asserting the input', () => {
    expect(proof('double-quoted').checkContainsAllThreeAssertions).toBe(true);
    expect(harness.missing['double-quoted']).toEqual([]);
  });

  it('counts an assertion whose call is spread over several lines', () => {
    expect(proof('multi-line-assert').checkContainsAllThreeAssertions).toBe(true);
    expect(harness.missing['multi-line-assert']).toEqual([]);
  });

  it('is not blinded by comment punctuation carried inside a string literal', () => {
    expect(proof('slashes-in-string').checkContainsAllThreeAssertions).toBe(true);
    expect(harness.missing['slashes-in-string']).toEqual([]);
  });

  it('reports a check file that asserts only two of the three required inputs', () => {
    expect(proof('one-short').checkContainsAllThreeAssertions).toBe(false);
    expect(harness.missing['one-short']).toEqual(['--x--']);
  });

  it('fails the independent behaviors when slugify was never fixed, whatever the check file claims', () => {
    expect(proof('unfixed-implementation').directBehaviorsPass).toBe(false);
    expect(proof('unfixed-implementation').checkedScriptPass).toBe(false);
  });

  it('fails the check-file evidence when the script throws after its assertions', () => {
    expect(proof('throwing-check').directBehaviorsPass).toBe(true);
    expect(proof('throwing-check').checkedScriptPass).toBe(false);
  });

  it('names a fixture that added a dependency', () => {
    expect(proof('added-dependency').dependencyFree).toBe(false);
  });

  it('names a change outside the controlled fixture allowlist', () => {
    expect(proof('accepted').changesWithinFixture).toBe(true);
    expect(proof('outside-allowlist').changesWithinFixture).toBe(false);
    expect(harness.outside['allowed']).toEqual([]);
    expect(harness.outside['readme-allowed']).toEqual([]);
    expect(harness.outside['source-touched']).toEqual(['package.json']);
    expect(harness.outside['none']).toEqual([]);
  });

  it('fails on missing acceptance even when the repository-declared test script passes', () => {
    const evidence = proof('repo-test-passes');
    expect(evidence.checkContainsAllThreeAssertions).toBe(false);
    expect(evidence.directBehaviorsPass).toBe(false);
  });

  it('records in the proof itself which inputs an unaccepted check file lacked', () => {
    expect(proof('comment-only').missingAssertionInputs).toEqual(['  Hello  World  ', '--x--']);
    expect(proof('block-comment').missingAssertionInputs).toEqual(['--x--']);
    expect(proof('accepted').missingAssertionInputs).toEqual([]);
  });
});

describe('the live-qualification conjunction', () => {
  const qualify = (name: string): string[] => {
    const recorded = harness.failures[name];
    if (!recorded) throw new Error(`the harness recorded no verdict for ${name}`);
    return recorded;
  };

  it('qualifies a chain that finished the task and satisfies every independent fact', () => {
    expect(qualify('passing')).toEqual([]);
  });

  it('refuses to qualify on the model’s own completion claim alone', () => {
    expect(qualify('behaviour-unproven')).toEqual([ACCEPTANCE]);
    expect(qualify('assertions-missing')).toEqual([ACCEPTANCE]);
  });

  it('refuses a chain that stopped before the model finished, even with a perfect workspace', () => {
    expect(qualify('stopped-at-limit')).toEqual([FINISHED]);
  });

  it('refuses a chain whose changed paths never touched the required files', () => {
    expect(qualify('required-files-untouched')).toEqual([ACCEPTANCE]);
  });

  it('refuses while the review still reports findings, and while a repair plan is unapproved', () => {
    expect(qualify('findings-open')).toEqual([REVIEW]);
    expect(qualify('review-incomplete')).toEqual([REVIEW]);
    expect(qualify('repair-plan-unapproved')).toEqual([REPAIR]);
  });

  it('refuses a chain that spent more than the ceiling or outlived the wall clock', () => {
    expect(qualify('ceiling-breached')).toEqual([CEILING]);
    expect(qualify('clock-breached')).toEqual([CLOCK]);
    expect(qualify('verify-failed')).toEqual([VERIFY]);
  });

  it('reports every failing condition at once rather than stopping at the first', () => {
    expect(qualify('every-criterion-fails')).toEqual([
      CEILING,
      CLOCK,
      VERIFY,
      FINISHED,
      ACCEPTANCE,
      REVIEW,
      REPAIR,
    ]);
  });
});

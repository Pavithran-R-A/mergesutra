import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPACT_ALLOWED_PATHS,
  inspectCompactAcceptance,
} from '../../scripts/lib/compact-qualification.mjs';
import {
  changesOutsideAllowlist,
  liveQualificationFailures,
} from '../../scripts/lib/live-qualification.mjs';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const changedPaths = ['src/slugify.js', 'test/slugify.test.js'];
const check = [
  "import assert from 'node:assert/strict';",
  "assert.equal(slugify('  Hello  World  '), 'hello-world');",
  "assert.equal(slugify('a--b'), 'a-b');",
  "assert.equal(slugify('--x--'), 'x');",
  "assert.equal(slugify('Hello World'), 'hello-world');",
  "assert.equal(slugify('a.b,c'), 'a-b-c');",
].join('\n');

async function evidence(options = {}) {
  const calls = [];
  const proof = await inspectCompactAcceptance({
    workspace: '/fixture',
    changedPaths,
    readFile: async (file) =>
      file.endsWith('package.json') ? '{"name":"tiny","type":"module"}' : check,
    env: { NO_COLOR: '1' },
    run: (label, file, args, config) => {
      calls.push({ label, file, args, config });
      return { exitCode: 0 };
    },
    ...options,
  });
  return { proof, calls };
}

describe('compact live qualification is separate and still fail-closed', () => {
  it('records independent checks and their narrow model-edit scope', async () => {
    const { proof, calls } = await evidence();
    expect(proof).toMatchObject({
      directBehaviorsPass: true,
      checkedScriptPass: true,
      checkContainsAllThreeAssertions: true,
      baselineAssertionsPreserved: true,
      dependencyFree: true,
      changesWithinFixture: true,
    });
    expect(calls.map((call) => call.label)).toEqual([
      'fixture-independent-acceptance',
      'fixture-check-file',
    ]);
    expect(calls[0].args).toEqual(['scripts/e2e-acceptance-check.mjs']);
    expect(calls[1].args).toEqual(['--test', 'test/slugify.test.js']);
    expect(COMPACT_ALLOWED_PATHS).toContain('src/slugify.js');
  });

  it('rejects unapproved file changes, missing tests and failed independent oracle', async () => {
    expect(changesOutsideAllowlist(['scripts/e2e-acceptance-check.mjs'], COMPACT_ALLOWED_PATHS)).toEqual([
      'scripts/e2e-acceptance-check.mjs',
    ]);
    const { proof: rejected } = await evidence({
      changedPaths: [...changedPaths, 'scripts/e2e-acceptance-check.mjs'],
      readFile: async (file) =>
        file.endsWith('package.json')
          ? '{"dependencies":{"malicious":"1.0.0"}}'
          : "assert.equal(slugify('a--b'), 'a-b');",
      run: () => ({ exitCode: 1 }),
    });
    expect(rejected.directBehaviorsPass).toBe(false);
    expect(rejected.checkContainsAllThreeAssertions).toBe(false);
    expect(rejected.baselineAssertionsPreserved).toBe(false);
    expect(rejected.dependencyFree).toBe(false);
    expect(rejected.changesWithinFixture).toBe(false);
  });

  it('cannot promote compact evidence into full-repository qualification', async () => {
    const { proof } = await evidence();
    const params = {
      completionCount: 10,
      elapsedMs: 5000,
      deadlineMs: 25000,
      verifyExit: 0,
      implementation: { status: 'COMPLETED_BY_MODEL' },
      fixtureProof: proof,
      review: { findings: [] },
      repairPlanPresent: false,
    };
    expect(liveQualificationFailures(params)).toContain(
      'the independent fixture acceptance criteria were not all satisfied',
    );
    expect(
      liveQualificationFailures({
        ...params,
        requiredChangedPaths: ['src/slugify.js', 'test/slugify.test.js'],
      }),
    ).toEqual([]);
  });

  it('requires an explicit workflow fixture choice with all original budget safeguards', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/live-validation.yml'), 'utf8');
    expect(workflow).toContain('fixture_profile:');
    expect(workflow).toContain('MERGESUTRA_E2E_FIXTURE: ${{ inputs.fixture_profile }}');
    expect(workflow).toContain("BHARATCODE_MAX_COMPLETION_REQUESTS: '12'");
    expect(workflow).toContain("BHARATCODE_MAX_RETRIES: '0'");
    expect(workflow).toContain('github.ref ==');
    expect(workflow).not.toContain('pull_request:');
  });
});

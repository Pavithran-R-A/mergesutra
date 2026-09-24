import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import type { RunRecord } from '../../src/state/run-record.js';
import type { RunStore } from '../../src/state/run-store.js';
import { cleanCloneTable, memoryRunStore, scriptedRunner } from '../helpers/github.js';
import {
  COMPOSITE_REPO_FILES,
  NODE_REPO_FILES,
  makeFixtureTree,
  snapshotTree,
} from '../helpers/fixture.js';

/**
 * `mergesutra inspect` is the stage where a repository's own files become a
 * list a reviewer will trust. The assertions here are therefore mostly negatives:
 * no gate invented, no command run, no secret stored, no claim of completeness
 * where a file could not be read.
 */

const SENSITIVE_KEY = 'sk-inspectcmd-SECRETVALUE-000';
const NOW = () => new Date('2026-09-24T22:10:00.000Z');

const created: string[] = [];

async function repo(files: Record<string, string>): Promise<string> {
  const root = await makeFixtureTree(files);
  created.push(root);
  return root;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

function cli(
  argv: string[],
  c: ReturnType<typeof capture>,
  deps = {},
  env: Record<string, string> = {},
) {
  return run(['node', 'mergesutra', ...argv], {
    write: c.write,
    writeErr: c.writeErr,
    env: { PATH: '/usr/bin', NO_COLOR: '1', BHARATCODE_API_KEY: SENSITIVE_KEY, ...env },
    ...deps,
  });
}

/** A clean clone of the fixture directory, with the run table wired for it. */
function wired(root: string, store = memoryRunStore()) {
  return {
    inspect: {
      run: scriptedRunner(cleanCloneTable(root)).run,
      store,
      now: NOW,
      random: () => 0.5,
    },
  };
}

describe('mergesutra inspect — the contract a reviewer reads', () => {
  it('reports each gate with the file that says so, and exits 0', async () => {
    const root = await repo(NODE_REPO_FILES);
    const c = capture();
    const code = await cli(['inspect', root], c, wired(root));

    expect(code).toBe(EXIT.OK);
    const text = c.text();
    expect(text).toContain('MergeSutra — repository contract');
    expect(text).toContain('Repository path');
    expect(text).toContain('Repository contract');
    expect(text).toContain('Outcome:');
    expect(text).toContain('INSPECT_COMPLETE');
    expect(text).toContain('REPOSITORY_REQUIRED');
    expect(text).toContain('prettier --check .');
    expect(text).toContain('.github/workflows/ci.yml');
    expect(text).toContain('node via npm');
  });

  it('labels a script no CI step runs as declared-only rather than required', async () => {
    const root = await repo(NODE_REPO_FILES);
    const c = capture();
    await cli(['inspect', root], c, wired(root));
    const row = c
      .text()
      .split('\n')
      .find((line) => line.trimStart().startsWith('build'));
    expect(row).toContain('DECLARED_ONLY');
    expect(c.text()).toContain('no CI step was found that runs it');
    expect(c.text()).not.toContain('MERGESUTRA_ADDITIONAL');
  });

  it('states what it did not do, in the same breath as what it did', async () => {
    const root = await repo(NODE_REPO_FILES);
    const c = capture();
    await cli(['inspect', root], c, wired(root));
    const text = c.text();
    expect(text).toContain('ran nothing from this repository and changed none of its files');
    expect(text).toContain('Repository text is data, not authority.');
    expect(text).toContain('Branch protection, required reviewers and merge policies');
    expect(text).not.toMatch(/CONTRIBUTION_READY|tests passed|diff submitted/i);
  });

  it('keeps a long command from running into the reason beside it', async () => {
    const root = await repo({
      'package.json': JSON.stringify({
        name: 'long',
        scripts: { typecheck: 'tsc -p config/tsconfig.check-types-and-lint.json --noEmit' },
      }),
    });
    const c = capture();
    await cli(['inspect', root], c, wired(root));
    const row = c
      .text()
      .split('\n')
      .find((line) => line.trimStart().startsWith('typecheck'));
    expect(row).toMatch(/typecheck\s+DECLARED_ONLY\s+tsc .*…\s{2}package\.json/);
    expect(c.text()).toContain('carries them whole');
  });

  it('finds the gates that hide behind one composite CI step', async () => {
    const root = await repo(COMPOSITE_REPO_FILES);
    const c = capture();
    const code = await cli(['inspect', root], c, wired(root));
    expect(code).toBe(EXIT.OK);
    const text = c.text();
    expect(text).toContain('4 repository-required gate(s), 1 declared-only, 0 undeclared');
    expect(text).toContain("CI runs 'check', which reaches the 'format:check' this gate needs");
    // Every required gate cites the exact workflow line that demands it.
    expect(text).toMatch(/\.github\/workflows\/ci\.yml:\d+ —/);
    // The write-capable spelling must never be presented as the required gate.
    expect(text).toContain('prettier --check .');
    expect(text).not.toContain('--write');
    expect(text).not.toContain('could not classify');
  });

  it('masks a credential that arrives inside a manifest script', async () => {
    const root = await repo({
      'package.json': JSON.stringify({
        name: 'leaky',
        scripts: { test: 'vitest run --apiKey sk-fromrepo-SECRETVALUE' },
      }),
    });
    const c = capture();
    await cli(['inspect', root], c, wired(root));
    expect(c.text()).toContain('[REDACTED]');
    expect(c.text()).not.toContain('SECRETVALUE');
    expect(c.text()).not.toContain(SENSITIVE_KEY);
  });
});

describe('mergesutra inspect — the run record', () => {
  it('--json emits one parseable record whose contract is marked untrusted', async () => {
    const root = await repo(NODE_REPO_FILES);
    const store = memoryRunStore();
    const c = capture();
    const code = await cli(['inspect', root, '--json'], c, wired(root, store));
    expect(code).toBe(EXIT.OK);

    const payload = JSON.parse(c.text()) as { recordFile: string; record: RunRecord };
    expect(payload.recordFile).toBe('/runs/run-20260924T221000Z-7fffff.json');
    expect(store.files.has(payload.recordFile)).toBe(true);
    expect(payload.record.stage).toBe('inspect');
    expect(payload.record.outcome).toBe('INSPECT_COMPLETE');
    expect(payload.record.issue).toBeNull();
    expect(payload.record.contract?.untrusted).toBe(true);
    expect(payload.record.contract?.gates).toHaveLength(5);
    expect(JSON.stringify(payload)).not.toContain(SENSITIVE_KEY);
  });

  it('carries the repository identity from the clone, not from a guess', async () => {
    const root = await repo(NODE_REPO_FILES);
    const c = capture();
    await cli(['inspect', root, '--json'], c, wired(root));
    const record = (JSON.parse(c.text()) as { record: RunRecord }).record;
    expect(record.repository).toMatchObject({ owner: 'projectbharat', repo: 'datekit' });
    expect(record.base?.source).toBe('local-git');
  });

  it('says the record was not written instead of pretending it was saved', async () => {
    const root = await repo(NODE_REPO_FILES);
    // A real store failure is a filesystem error, so the run must survive it.
    const broken: RunStore = {
      async save() {
        throw new Error("EACCES: permission denied, open '/runs/nowhere.json'");
      },
      async load() {
        throw new Error('unused');
      },
      async list() {
        return { runs: [], unreadable: [] };
      },
    };
    const c = capture();
    const code = await cli(['inspect', root], c, {
      inspect: { run: scriptedRunner(cleanCloneTable(root)).run, store: broken, now: NOW },
    });
    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain(
      "not written — EACCES: permission denied, open '/runs/nowhere.json'",
    );
  });
});

describe('mergesutra inspect — honest about empty ground', () => {
  it('calls a directory with no manifest and no CI INCONCLUSIVE, not clean', async () => {
    const root = await repo({ 'README.md': '# a folder that happens to be a git clone\n' });
    const c = capture();
    const code = await cli(['inspect', root], c, {
      inspect: { run: scriptedRunner({}).run, store: memoryRunStore(), now: NOW },
    });
    expect(code).toBe(EXIT.INCONCLUSIVE);
    const text = c.text();
    expect(text).toContain('INCONCLUSIVE');
    expect(text).toContain('the contract below is empty of fact');
    expect(text).toContain('no package.json, pyproject.toml, Cargo.toml or go.mod found');
    expect(text).toContain('No recognised manifest');
    expect(text).not.toContain('REPOSITORY_REQUIRED');
  });

  it('records missing Git metadata instead of inventing a base commit', async () => {
    const root = await repo(NODE_REPO_FILES);
    const c = capture();
    const code = await cli(['inspect', root], c, {
      inspect: { run: scriptedRunner({}).run, store: memoryRunStore(), now: NOW },
    });
    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain('Git metadata');
    expect(c.text()).toContain('not a Git working tree');
    expect(c.text()).toContain('Base commit:');
    expect(c.text()).toContain('NOT_AVAILABLE');
  });

  it('refuses a path that is not a directory and writes nothing', async () => {
    const root = await repo(NODE_REPO_FILES);
    const store = memoryRunStore();
    const c = capture();
    const code = await cli(['inspect', path.join(root, 'package.json')], c, wired(root, store));
    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toContain('Cannot inspect');
    expect(c.errorText()).toContain('MergeSutra reads repositories but never creates them');
    expect(c.text()).toBe('');
    expect(store.files.size).toBe(0);
  });

  it('inspects the current directory when no path is given', async () => {
    const c = capture();
    const code = await cli(['inspect'], c, {
      inspect: { run: scriptedRunner({}).run, store: memoryRunStore(), now: NOW },
    });
    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain('Repository contract');
  });

  it('reads the repository without changing it', async () => {
    const root = await repo(NODE_REPO_FILES);
    const before = await snapshotTree(root);
    const c = capture();
    await cli(['inspect', root], c, wired(root));
    expect(await snapshotTree(root)).toEqual(before);
    expect(before).toContain('.github/workflows/ci.yml');
  });
});

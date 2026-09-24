import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectManifests } from '../../src/discovery/manifests.js';
import { openRepoReader } from '../../src/discovery/repo-fs.js';
import { makeFixtureTree } from '../helpers/fixture.js';

/**
 * These tests fix what a repository is allowed to *say about itself*. The
 * detector may report what a manifest declares; it may not infer a toolchain
 * from vibes, and it may not present a value it could not read.
 */

const created: string[] = [];

async function inspect(files: Record<string, string>) {
  const root = await makeFixtureTree(files);
  created.push(root);
  return detectManifests(await openRepoReader(root));
}

function pkg(scripts: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'datekit', scripts, ...extra }, null, 2);
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('detectManifests', () => {
  it('reports a Node repository with its scripts and where each came from', async () => {
    const facts = await inspect({
      'package.json': pkg({ test: 'vitest run', lint: 'eslint .' }),
      'package-lock.json': '{}',
    });
    expect(facts.ecosystem).toBe('node');
    expect(facts.ecosystemSources).toEqual([
      { file: 'package.json', detail: 'package.json exists' },
    ]);
    expect(facts.scripts).toEqual([
      {
        name: 'lint',
        command: 'eslint .',
        source: { file: 'package.json', detail: 'scripts.lint' },
      },
      {
        name: 'test',
        command: 'vitest run',
        source: { file: 'package.json', detail: 'scripts.test' },
      },
    ]);
    expect(facts.lockfiles).toEqual(['package-lock.json']);
    expect(facts.packageManager).toEqual({
      name: 'npm',
      source: { file: 'package-lock.json', detail: 'lockfile' },
    });
    expect(facts.unreadable).toEqual([]);
  });

  it('names the package manager from the lockfile that exists, not the one that is popular', async () => {
    expect(
      (await inspect({ 'package.json': pkg({}), 'pnpm-lock.yaml': '' })).packageManager,
    ).toMatchObject({ name: 'pnpm', source: { file: 'pnpm-lock.yaml' } });
    expect(
      (await inspect({ 'package.json': pkg({}), 'yarn.lock': '' })).packageManager,
    ).toMatchObject({ name: 'yarn' });
  });

  it('says the package manager is unknown rather than defaulting to npm', async () => {
    const facts = await inspect({ 'package.json': pkg({ test: 'node --test' }) });
    expect(facts.packageManager).toEqual({
      name: 'unknown',
      source: { file: 'package.json', detail: 'no lockfile found' },
    });
    expect(facts.lockfiles).toEqual([]);
  });

  it('takes the runtime version from engines.node when it is declared', async () => {
    const facts = await inspect({
      'package.json': pkg({}, { engines: { node: '>=22' } }),
    });
    expect(facts.runtimeVersion).toEqual({
      value: '>=22',
      source: { file: 'package.json', detail: 'engines.node' },
    });
  });

  it('falls back to .nvmrc when the manifest is silent', async () => {
    const facts = await inspect({ 'package.json': pkg({}), '.nvmrc': 'v22.11.0\n' });
    expect(facts.runtimeVersion).toEqual({
      value: 'v22.11.0',
      source: { file: '.nvmrc', detail: '.nvmrc' },
    });
  });

  it('ignores an .nvmrc that does not look like a version', async () => {
    const facts = await inspect({ 'package.json': pkg({}), '.nvmrc': 'system node please\n' });
    expect(facts.runtimeVersion).toBeNull();
  });

  it('recognises Python, Rust and Go from their own manifests', async () => {
    expect((await inspect({ 'pyproject.toml': '[project]\nname = "x"\n' })).ecosystem).toBe(
      'python',
    );
    expect((await inspect({ 'Cargo.toml': '[package]\nname = "x"\n' })).ecosystem).toBe('rust');
    expect((await inspect({ 'go.mod': 'module example.com/x\n' })).ecosystem).toBe('go');
  });

  it('does not invent scripts for a non-Node ecosystem', async () => {
    const facts = await inspect({ 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '' });
    expect(facts.scripts).toEqual([]);
    expect(facts.packageManager).toMatchObject({ name: 'uv' });
  });

  it('reports an empty directory as unknown rather than guessing Node', async () => {
    const facts = await inspect({ 'README.md': '# nothing here' });
    expect(facts.ecosystem).toBe('unknown');
    expect(facts.packageManager).toBeNull();
    expect(facts.scripts).toEqual([]);
  });

  it('reports a broken manifest as unreadable instead of half-parsing it', async () => {
    const facts = await inspect({ 'package.json': '{ "scripts": { "test": ' });
    expect(facts.ecosystem).toBe('node');
    expect(facts.scripts).toEqual([]);
    expect(facts.unreadable).toEqual([{ file: 'package.json', reason: 'is not valid JSON' }]);
  });

  it('refuses to parse a manifest that was cut off by the read limit', async () => {
    const facts = await inspect({
      'package.json': pkg({ pad: 'x'.repeat(80 * 1024) }),
    });
    expect(facts.ecosystem).toBe('node');
    expect(facts.scripts).toEqual([]);
    expect(facts.unreadable[0]?.reason).toMatch(/past the read limit/);
    expect(path.basename(facts.unreadable[0]?.file ?? '')).toBe('package.json');
  });

  it('skips script entries that are not strings', async () => {
    const facts = await inspect({ 'package.json': pkg({ test: 'vitest', weird: 42 }) });
    expect(facts.scripts.map((s) => s.name)).toEqual(['test']);
  });

  it('survives a manifest whose scripts field is not an object', async () => {
    const facts = await inspect({ 'package.json': '{"name":"x","scripts":["test"]}' });
    expect(facts.scripts).toEqual([]);
    expect(facts.unreadable).toEqual([]);
  });

  it('caps a very long script body instead of storing it whole', async () => {
    const facts = await inspect({ 'package.json': pkg({ test: 'y'.repeat(2000) }) });
    expect(facts.scripts[0]?.command).toHaveLength(500);
  });
});

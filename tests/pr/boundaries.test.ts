import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { code, importsSpecifier, reachFrom, SRC } from '../helpers/sourceShape.js';

/**
 * Stage 10 decides nothing about the world, and this file is what makes that a
 * build gate rather than a design intention.
 *
 * The stage's whole claim is that a human's yes is *about* a page and buys no hands
 * with it. Two ways that can rot: a module here starts importing something that can
 * reach a repository (a runner, a writer, a client), or the publication seam that
 * already exists — `publisher.ts`, which can carry a push and a pull request through
 * a fake transport in a test — gets wired into the production path because it was
 * convenient. Neither is visible in a diff of behaviour, so both are checked from
 * source text: the specifiers each module imports, and the import graph a command can
 * actually traverse.
 *
 * Nothing here is executed or imported. This file opens its own siblings and the
 * source of every module it names, and asks them what they name.
 *
 * `publisher.ts` is deliberately in the *no hands* group: it declares a transport
 * interface and returns the one refusal, so it needs no file handle, no process and
 * no client either. What it uniquely gets to contain is the word `push` in a method
 * signature — which is why the reachability tests below are about who imports it, not
 * about what it says.
 */

const PR_DIR = path.join(SRC, 'pr');

/** Pure arithmetic over documents: no measurement, no disk, no network. */
const DOCUMENT_MODULES = [
  'approval.ts',
  'branch.ts',
  'candidate.ts',
  'digest.ts',
  'draft.ts',
  'readiness.ts',
  'record.ts',
] as const;

/** The orchestrator: reads bytes and a rendered pack, through stages that own them. */
const ORCHESTRATION_MODULES: readonly string[] = ['stage.ts'];

/** The seam: two method signatures and a refusal, with no transport of its own. */
const SEAM_MODULES: readonly string[] = ['publisher.ts'];

/** Anything that could reach a byte, a process, a model or a hosting service. */
const FORBIDDEN = [
  'node:fs',
  'node:child_process',
  'core/runner.js',
  'security/writer.js',
  'security/reader.js',
  'github/client.js',
  'bharatcode/client.js',
  'config/load-config.js',
  'implement/loop.js',
  'verify/workspace.js',
  'repair/stage.js',
  'review/engine.js',
] as const;

const ALL_MODULES = [...DOCUMENT_MODULES, ...ORCHESTRATION_MODULES, ...SEAM_MODULES];

async function prSources(): Promise<Map<string, string>> {
  const names = await readdir(PR_DIR);
  const files = names.filter((name) => name.endsWith('.ts')).map((name) => path.join(PR_DIR, name));
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return new Map(files.map((file, index) => [path.basename(file), texts[index] ?? '']));
}

/** Every file under `src`, as `src`-relative paths. */
async function allSources(): Promise<Map<string, string>> {
  const names = await readdir(SRC, { recursive: true });
  const files = names
    .map((name) => String(name))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(SRC, name));
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return new Map(
    files.map((file, index) => [path.relative(SRC, file).replace(/\\/g, '/'), texts[index] ?? '']),
  );
}

/** The production path a person types: the command, and the stage behind it. */
function productionEntries(): string[] {
  return [path.join(SRC, 'cli', 'pr.ts'), path.join(SRC, 'pr', 'stage.ts')];
}

describe('what Stage 10 may not reach for', () => {
  it('reads every module in src/pr, and every one is in a named group', async () => {
    const sources = await prSources();

    expect([...sources.keys()].sort()).toEqual([...ALL_MODULES].sort());
    for (const [name, text] of sources) {
      expect(text.length, name).toBeGreaterThan(200);
    }
  });

  it('imports no filesystem, no process, no client and no second pair of hands', async () => {
    const sources = await prSources();

    const hits: string[] = [];
    for (const [name, text] of sources) {
      for (const specifier of FORBIDDEN) {
        if (importsSpecifier(text, specifier)) hits.push(`${name} imports ${specifier}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('cannot reach a publication transport from the command a person types', async () => {
    const reach = await reachFrom(productionEntries());

    // `publish()` and `unavailableRemote()` exist, are tested against a fake
    // transport, and have no caller in this build. If this ever fails, an
    // approval has quietly become a capability.
    expect([...reach.keys()]).not.toContain('pr/publisher.ts');
    expect([...reach.keys()].filter((file) => file.startsWith('bharatcode/'))).toEqual([]);
    expect([...reach.keys()].filter((file) => file.startsWith('github/'))).toEqual([]);
  });

  it('has no production importer of the seam anywhere in src', async () => {
    const sources = await allSources();

    const importers = [...sources]
      .filter(([, text]) => importsSpecifier(text, 'publisher.js'))
      .map(([file]) => file);
    expect(importers).toEqual([]);
  });

  it('the seam itself is signatures and a refusal, with nothing to call', async () => {
    const publisher = code(await readFile(path.join(PR_DIR, 'publisher.ts'), 'utf8'));

    for (const word of ['fetch(', 'execSync', 'spawn(', 'child_process', 'octokit']) {
      expect(publisher.includes(word), word).toBe(false);
    }
    // The transport is a parameter the caller supplies. Nothing in this file could
    // supply one, which is the difference between a seam and a remote.
    expect(publisher).toMatch(/throw refusal\(/);
    expect(publisher).toMatch(/\basync pushBranch\b/);
    expect(publisher).toMatch(/\basync createPullRequest\b/);
  });

  it('never spells a remote write in the code that decides what to show', async () => {
    const sources = await prSources();

    // Vocabulary a *working* publisher would need. `publisher.ts` may say "no
    // force, no refspec" while refusing them — prose about a thing is not that
    // thing — so the scan is of code with comments stripped, for the shapes only an
    // implementation carries.
    for (const [name, text] of sources) {
      const body = code(text);
      for (const word of [
        '--force',
        'force-with-lease',
        '+refs/',
        ':refs/',
        'api.github.com',
        'gh pr create',
        'npm publish',
        'shell: true',
        'fetch(',
        'execSync',
        'spawn(',
        'child_process',
      ]) {
        expect(body.includes(word), `${name} ${word}`).toBe(false);
      }
    }
  });

  it('says the boundary in the record it writes, not only on the screen', async () => {
    const stage = code(await readFile(path.join(PR_DIR, 'stage.ts'), 'utf8'));

    // The sentence a reader of a run record months later needs, printed by the
    // stage itself rather than left to the CLI: an approval with no action is a
    // decision, and a record that did not say so would read like a publication.
    expect(stage).toMatch(/No branch was pushed and no pull request was opened/);
    expect(stage).toMatch(/published: false/);
  });
});

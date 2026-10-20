import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { code, importsSpecifier, reachFrom, SRC } from '../helpers/sourceShape.js';

/**
 * Stage 10 decides nothing about the world, and this file is what makes that a
 * build gate rather than a design intention.
 *
 * The stage's whole claim is that a human's yes is *about* a page, and that sending
 * that page is a second, explicit act. Three ways that can rot: a module that
 * decides what to show starts importing something that can reach a repository, a
 * module other than the one `--publish` wiring owns starts constructing the real
 * transport, or the stage reaches the transport directly instead of the two-method
 * seam. None is visible in a diff of behaviour, so all three are checked from source
 * text: the specifiers each module imports, and the import graph a command can
 * actually traverse.
 *
 * There are two boundaries here, not one:
 *
 * - **The seam** (`publisher.ts`) is signatures, strict input schemas and a refusal.
 *   It has no file handle, no process and no client. The stage calls it, so an
 *   approved page can be handed to *some* transport without the stage owning one.
 * - **The transport** (`github-publisher.ts`) is the one module with hands: `gh`,
 *   `node:fs` and the Git Data API. It is allowed to exist, and it is allowed to be
 *   imported by exactly one production file — the `pr` command, which constructs it
 *   only when `--publish` is present. The stage must not reach it.
 *
 * Nothing here is executed or imported. This file opens its own siblings and the
 * source of every module it names, and asks them what they name.
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

/** The one module allowed a process, a file handle and a hosting service. */
const TRANSPORT_MODULES: readonly string[] = ['github-publisher.ts'];

/** Everything that may not reach a byte, a process or a hosting service. */
const WITHOUT_HANDS = [...DOCUMENT_MODULES, ...ORCHESTRATION_MODULES, ...SEAM_MODULES] as const;

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

const ALL_MODULES = [...WITHOUT_HANDS, ...TRANSPORT_MODULES];

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

describe('what Stage 10 may not reach for', () => {
  it('reads every module in src/pr, and every one is in a named group', async () => {
    const sources = await prSources();

    expect([...sources.keys()].sort()).toEqual([...ALL_MODULES].sort());
    for (const [name, text] of sources) {
      expect(text.length, name).toBeGreaterThan(200);
    }
  });

  it('keeps every module but the transport free of files, processes, clients and credentials', async () => {
    const sources = await prSources();

    const hits: string[] = [];
    for (const [name, text] of sources) {
      if (!(WITHOUT_HANDS as readonly string[]).includes(name)) continue;
      for (const specifier of FORBIDDEN) {
        if (importsSpecifier(text, specifier)) hits.push(`${name} imports ${specifier}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the stage reaches the seam by name and never the transport behind it', async () => {
    const reach = await reachFrom([path.join(SRC, 'pr', 'stage.ts')]);

    // A positive control first: the walk found the measurement it must go through.
    expect([...reach.keys()]).toEqual(
      expect.arrayContaining(['pr/stage.ts', 'pr/publisher.ts', 'verify/patch.ts']),
    );
    // The stage may ask a transport to publish; it may not own the GitHub one.
    expect([...reach.keys()]).not.toContain('pr/github-publisher.ts');
    expect([...reach.keys()].filter((file) => file.startsWith('bharatcode/'))).toEqual([]);
    expect([...reach.keys()].filter((file) => file.startsWith('github/'))).toEqual([]);
  });

  it('the command reaches the transport, and is the only production file that imports it', async () => {
    const reach = await reachFrom([path.join(SRC, 'cli', 'pr.ts')]);
    expect([...reach.keys()]).toContain('pr/github-publisher.ts');
    expect([...reach.keys()]).toContain('pr/publisher.ts');

    const sources = await allSources();
    const importers = [...sources]
      .filter(([, text]) => importsSpecifier(text, 'github-publisher.js'))
      .map(([file]) => file);
    // One door, opened by the one command that names the flag. A second importer
    // would be a transport reachable from a path nobody decided to give hands.
    expect(importers).toEqual(['cli/pr.ts']);
  });

  it('the transport owns a process and a file handle, and reaches no model credential', async () => {
    const transport = await readFile(path.join(PR_DIR, 'github-publisher.ts'), 'utf8');

    // The two imports that make it a transport rather than a seam.
    expect(importsSpecifier(transport, 'node:fs/promises')).toBe(true);
    expect(importsSpecifier(transport, 'core/runner.js')).toBe(true);
    expect(transport).toMatch(/deps\.run \?\? githubApiRunner/);
    // The login is gh's, so this module reads no environment of its own and could
    // not forward a model key even if one were set.
    expect(code(transport)).not.toMatch(/process\.env/);
    for (const specifier of [
      'bharatcode/client.js',
      'config/load-config.js',
      'github/client.js',
      'implement/loop.js',
      'repair/stage.js',
      'review/engine.js',
      'security/writer.js',
    ]) {
      expect(importsSpecifier(transport, specifier), specifier).toBe(false);
    }
  });

  it('the seam itself is signatures and a refusal, with nothing to call', async () => {
    const publisher = code(await readFile(path.join(PR_DIR, 'publisher.ts'), 'utf8'));

    for (const word of ['fetch(', 'execSync', 'spawn(', 'child_process', 'octokit', 'node:fs']) {
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

    // Vocabulary a working publisher would need. The transport is excluded because
    // it *is* the implementation; this scan is about the modules whose job is to
    // decide what a person sees, which must never grow that vocabulary by accident.
    for (const [name, text] of sources) {
      if (name === 'github-publisher.ts') continue;
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

  it('defaults to the refusal, and says both boundaries in the record it writes', async () => {
    const stage = code(await readFile(path.join(PR_DIR, 'stage.ts'), 'utf8'));

    // A caller that reaches the stage without wiring a transport gets a named no,
    // not an ambient credential.
    expect(stage).toMatch(/deps\.remote \?\? unavailableRemote\(\)/);
    // The two sentences a reader of a run record months later needs, printed by the
    // stage itself rather than left to the CLI: a page that was not sent, and a yes
    // that covered no page, are different facts and neither reads like a publication.
    expect(stage).toMatch(/No branch was pushed and no pull request was opened/);
    expect(stage).toMatch(/publishing was requested, but no/);
    // And a result exists only when a transport reported one.
    expect(stage).toMatch(/published: publication !== null/);
    expect(stage).toMatch(/Nothing was merged/);
  });
});

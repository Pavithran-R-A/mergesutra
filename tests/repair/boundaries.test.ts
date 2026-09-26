import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stage 9 decides; it does not touch.
 *
 * The steering rule behind this file is that a repair must not become a second,
 * less-restricted editing agent. Stage 6 already owns the only pair of hands in
 * this product that can change a workspace: the confined reader, the confined
 * writer, compare-before-write preconditions, the risk-classified tool decision
 * and the loop's own limits. So the modules in src/repair are allowed to be only
 * what they are — arithmetic over documents. They may freeze a plan, compare two
 * patch measurements and say where a cycle should go next; none of those jobs
 * needs a file handle, a child process or a writer.
 *
 * This test is the difference between that being a design intention and being a
 * build gate. It scans the source text for the specifiers that would grant those
 * powers. The strings below are data to be searched for, never imported or run:
 * this file opens nothing but its own siblings.
 *
 * `execution.ts` belongs in the decision group even though its name says
 * otherwise, and that is the useful reading of it: it assembles a record of a
 * cycle from a plan, an approval and two patch measurements that already exist, so
 * by the time it runs the editing is over. A module that writes down what hands
 * did does not itself need any.
 *
 * It also locks in the positive side of the bargain. Stage 9R did gain an
 * execution path, and the file below that names it is the only one allowed to hold
 * it: `stage.ts` reaches the loop, and every other module in this directory still
 * cannot.
 */

const REPAIR_DIR = path.join(process.cwd(), 'src', 'repair');

/**
 * The modules that only do arithmetic over documents, and the one that carries
 * out a decision. Listing them by name is the point: a new file in `src/repair`
 * has to be put in one group or the other before this directory builds, so the
 * question "does this module get hands?" is answered in the test file rather
 * than by whoever added it.
 */
const DECISION_MODULES = [
  'bounds.ts',
  'consent.ts',
  'context.ts',
  'digest.ts',
  'execution.ts',
  'limits.ts',
  'plan.ts',
  'scope.ts',
] as const;

/** Stage 9R's orchestrator: the only repair module allowed to reach the loop. */
const EXECUTION_MODULES: readonly string[] = ['stage.ts'];

/** Anything that could reach a byte, a process or a network port. */
const FORBIDDEN = [
  'node:fs',
  'node:child_process',
  'security/writer.js',
  'security/reader.js',
  'core/runner.js',
  'implement/loop.js',
  'github/client.js',
  'bharatcode/client.js',
] as const;

/**
 * What the orchestrator may reach for. It is the same list minus the loop, which
 * it delegates to — and that minus is the whole rule: the edit happens in
 * Stage 6's hands, so repair code has no writer, no runner and no client of its
 * own. Reaching for GitHub, or for a model, from here would be a second of each.
 */
const EXECUTION_FORBIDDEN = FORBIDDEN.filter((specifier) => specifier !== 'implement/loop.js');

/**
 * Every quoted token in a module, so a specifier is matched by what it *is*.
 *
 * A plain substring test for `'core/runner.js` would miss the way a sibling
 * directory is actually imported — `'../core/runner.js'` — and the miss would be
 * the whole loophole, since every module in `src/repair` reaches everything else
 * in the project that way. So the scan reads the tokens rather than the raw text:
 * a specifier counts as imported when it names a module (relative, absolute or
 * `node:`) and ends with one of the forbidden paths.
 */
const QUOTED = /['"]([^'"\n]*)['"]/g;

function importedSpecifiers(text: string): string[] {
  return [...text.matchAll(QUOTED)]
    .map((match) => match[1] ?? '')
    .filter(
      (token) => token.startsWith('.') || token.startsWith('/') || token.startsWith('node:'),
    )
    .map((token) => token.replace(/^node:/, ''));
}

function forbiddenHits(text: string, forbidden: readonly string[]): string[] {
  const tokens = importedSpecifiers(text);
  return forbidden.filter((specifier) => {
    const bare = specifier.replace(/^node:/, '');
    // A subpath is the same capability under a different prefix: `fs/promises` is
    // still a file handle.
    return tokens.some(
      (token) => token === bare || token.startsWith(`${bare}/`) || token.endsWith(`/${bare}`),
    );
  });
}

async function repairSources(): Promise<Map<string, string>> {
  const entries = await readdir(REPAIR_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(REPAIR_DIR, entry.name));
  const texts = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  const pairs = files.map((file, index) => [path.basename(file), texts[index] ?? ''] as const);
  return new Map(pairs);
}

describe('what the repair modules may not reach for', () => {
  it('reads every module in src/repair, and every one is in a named group', async () => {
    const sources = await repairSources();

    expect([...sources.keys()].sort()).toEqual([...DECISION_MODULES, ...EXECUTION_MODULES].sort());
    for (const [name, text] of sources) {
      expect(text.length, name).toBeGreaterThan(200);
    }
  });

  it('imports no filesystem, no process and no writer', async () => {
    const sources = await repairSources();

    const hits: string[] = [];
    for (const [name, text] of sources) {
      const forbidden = EXECUTION_MODULES.includes(name) ? EXECUTION_FORBIDDEN : FORBIDDEN;
      for (const specifier of forbiddenHits(text, forbidden)) {
        hits.push(`${name} imports ${specifier}`);
      }
    }

    expect(hits).toEqual([]);
  });

  it('keeps the loop reachable from exactly the modules the execution group names', async () => {
    const sources = await repairSources();

    const callers = [...sources]
      .filter(([, text]) => forbiddenHits(text, ['implement/loop.js']).length > 0)
      .map(([name]) => name)
      .sort();

    expect(callers).toEqual([...EXECUTION_MODULES].sort());
  });

  it('names no capability the plan could hand to a model', async () => {
    const sources = await repairSources();
    const text = [...sources.values()].join('\n');

    for (const word of [
      'sudo',
      'shell: true',
      'execSync',
      'spawn(',
      'fetch(',
      'DELETE',
      'unlink',
    ]) {
      expect(text.includes(word), word).toBe(false);
    }
  });

  it('keeps its own verdicts free of any word that could be read as readiness', async () => {
    const sources = await repairSources();

    for (const [name, text] of sources) {
      const code = text.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
      for (const word of ['CONTRIBUTION_READY', 'AI APPROVED', "'PASS'", "'VERIFIED'"]) {
        expect(code.includes(word), `${name} ${word}`).toBe(false);
      }
    }
  });
});

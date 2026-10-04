import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Does the guide a contributor reads describe the project that exists?
 *
 * Stage 13 closed five release-boundary gaps in the shipped artifact and left a sixth
 * surface untouched: the repository's own documents. `CONTRIBUTING.md` told a reader that
 * `npm run check` was `format:check + lint + typecheck + test + build`, which had not been
 * true since S13-2 put the build before the tests so that the boundary verifiers measure
 * compiled bytes, and it named seven of the fifteen scripts the manifest carries — the
 * release boundary itself, `verify:package` and `test:artifact`, was among the omissions, so
 * the one command a contributor has to run before touching packaging was never named.
 * Neither sentence was refuted by anything that runs.
 *
 * A document cannot be held to reality in general, and this file does not try: prose is
 * prose. What it does hold are three relationships that are mechanical, each with a drift
 * it can see coming.
 *
 * 1. **A command the guide tells a person to type must exist.** `npm run X` and
 *    `mergesutra X` are instructions, and an instruction that resolves to nothing costs the
 *    reader a detour through source — the same defect S13-4 closed in the installed
 *    product, one layer up.
 * 2. **A composition the guide spells out must equal the manifest's.** The order of
 *    `check` is a fact about `package.json`, and stating it in prose invites it to go stale
 *    exactly when the script is edited for a good reason.
 * 3. **A path a document cites must be a file.** `src/security/redaction.ts` in a policy
 *    file is a pointer into the tree; when the module moves, the pointer is a lie about
 *    where the guarantee lives.
 *
 * What this file does **not** claim: it does not read meaning into a sentence, so it cannot
 * tell whether an accurate-looking paragraph is honest. `SECURITY.md`'s credential claims
 * were corrected in this slice by reading `src/config/load-config.ts`, and only a person
 * re-doing that reading can repeat it — see the named limits in
 * `docs/SECURITY_GAP_REGISTER.md` under S13-5.
 */

const CONTRIBUTING = path.join(ROOT, 'CONTRIBUTING.md');
const SECURITY = path.join(ROOT, 'SECURITY.md');
const TEMPLATE = path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const PROGRAM = path.join(ROOT, 'src', 'cli', 'program.ts');
const MANIFEST = path.join(ROOT, 'package.json');

interface Manifest {
  scripts?: Record<string, string>;
}

function scripts(): Record<string, string> {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  return parsed.scripts ?? {};
}

/** Every `npm run <name>` a piece of prose tells the reader to execute. */
function npmRunNames(text: string): string[] {
  return [...text.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((match) => match[1] as string);
}

/**
 * Commands a person can actually invoke: the literals registered on the program.
 *
 * The planned-command loop registers `planned.name`, an expression rather than a literal,
 * so a command that only prints "planned, not yet implemented" cannot enter this set. That
 * distinction is the point — advertising one in a triage list is the Stage 15 defect this
 * slice is trying to make impossible.
 */
function registeredCommands(): string[] {
  return [...readFileSync(PROGRAM, 'utf8').matchAll(/\.command\('([a-z][a-z0-9-]*)/g)].map(
    (match) => match[1] as string,
  );
}

/** Relative source paths a document cites, e.g. `src/security/redaction.ts`. */
function citedSourcePaths(text: string): string[] {
  return [...new Set([...text.matchAll(/src\/[\w./-]*\.[cm]?ts\b/g)].map((m) => m[0]))];
}

/**
 * Scripts a workflow step actually executes.
 *
 * Read from `run:` lines, never from the file's prose: `ci.yml` explains in a comment that
 * the live-model suite sits behind `npm run test:live`, and a comment is not a step.
 * Counting it would make this rule demand documentation for a command no hosted job runs.
 */
function scriptsRunByCi(workflow: string): string[] {
  return [
    ...new Set(
      [...workflow.matchAll(/^\s*run:\s*(?:npm|npx)\s+run\s+([a-z][a-z:-]*)/gm)].map(
        (match) => match[1] as string,
      ),
    ),
  ].sort();
}

describe('what CONTRIBUTING.md tells a developer to run', () => {
  const guide = readFileSync(CONTRIBUTING, 'utf8');

  it('names commands that exist in the manifest', () => {
    const invoked = npmRunNames(guide);
    expect(
      invoked.length,
      'the guide tells the reader to run no npm script at all',
    ).toBeGreaterThan(0);
    const missing = invoked.filter((name) => !(name in scripts()));
    expect(
      missing,
      `CONTRIBUTING.md runs scripts the manifest lacks: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('spells out the real composition of npm run check, in order', () => {
    const declared = /npm run check\s+#\s*([^\n]+)/.exec(guide);
    expect(declared, 'the guide states no composition for `npm run check`').not.toBeNull();
    const claimed = (declared?.[1] ?? '')
      .split('+')
      .map((part) => part.trim().replace(/^npm run /, ''))
      .filter(Boolean);
    expect(claimed.length, 'the stated composition of check is empty').toBeGreaterThan(0);
    const real = (scripts().check ?? '')
      .split('&&')
      .map((part) => part.trim().replace(/^npm run /, ''))
      .filter(Boolean);
    expect(claimed).toEqual(real);
  });

  it('documents every script the hosted workflow runs', () => {
    const runByCi = scriptsRunByCi(readFileSync(WORKFLOW, 'utf8')).sort();
    expect(runByCi.length, 'the hosted workflow runs no npm script').toBeGreaterThan(0);
    const undocumented = runByCi.filter((name) => !npmRunNames(guide).includes(name));
    expect(
      undocumented,
      `CI runs scripts the guide never mentions: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('lists the release-boundary verifiers, exactly the ones the gate runs', () => {
    const listed = [
      ...new Set([...guide.matchAll(/`([a-z-]+)`\s+—/g)].map((match) => match[1] as string)),
    ].sort();
    const wired = (scripts()['verify:package'] ?? '')
      .match(/tests\/security\/[\w-]+\.test\.ts/g)
      ?.map((file) => path.basename(file, '.test.ts'))
      .sort();
    expect(wired, 'verify:package names no verifier').toBeTruthy();
    expect(wired?.length, 'verify:package names no verifier').toBeGreaterThan(0);
    expect(
      listed,
      'the verifiers this guide describes are not the set verify:package actually runs',
    ).toEqual(wired);
  });
});

describe('what the issue template advertises', () => {
  const template = readFileSync(TEMPLATE, 'utf8');

  /** The triage options that name a surface rather than a stage command. */
  const NOT_A_COMMAND = ['packaging or install', 'documentation', 'something else'];

  function options(): string[] {
    const block = /label: Where it happened[\s\S]*?options:\n((?:\s+- .+\n)+)/.exec(template);
    expect(block, 'the template has no stage dropdown to read').not.toBeNull();
    return [...(block?.[1] ?? '').matchAll(/^\s+- (.+)$/gm)].map((m) => (m[1] as string).trim());
  }

  it('offers exactly the commands the CLI registers, plus its non-command labels', () => {
    const offered = options()
      .filter((option) => !NOT_A_COMMAND.includes(option))
      .sort();
    expect(offered.length, 'the stage dropdown is empty').toBeGreaterThan(0);
    expect(offered).toEqual([...registeredCommands()].sort());
  });

  it('keeps its own non-command labels off the command list', () => {
    const registered = registeredCommands();
    expect(registered.length, 'no command could be read from the CLI source').toBeGreaterThan(10);
    for (const label of NOT_A_COMMAND) {
      expect(registered, `a triage label collides with a real command: ${label}`).not.toContain(
        label.split(' ')[0] as string,
      );
    }
  });

  it('shows placeholders that use commands which exist', () => {
    const shown = [...template.matchAll(/(?:bin\.js|mergesutra) (-v|[a-z][a-z0-9-]*)/g)]
      .map((m) => m[1] as string)
      .filter((name) => name !== '-v');
    expect(shown.length, 'the template shows no example command line').toBeGreaterThan(0);
    const unknown = [...new Set(shown)].filter((name) => !registeredCommands().includes(name));
    expect(
      unknown,
      `the template demonstrates a command that does not exist: ${unknown.join(', ')}`,
    ).toEqual([]);
  });
});

describe('paths the repository documents cite', () => {
  it('resolve to files in this tree', () => {
    const documents: ReadonlyArray<readonly [string, string]> = [
      ['SECURITY.md', readFileSync(SECURITY, 'utf8')],
      ['CONTRIBUTING.md', readFileSync(CONTRIBUTING, 'utf8')],
    ];
    const broken: string[] = [];
    for (const [name, text] of documents) {
      for (const cited of citedSourcePaths(text)) {
        if (!existsSync(path.join(ROOT, cited))) broken.push(`${name} -> ${cited}`);
      }
    }
    expect(broken, `a document cites a source file that is not here: ${broken.join(', ')}`).toEqual(
      [],
    );
  });

  it('is a scan that found something to scan', () => {
    const cited = [SECURITY, CONTRIBUTING].flatMap((file) =>
      citedSourcePaths(readFileSync(file, 'utf8')),
    );
    expect(
      cited.length,
      'neither policy document cites a source path, so the rule above proves nothing',
    ).toBeGreaterThan(0);
  });
});

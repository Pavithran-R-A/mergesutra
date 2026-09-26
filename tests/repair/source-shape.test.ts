import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { riskOf, type RiskClass } from '../../src/process/tool-policy.js';

/**
 * What a repair cycle is never built to ask for, §32.
 *
 * The steering rule of Stage 9R is that a repair borrows Stage 6's hands and adds
 * no permission of its own — so the commands this product can put in front of a
 * process are the same handful it could put there before. `boundaries.test.ts`
 * proves that from the import side: a repair module cannot reach a runner, a
 * writer or a client. This file proves the other half, which imports alone cannot
 * settle. The repair path *does* start processes — `describePatch` asks git what the
 * workspace holds, and a gate round runs what the repository's own files name — so
 * somewhere in its reach there are argv arrays, and somebody has to have checked
 * what they are.
 *
 * Nothing here is ever executed. A test that ran `git clean -fd` to prove the
 * product refuses it would be the incident it tests for. So the claims are made of
 * source text and of the product's own classifier: the first block shows that
 * classifier genuinely refuses the verbs §32 names, and the second shows that no
 * command MergeSutra constructs itself is one of them. Without the first, the
 * second would be a scan that found nothing and called it clean.
 *
 * Two things the scan deliberately does not count, for honesty rather than
 * convenience. `tool-policy.ts` spells out `push`, `clean`, `rm` and `--force` as
 * data, because naming them is how it refuses them; and the argv of a *gate* comes
 * from the repository's own build files, so it is not a command MergeSutra wrote
 * down at all — Stage 7's execution consent is what authorises those, and it is
 * tested where it lives. What remains is every literal this product hands to a
 * runner, and that set is what must never contain a wipe.
 */

const SRC = path.join(process.cwd(), 'src');

/** The repair's own modules: every one of them is a root of the reachability walk. */
async function repairEntries(): Promise<string[]> {
  const names = await readdir(path.join(SRC, 'repair'));
  return names.filter((name) => name.endsWith('.ts')).map((name) => path.join(SRC, 'repair', name));
}

/**
 * Every module a repair can arrive at, following the imports themselves.
 *
 * Read from source rather than from a list a person maintains, because the
 * interesting change is the one nobody noticed: a repair module that started
 * importing a second pair of hands would not announce it in a checklist.
 */
async function reachable(absolute: string, seen: Set<string>): Promise<Set<string>> {
  if (seen.has(absolute)) return seen;
  seen.add(absolute);
  const text = await readFile(absolute, 'utf8');
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)\.js['"]/g)) {
    const target = (match[1] ?? '').replace(/^\.\//, '');
    const next = path.join(path.dirname(absolute), `${target}.ts`);
    // `src/` only: this is a question about this product's code, not about Node.
    if (next.startsWith(SRC) && !next.includes('node_modules')) await reachable(next, seen);
  }
  return seen;
}

async function reach(): Promise<Map<string, string>> {
  const seen = new Set<string>();
  for (const entry of await repairEntries()) await reachable(entry, seen);
  const files = [...seen].sort();
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return new Map(files.map((file, index) => [relative(file), texts[index] ?? '']));
}

function relative(file: string): string {
  return path.relative(SRC, file).replace(/\\/g, '/');
}

/** Strip comments: a refusal explained in prose is not a command being proposed. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * One place the source writes down a command.
 *
 * `open` says an element was not a literal — a spread, a value this module is
 * handed at runtime. An open site cannot be classified from here, so it is
 * reported rather than passed over: the claim below is about closed commands, and
 * the reader of a failure gets to see which commands it does not cover.
 */
interface Site {
  readonly file: string;
  readonly argv: readonly string[];
  readonly open: boolean;
}

/**
 * The elements of an argv array, position by position.
 *
 * A value the source does not write out becomes `'value'`, and not nothing: git
 * reads its arguments by position, so dropping `-C`'s directory would promote the
 * next flag into the subcommand's seat and classify a command that does not exist.
 * Keeping the seat filled is what lets the classifier see `git -C <dir> diff` as
 * the diff it is.
 */
function argvOf(contents: string): { tokens: string[]; open: boolean } {
  const tokens: string[] = [];
  let open = false;
  for (const element of splitElements(contents)) {
    const literal = /^'([^'\n]*)'$/.exec(element);
    if (literal) {
      tokens.push(literal[1] ?? '');
      continue;
    }
    // A spread or an interpolation makes the command only partly known here, and
    // a half-known command cannot be cleared — so the site is reported as open.
    if (element.startsWith('...') || element.includes('`') || element.includes('${')) {
      open = true;
      continue;
    }
    if (element.length === 0) continue;
    tokens.push('value');
  }
  return { tokens, open };
}

/** Split an array literal's body on its commas, ignoring those inside a string. */
function splitElements(contents: string): string[] {
  const out: string[] = [];
  let quote = '';
  let depth = 0;
  let current = '';
  for (const char of contents) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out.filter((element) => element.length > 0);
}

/**
 * Anchors that say *this array is a command*, as opposed to mentioning one.
 *
 * `run('git', [` and `safeRun(run, 'gh', [` hand a program to the runner;
 * `git(run, dir, [` is the project's own shorthand for the same call; `argv:` is a
 * gate spec MergeSutra declares rather than discovers in a repository. Everything
 * else that spells a program name — the `Set` of forbidden ones in
 * `tool-policy.ts`, the word `git` inside a report string — is data *about*
 * commands, and counting it would turn the guard's own vocabulary into a finding.
 */
const ANCHORS: ReadonlyArray<{ readonly call: RegExp; readonly program?: string }> = [
  { call: /\brun\(\s*['"][A-Za-z][\w.+-]*['"]\s*,\s*$/ },
  { call: /\bsafeRun\(\s*[A-Za-z_$][\w$]*\s*,\s*['"][A-Za-z][\w.+-]*['"]\s*,\s*$/ },
  { call: /\bgit\(\s*[A-Za-z_$][\w$]*\s*,\s*[^,[\s]+\s*,\s*$/, program: 'git' },
  { call: /\bargv:\s*$/ },
];

/** A program named just before the array, as in `run('git', […])`. */
const PROGRAM_BEFORE = /['"]([A-Za-z][\w.+-]*)['"]\s*,\s*$/;

/** A command whose own first element is the program, as in `['git', '-C', root, …]`. */
const GIT_INSIDE = /^\s*['"]git['"]\s*[,\]]/;

function constructions(sources: Map<string, string>): Site[] {
  const sites: Site[] = [];
  const seen = new Set<string>();
  for (const [file, text] of sources) {
    const body = code(text);
    for (let open = body.indexOf('['); open !== -1; open = body.indexOf('[', open + 1)) {
      const before = body.slice(0, open);
      const contents = arrayBody(body, open);
      if (contents === null) continue;
      const anchor = ANCHORS.find((entry) => entry.call.test(before));
      // A literal that opens with `'git'` is a command even where no runner call
      // names it: `creationIsAllowed(root, ['git', …])` asks whether a command may
      // be built, which is the same command either way.
      if (!anchor && !GIT_INSIDE.test(contents)) continue;
      const { tokens, open: isOpenSite } = argvOf(contents);
      const external = anchor?.program ?? PROGRAM_BEFORE.exec(before)?.[1];
      const argv = GIT_INSIDE.test(contents) ? ['git', ...tokens.slice(1)] : tokens;
      if (argv.length === 0) continue;
      const key = `${file}\u0000${argv.join('\u0000')}\u0000${isOpenSite}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ file, argv: external ? [external, ...argv] : argv, open: isOpenSite });
    }
  }
  return sites.sort((a, b) =>
    `${a.file} ${a.argv.join(' ')}`.localeCompare(`${b.file} ${b.argv.join(' ')}`),
  );
}

/**
 * The contents of the array literal that starts at `[`, read to its `]`.
 *
 * A bracket-scan rather than `[^\]]*`, because a git command's own arguments are
 * full of brackets — `'refs/remotes/origin/HEAD'`, `'[src/parse.ts]'` — and a
 * pattern that stopped at the first one would silently end the scan early. A
 * command cut off mid-argv looks exactly like a command that was never there.
 */
function arrayBody(text: string, open: number): string | null {
  let quote = '';
  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ']') return text.slice(open + 1, i);
  }
  return null;
}

function risksOf(argv: readonly string[]): RiskClass {
  return riskOf({ op: 'execute', argv, cwd: process.cwd() });
}

function show(site: Site): string {
  return `${site.file}: ${site.argv.join(' ')}${site.open ? ' (open)' : ''}`;
}

describe('what a repair cycle could ever put in front of a process', () => {
  it('reaches a real span of the product, so the scan below cannot pass by finding nothing', async () => {
    const sources = await reach();

    // The orchestrator's own dependencies: Stage 6's loop, Stage 7's round, Stage
    // 8's renderer and the state layer. A closure this thin would mean the walk
    // broke, and an empty scan would then look like a clean bill of health.
    expect([...sources.keys()]).toEqual(
      expect.arrayContaining([
        'repair/stage.ts',
        'implement/loop.ts',
        'verify/workspace.ts',
        'report/pack.ts',
        'verify/patch.ts',
      ]),
    );
    expect(sources.size).toBeGreaterThan(15);
    for (const [, text] of sources) expect(text.length).toBeGreaterThan(50);
  });

  it('refuses the verbs §32 names, before anything checks that none is constructed', async () => {
    // The positive control. Each of these is a command this product could be asked
    // for by a model, a repository file or a future contributor; the classifier is
    // what stands between the ask and the process. Asserting the refusal here, in
    // the file that asserts the non-construction, is what makes the next test's
    // empty list mean "not built" rather than "not noticed".
    const refused: ReadonlyArray<readonly [string[], RiskClass]> = [
      [['git', 'push'], 'REMOTE_MUTATION'],
      [['git', 'push', '--force'], 'DESTRUCTIVE'],
      [['git', 'reset', '--hard', 'HEAD~3'], 'DESTRUCTIVE'],
      [['git', 'clean', '-fd'], 'DESTRUCTIVE'],
      [['git', 'worktree', 'remove', 'somewhere'], 'DESTRUCTIVE'],
      [['git', 'rebase', 'main'], 'DESTRUCTIVE'],
      [['rm', '-rf', 'node_modules'], 'DESTRUCTIVE'],
      [['del', 'src/parse.ts'], 'DESTRUCTIVE'],
      [['sudo', 'git', 'push'], 'DESTRUCTIVE'],
      [['node', '-e', "require('child_process')"], 'DESTRUCTIVE'],
    ];

    for (const [argv, expected] of refused) {
      expect(risksOf(argv), argv.join(' ')).toBe(expected);
    }
  });

  it('constructs only commands the classifier would let through', async () => {
    const sources = await reach();
    const sites = constructions(sources);

    const closed = sites.filter((site) => !site.open);
    const unsafe = closed
      .filter((site) => {
        const risk = risksOf(site.argv);
        return risk === 'DESTRUCTIVE' || risk === 'REMOTE_MUTATION';
      })
      .map((site) => `${show(site)} is ${risksOf(site.argv)}`);

    expect(unsafe).toEqual([]);

    // The whole enumeration, listed rather than sampled. Six commands, and every
    // one of them is git being asked what the workspace holds: the two patch
    // measurements a repair cycle is built around, the review's per-file diff, and
    // the one check MergeSutra declares for itself. Nothing in a repair's reach
    // constructs a command over anything but `git`, which is why §32's list of
    // fears — publish, wipe, escalate, re-interpret — has nowhere to enter.
    expect(closed.map(show)).toEqual([
      'review/context.ts: git -C value diff --no-ext-diff --no-renames value -- value',
      'verify/patch.ts: git diff --name-status --no-renames --no-ext-diff -z value',
      'verify/patch.ts: git ls-files --others --exclude-standard -z',
      'verify/patch.ts: git rev-parse --show-toplevel',
      'verify/patch.ts: git rev-parse HEAD',
      'verify/workspace.ts: git diff --check',
    ]);
    expect([...new Set(closed.map((site) => site.argv[0] ?? ''))]).toEqual(['git']);
  });

  it('leaves the two commands it cannot write out to the mechanisms that check them', async () => {
    const sources = await reach();
    const open = constructions(sources).filter((site) => site.open);

    // A spread means an argv this file cannot read, so the two that exist are
    // named rather than waved through. `verify/patch.ts` is the project's own
    // `git(run, dir, args)` shorthand passing its parameter along — every caller of
    // it is literal, which is what lets the list above count as complete.
    // `verify/command.ts` is a *gate*: its argv comes from the repository's build
    // files, so MergeSutra never wrote a command down to begin with. Those run only
    // under the execution consent Stage 7 records, and a gate that escapes its
    // declared argv is Stage 7's test to catch, not this one's.
    //
    // A third spread here would be a command nobody can read off the page, and this
    // fails so that the next person decides about it instead of inheriting it.
    expect(open.map(show)).toEqual([
      'verify/command.ts: value (open)',
      'verify/patch.ts: git -C value (open)',
    ]);
  });

  it('never names a removal or privilege program as something to start', async () => {
    const sources = await reach();
    const banned = new Set([
      'del',
      'rd',
      'rmdir',
      'rm',
      'shred',
      'sudo',
      'runas',
      'doas',
      'diskpart',
      'mkfs',
      'dd',
      'erase',
    ]);

    const offenders = constructions(sources)
      .filter((site) => banned.has((site.argv[0] ?? '').toLowerCase()))
      .map(show);

    // MergeSutra does not delete, and a repair that wanted a file gone says so in
    // the report and lets the person who owns the disk do it.
    expect(offenders).toEqual([]);
  });

  it('leaves child processes to the one module that owns them, and asks for no shell', async () => {
    const sources = await reach();
    const RUNNER_OWNER = 'core/runner.ts';

    const offenders: string[] = [];
    for (const [file, text] of sources) {
      if (file === RUNNER_OWNER) continue;
      const body = code(text);
      for (const token of ['child_process', 'execSync', 'execFile', 'spawn(', 'spawnSync']) {
        if (body.includes(token)) offenders.push(`${file} mentions ${token}`);
      }
    }
    expect(offenders).toEqual([]);

    // The owner, read for what it is allowed to do: argv only, and never a shell.
    const runner = sources.get(RUNNER_OWNER);
    expect(runner, 'the runner must be reachable for this to mean anything').toBeDefined();
    expect(code(runner ?? '').includes('shell: false'), 'shell: false').toBe(true);
    for (const word of ['shell: true', 'exec(', ' /c ', 'cmd.exe', 'powershell']) {
      expect(code(runner ?? '').includes(word), word).toBe(false);
    }
  });

  it('keeps publication out of the reach entirely, not merely unclassified', async () => {
    const sources = await reach();

    // A release is a remote act with a name, so it is not enough that no command
    // here pushes: nothing in a repair's reach may even be the kind of module that
    // talks to a hosting service or a package registry.
    expect([...sources.keys()].some((file) => file.startsWith('github/'))).toBe(false);
    const text = [...sources.values()].map(code).join('\n');
    for (const word of [
      'createPullRequest',
      'git push',
      'npm publish',
      'gh release',
      'api.github.com',
      'octokit',
    ]) {
      expect(text.includes(word), word).toBe(false);
    }
  });
});

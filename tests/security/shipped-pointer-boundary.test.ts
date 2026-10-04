import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { npmCliScript, requireNpmCli } from '../helpers/npmInvocation.js';

/**
 * S13-4 — does every place this build tells a reader to look exist for that reader?
 *
 * Two shipped surfaces make promises in prose. A screen prints `see docs/ROADMAP.md`,
 * the README prints `[Stage 10](docs/ROADMAP.md)`, and nothing in the suite read those
 * strings, because nothing asked what a pointer *resolves to*. The manifest ships
 * `dist/`, `BharatCode.txt`, `README.md`, `LICENSE` and npm's own `package.json`, and
 * `publish-contents.test.ts` refuses a package that carries `docs/`. So every one of
 * those pointers named a file the customer does not have: the tool whose whole design
 * is saying what is true was shipping screens that sent a reader into a directory only
 * the developer owns.
 *
 * This is the judgement `credential-boundary.test.ts` and `home-path-boundary.test.ts`
 * already make about *bytes* an artifact carries, applied to *directions* it gives, and
 * it cannot be inherited from either: a pointer is neither a secret nor a path on the
 * developer's machine, and green runs of those two say nothing about whether
 * `Progress: see docs/ROADMAP.md` survives an install.
 *
 * Three rules, keyed on position rather than on the string:
 *
 * 1. **A pointer a shipped screen prints must resolve for the reader who installed the
 *    package.** Legal: it is one of npm's own packed entries, or it names a file that
 *    exists in the workspace the command was run against — a repository being inspected
 *    is data, and its `docs/` is its own. Illegal: it names a file this checkout tracks
 *    and this package does not ship.
 * 2. **A relative link in a shipped document must resolve inside the package.**
 *    `README.md` and `BharatCode.txt` are read in three places — GitHub, the npm
 *    package page, a directory after an install — and only an absolute URL resolves in
 *    all three without relying on a renderer's link rewriting, which nothing here
 *    verifies. This layer keys on markdown semantics, not on a wording list: a link is
 *    a route a reader follows, while a backticked path identifies where code lives and
 *    is provenance the README is entitled to carry.
 * 3. **Screen and metadata may not drift.** A screen's pointer is composed from the
 *    repository URL the manifest publishes, so moving the project is one edit in
 *    `package.json` rather than a hunt through printed strings.
 *
 * What this file does **not** claim: reachability. It resolves pointers against the
 * packed inventory, which is a filesystem question; the status code of an `https:`
 * pointer is a network measurement recorded in `docs/SECURITY_GAP_REGISTER.md`, never
 * asserted here — the repository is private until the Stage 15 visibility flip, so a
 * 200 assertion would be a claim about the future. It also does not read every sentence
 * of every document: it reads the screens a customer can run, every root-level prose
 * file npm packs, and only the links among them. Absolute paths are the home-directory gate's, and the case below pins that
 * division rather than assuming it.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>;
  repository?: { url?: string };
  scripts?: Record<string, string>;
};
const DIST_ENTRY = path.join(ROOT, manifest.bin?.['mergesutra'] ?? './dist/bin.js');
const BUILD_PRESENT = existsSync(path.join(ROOT, 'dist'));
const NPM_CLI = npmCliScript();
const NPM_PRESENT = NPM_CLI !== null;

interface PackEntry {
  readonly path: string;
}

/** npm's own answer to "what would this package contain", reduced to its paths. */
function packedPaths(): string[] {
  const result = spawnSync(
    process.execPath,
    [requireNpmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  expect(
    result.status,
    `npm pack --dry-run exited ${String(result.status)}: ${String(result.stderr).slice(0, 400)}`,
  ).toBe(0);
  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  expect(start, 'npm answered with no JSON inventory').toBeGreaterThanOrEqual(0);
  const reports = JSON.parse(result.stdout.slice(start, end + 1)) as { files?: PackEntry[] }[];
  expect(reports.length).toBe(1);
  const files = reports[0]?.files ?? [];
  expect(
    files.length,
    'npm reports an empty package, so nothing below would be checked',
  ).toBeGreaterThan(0);
  return files.map((entry) => entry.path.replace(/\\/g, '/').replace(/^package\//, '')).sort();
}

function git(args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 28,
  });
  expect(result.status, `git ${args.join(' ')} exited ${String(result.status)}`).toBe(0);
  return result.stdout;
}

/**
 * A pointer-shaped token: something ending in a document or source extension, with no
 * scheme and not a segment of an absolute path.
 *
 * Deliberately wide, because the failure it hunts is a *sentence* naming a file —
 * `Progress: see docs/ROADMAP.md` — and a scanner that matched only a token standing
 * alone would report the cleanest possible all-clear on exactly that. Backslashes are
 * folded first, so a Windows-shaped pointer is read as the same pointer.
 */
const POINTER =
  /(?<![\w./:\\-])(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:md|txt|json|jsonl|ya?ml|ts|tsx|js|jsx|mjs|cjs)\b/g;

/** Strip the punctuation a sentence hangs on the end of a token. */
function trimToken(token: string): string {
  return token.replace(/[.,;:!?)'"\]]+$/g, '');
}

function pointerTokens(text: string): string[] {
  const folded = text.replace(/\\/g, '/');
  const out = new Set<string>();
  for (const raw of folded.matchAll(POINTER)) out.add(trimToken(raw[0] ?? ''));
  return [...out].sort();
}

type Verdict = 'shipped' | 'workspace' | 'developer-only' | 'unknown';

interface PointerJudgement {
  readonly token: string;
  readonly verdict: Verdict;
}

/**
 * Where does this token live for the reader who was just shown it?
 *
 * Order matters. A packed entry wins because `README.md` is both tracked here and held
 * by the customer; the workspace is checked next because a screen quoting the repository
 * it is inspecting quotes *that* repository's bytes, and forbidding a tool from naming a
 * file it just read would be absurd. Only after both does "this checkout tracks it and
 * the package does not ship it" become the offence.
 */
function judge(
  token: string,
  packed: ReadonlySet<string>,
  tracked: ReadonlySet<string>,
  workspace: string,
): Verdict {
  const normalized = token.replace(/\\/g, '/');
  if (packed.has(normalized)) return 'shipped';
  if (existsSync(path.resolve(workspace, normalized))) return 'workspace';
  if (tracked.has(normalized)) return 'developer-only';
  return 'unknown';
}

function offenders(judgements: readonly PointerJudgement[]): PointerJudgement[] {
  return judgements.filter((entry) => entry.verdict === 'developer-only');
}

interface Screen {
  readonly label: string;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one screen the way a customer does: a fresh process over the built entry point,
 * from a directory that is not this checkout and holds none of its documents.
 *
 * That last clause is the whole measurement. Run from the repository itself, every
 * `docs/` a screen names would exist on disk and the gate would pass by accident, which
 * is precisely how this defect survived twelve stages.
 */
function runScreen(label: string, argv: readonly string[], cwd: string): Screen {
  const result = spawnSync(process.execPath, [DIST_ENTRY, ...argv], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  expect(
    result.error,
    `${label}: the built CLI could not be started (${String(result.error?.message)})`,
  ).toBeUndefined();
  return { label, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Every command the shipped CLI advertises, read out of its own help screen. */
function advertisedCommands(help: string): string[] {
  const block = /Commands:\n([\s\S]*)$/m.exec(help);
  const names: string[] = [];
  for (const line of (block?.[1] ?? '').split('\n')) {
    const match = /^ {2}([\w-]+)/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return [...new Set(names)];
}

const RELATIVE_LINK = /\[[^\]]*\]\((?!https?:\/\/|#)([^)\s]+)\)/g;

function relativeLinks(text: string): string[] {
  return [...text.matchAll(RELATIVE_LINK)]
    .map((match) => (match[1] ?? '').split('#')[0] ?? '')
    .filter((target) => target.length > 0);
}

let packed: string[] = [];
let packedSet = new Set<string>();
let trackedSet = new Set<string>();
let workspace = '';
let foreignRepo = '';
let screens: Screen[] = [];

/**
 * 180s rather than the config's 30s: this hook starts one real Node process per
 * advertised command (~16 of them) plus an `npm pack` inventory, and under the
 * contention this host is known for a spawn budget sized for in-memory tests would
 * report a timeout instead of a verdict. It widens no assertion.
 */
beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'ms-pointer-'));
  foreignRepo = path.join(workspace, 'inspected');
  mkdirSync(path.join(foreignRepo, 'docs'), { recursive: true });
  writeFileSync(path.join(foreignRepo, 'docs', 'SECURITY_MODEL.md'), '# theirs\n', 'utf8');
  if (!BUILD_PRESENT || !NPM_PRESENT) return;
  packed = packedPaths();
  packedSet = new Set(packed);
  trackedSet = new Set(git(['ls-files']).split('\n').filter(Boolean));

  const help = runScreen('--help', ['--help'], workspace);
  const names = advertisedCommands(help.stdout);
  screens = [
    help,
    runScreen('--version', ['--version'], workspace),
    runScreen('unknown-command', ['no-such-command'], workspace),
    ...names.map((name) => runScreen(name, [name], workspace)),
  ];
}, 180_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function judgementsFor(text: string, cwd = workspace): PointerJudgement[] {
  return pointerTokens(text).map((token) => ({
    token,
    verdict: judge(token, packedSet, trackedSet, cwd),
  }));
}

describe('pointer detector', () => {
  it('names a tracked document the package does not ship as an offence', () => {
    expect(judgementsFor('Progress: see docs/ROADMAP.md')).toEqual([
      { token: 'docs/ROADMAP.md', verdict: 'developer-only' },
    ]);
  });

  it('accepts a document npm actually packs', () => {
    expect(packed, 'npm packs no README, so this control proves nothing').toContain('README.md');
    expect(judge('README.md', packedSet, trackedSet, workspace)).toBe('shipped');
  });

  it('accepts a path that exists in the workspace the command was pointed at', () => {
    const judgement = judgementsFor('docs/SECURITY_MODEL.md', foreignRepo)[0];
    expect(judgement).toEqual({ token: 'docs/SECURITY_MODEL.md', verdict: 'workspace' });
    expect(existsSync(path.resolve(workspace, 'docs/SECURITY_MODEL.md'))).toBe(false);
    expect(judgementsFor('docs/SECURITY_MODEL.md')[0]?.verdict).toBe('developer-only');
  });

  it('leaves an absolute path to the home-directory gate', () => {
    expect(
      pointerTokens('Run record: C:\\Users\\someone\\project\\.mergesutra\\runs\\run-1.json'),
    ).toEqual([]);
    expect(pointerTokens('Run record: /home/someone/project/docs/ROADMAP.md')).toEqual([]);
  });

  it('does not mistake a URL for a file the reader lacks', () => {
    expect(pointerTokens('see https://example.com/docs/report.md')).toEqual([]);
  });

  it('keeps a token when a sentence puts punctuation after it', () => {
    expect(pointerTokens('Open docs/ROADMAP.md, then CHANGELOG.md.').length).toBe(2);
  });

  it('holds a planted offence that is not the one this stage found', () => {
    expect(judgementsFor('For the threat model, see docs/COMPETITIVE_ANALYSIS.md')).toContainEqual({
      token: 'docs/COMPETITIVE_ANALYSIS.md',
      verdict: 'developer-only',
    });
  });

  it('reads a Windows-shaped pointer as the same pointer', () => {
    expect(judgementsFor('Progress: see docs\\ROADMAP.md')).toEqual([
      { token: 'docs/ROADMAP.md', verdict: 'developer-only' },
    ]);
  });

  it('scans a tracked tree big enough for the distinction to mean something', () => {
    expect(trackedSet.size).toBeGreaterThan(150);
    expect([...trackedSet].filter((entry) => entry.startsWith('docs/')).length).toBeGreaterThan(3);
  });
});

describe('screens a customer can run', () => {
  it('reads the help screen and runs every command it advertises', () => {
    expect(BUILD_PRESENT, 'dist/ is absent, so no screen could be run').toBe(true);
    expect(NPM_PRESENT, 'npm is unreachable, so the packed surface could not be measured').toBe(
      true,
    );
    const names = advertisedCommands(screens[0]?.stdout ?? '');
    expect(names.length, 'the shipped help screen advertises no commands').toBeGreaterThan(10);
    expect(screens.length).toBeGreaterThanOrEqual(names.length + 3);
    const silent = screens.filter((screen) => (screen.stdout + screen.stderr).length === 0);
    expect(
      silent.map((screen) => screen.label),
      'a screen that printed nothing was scanned, which proves nothing about it',
    ).toEqual([]);
  });

  it('points at nothing only the developer has', () => {
    const found = screens.flatMap((screen) =>
      offenders(judgementsFor(`${screen.stdout}\n${screen.stderr}`)).map(
        (entry) => `${screen.label}: ${entry.token}`,
      ),
    );
    expect(
      found,
      `installed screens send a reader to files the package does not ship: ${found.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the planned-command screen inside the surface the customer installed', () => {
    const planned = screens.find((screen) => screen.stdout.includes('planned, not yet'));
    expect(
      planned,
      'no screen reported a planned command, so this case checks nothing',
    ).toBeDefined();
    expect(
      offenders(judgementsFor(planned?.stdout ?? '')),
      'the planned-command screen names a location the customer cannot open',
    ).toEqual([]);
  });

  it('still says where a planned command is going, in a form the reader can follow', () => {
    const planned = screens.find((screen) => screen.stdout.includes('planned, not yet'));
    expect(planned?.stdout).toMatch(/https:\/\/github\.com\//);
  });

  it('leaves the inspected repository alone when naming what it read', () => {
    const inspect = runScreen('inspect (foreign repo)', ['inspect', foreignRepo], workspace);
    const text = `${inspect.stdout}\n${inspect.stderr}`;
    expect(text.length, 'inspect printed nothing, so this case checks nothing').toBeGreaterThan(0);
    expect(offenders(judgementsFor(text, foreignRepo))).toEqual([]);
  });
});

describe('the documents every customer reads', () => {
  /**
   * Every root-level prose file npm packs — `README.md`, `BharatCode.txt` and any
   * document a later stage adds to the shipped surface.
   *
   * Not just the README: the gate exists because a shipped sentence pointed at an
   * unshipped directory, and a second shipped document could repeat it.
   */
  function shippedDocuments(): { name: string; text: string }[] {
    return packed
      .filter((entry) => !entry.includes('/') && /\.(md|txt)$/.test(entry))
      .map((entry) => ({ name: entry, text: readFileSync(path.join(ROOT, entry), 'utf8') }));
  }

  it('reads more than one shipped prose document', () => {
    const names = shippedDocuments().map((document) => document.name);
    expect(names).toContain('README.md');
    expect(names).toContain('BharatCode.txt');
    expect(names.length).toBeGreaterThan(1);
    expect(
      relativeLinks(readFileSync(path.join(ROOT, 'README.md'), 'utf8')).length,
    ).toBeGreaterThan(0);
  });

  it('links to nothing that a reader with only the package cannot open', () => {
    // Judged from the installed directory, not from this checkout: read against the
    // working tree every link resolves, which is exactly why this defect survived.
    const found = shippedDocuments().flatMap((document) =>
      offenders(
        relativeLinks(document.text).map((target) => ({
          token: target,
          verdict: judge(target, packedSet, trackedSet, workspace),
        })),
      ).map((entry) => `${document.name}: ${entry.token}`),
    );
    expect(
      found,
      `a shipped document points a reader at repository-only files: ${found.join(', ')}`,
    ).toEqual([]);
  });

  it('reads a link as a route and a backtick as a citation', () => {
    // The document layer keys on markdown semantics rather than on a wording list: a
    // renderer turns `[Stage 10](docs/ROADMAP.md)` into something the reader follows,
    // while `` `tests/repair/boundaries.test.ts` `` identifies where code lives, which
    // is provenance a source-reading customer needs and no instruction to open it.
    // A rule that fired on both would be answered by an allowlist, not by a fix.
    expect(relativeLinks('Read [the roadmap](docs/ROADMAP.md) first.')).toEqual([
      'docs/ROADMAP.md',
    ]);
    expect(relativeLinks('Lives in `tests/repair/boundaries.test.ts`.')).toEqual([]);
    expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8')).toContain(
      'tests/repair/boundaries.test.ts',
    );
  });

  it('keeps every remaining relative link inside the installed package', () => {
    const unresolved = shippedDocuments().flatMap((document) =>
      relativeLinks(document.text)
        .filter((target) => !packedSet.has(target))
        .map((target) => `${document.name}: ${target}`),
    );
    expect(
      unresolved,
      `a relative link in a shipped document leaves the package: ${unresolved.join(', ')}`,
    ).toEqual([]);
  });

  it('composes its pointers from the repository the manifest publishes', () => {
    const repositoryUrl = manifest.repository?.url ?? '';
    expect(repositoryUrl).not.toBe('');
    const source = readFileSync(path.join(ROOT, 'src', 'cli', 'pointers.ts'), 'utf8');
    const declared = /REPOSITORY_URL\s*=\s*'([^']+)'/.exec(source);
    expect(
      declared,
      'src/cli/pointers.ts carries no repository URL for the screens to compose from',
    ).not.toBeNull();
    expect(declared?.[1]).toBe(repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, ''));
  });
});

describe('the packed surface this gate measures against', () => {
  it('ships the documents it claims and none of the repository-only ones', () => {
    expect(packed.length).toBeGreaterThan(20);
    for (const required of ['README.md', 'LICENSE', 'package.json']) {
      expect(packed, `npm does not pack ${required}`).toContain(required);
    }
    for (const forbidden of ['docs/', 'tests/', 'src/', '.github/']) {
      expect(
        packed.filter((entry) => entry.startsWith(forbidden)),
        `the package carries ${forbidden}, so a pointer into it would prove nothing`,
      ).toEqual([]);
    }
  });

  it('stays inside the roots the manifest declares', () => {
    const declared = ['dist', 'BharatCode.txt', 'README.md', 'LICENSE', 'package.json'];
    const outside = packed.filter(
      (entry) => !declared.some((root) => entry === root || entry.startsWith(`${root}/`)),
    );
    expect(outside, `npm packs roots the manifest never declared: ${outside.join(', ')}`).toEqual(
      [],
    );
  });

  it('is measured against a checkout that really holds both directories', () => {
    const roots = readdirSync(ROOT).filter((entry) => entry === 'docs' || entry === 'dist');
    expect(roots).toEqual(['dist', 'docs']);
    expect(
      readdirSync(path.join(ROOT, 'docs')).filter((entry) => entry.endsWith('.md')).length,
    ).toBeGreaterThan(3);
  });
});

describe('this gate is wired into the release boundary', () => {
  it('runs inside verify:package, so a pack refuses rather than ships', () => {
    const verify = manifest.scripts?.['verify:package'] ?? '';
    expect(verify, 'package.json declares no verify:package script').not.toBe('');
    expect(
      verify,
      'verify:package does not run this file, so a pointer defect ships unchecked',
    ).toContain('shipped-pointer-boundary.test.ts');
    expect(manifest.scripts?.prepack ?? '').toContain('verify:package');
  });
});

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOME_OWNER,
  HOME_OWNER_83,
  scanHomePaths,
  type HomePathFinding,
} from '../helpers/homePathScan.js';

/**
 * S13-0 — does anything this repository publishes carry the developer, rather
 * than the code?
 *
 * The credential gate (`credential-boundary.test.ts`) asks whether an artifact
 * carries a secret. A public repository raises a second question it cannot
 * answer, because the two boundaries are not the same set of files: the credential
 * scan deliberately excludes `tests/` from the tree and history, since fixtures
 * plant fake keys on purpose, while GitHub publishes the whole tracked tree the
 * moment the repository becomes visible. So the boundary that protects a published
 * clone has to be re-derived, not inherited.
 *
 * Two rules, and they are deliberately not the same rule:
 *
 * 1. **The repository boundary — the owner's identity in a path position, every
 *    tracked file including `tests/`.** A path says something about the person
 *    that no test needs: a fixture that plants `C:\Users\<owner>\.ssh\id_rsa` is
 *    illustrating *a shape*, and `C:\Users\other\.ssh\id_rsa` illustrates it
 *    exactly as well. A name in a non-path position is different — `--by '<name>'`
 *    is an approval actor, which is data the suite is entitled to hold — so the
 *    rule is anchored to a path separator rather than to the string. The 8.3 alias
 *    has no such excuse: it only ever appears inside a path, so it is matched
 *    anywhere.
 * 2. **The artifact boundary — any concrete home path, whoever it belongs to.**
 *    `dist/`, `README.md`, `BharatCode.txt`, `LICENSE` and `package.json` are the
 *    five roots a customer installs, and none of them has a reason to name a
 *    directory that belongs to anybody. Elisions stay allowed (`C:/Users/…/`)
 *    because that is the spelling this project already uses when it quotes a real
 *    screen.
 *
 * What this file does **not** claim: it does not scan history, and it must not be
 * read as saying history is clean. The commits written before this scrub name the
 * same home directory; the standing instruction for this stage is to push the
 * complete history rather than a rewritten one, and a personal path is not a
 * credential — nothing is invalidated by it.
 * `docs/SECURITY_GAP_REGISTER.md` carries that as a named limit.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SELF = readFileSync(fileURLToPath(import.meta.url), 'utf8');

const NPM_CLI = path.join(
  path.dirname(process.execPath),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
const BUILD_PRESENT = existsSync(path.join(ROOT, 'dist'));
const NPM_PRESENT = existsSync(NPM_CLI);

interface PackEntry {
  readonly path: string;
}
interface PackReport {
  readonly files: readonly PackEntry[];
}

let measured: PackReport | undefined;

/** npm's own answer to "what would this package contain", scripts disabled. */
function inventory(): PackReport {
  if (measured) return measured;
  const result = spawnSync(
    process.execPath,
    [NPM_CLI, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  expect(
    result.status,
    `npm pack --dry-run exited ${String(result.status)}: ${String(result.stderr).slice(0, 400)}`,
  ).toBe(0);
  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  expect(start, 'npm answered with no JSON inventory').toBeGreaterThanOrEqual(0);
  const parsed = JSON.parse(result.stdout.slice(start, end + 1)) as readonly PackReport[];
  expect(parsed.length).toBe(1);
  measured = parsed[0] as PackReport;
  return measured;
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

/** Binary payloads are not prose a customer reads; the credential gate says so too. */
function isText(text: string): boolean {
  return !text.includes('\u0000');
}

/** Every tracked text file, `tests/` included — that inclusion is the point. */
function trackedText(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of git(['ls-files']).split('\n').filter(Boolean)) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (isText(text)) map.set(file, text);
  }
  return map;
}

/** The roots npm ships, read at exactly the paths npm lists. */
function shippedText(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of inventory().files) {
    const relative = entry.path.replace(/^package\//, '');
    const full = path.join(ROOT, relative);
    expect(existsSync(full), `npm lists ${relative} but this tree has no such file`).toBe(true);
    const text = readFileSync(full, 'utf8');
    if (isText(text)) map.set(relative, text);
  }
  return map;
}

function findingsBy(
  texts: Map<string, string>,
  boundaries: ('owner' | 'concrete')[],
): HomePathFinding[] {
  const found: HomePathFinding[] = [];
  for (const [file, text] of texts) {
    found.push(...scanHomePaths(file, text, boundaries));
  }
  return found;
}

function describeFindings(findings: readonly HomePathFinding[]): string {
  return findings
    .slice(0, 24)
    .map((f) => `${f.file}:${f.line} ${f.form} ${f.excerpt}`)
    .join('\n');
}

/** The owner spelled as a person, never as a directory — a name a fixture may hold. */
function ownerAsPerson(): string {
  return HOME_OWNER.charAt(0).toUpperCase() + HOME_OWNER.slice(1);
}

describe('the detector separates a path from a name', () => {
  it('reports the owner in a Windows path position, prose spelling', () => {
    const text = `mounted at C:\\Users\\${ownerAsPerson()} R A\\.codex`;
    expect(scanHomePaths('seed.md', text, ['owner']).map((f) => f.form)).toEqual(['owner-path']);
  });

  it('reports the owner in a Windows path position, escaped source spelling', () => {
    const text = `title: 'Fix C:\\\\Users\\\\${HOME_OWNER}\\\\.ssh\\\\id_rsa'`;
    expect(scanHomePaths('seed.ts', text, ['owner']).map((f) => f.form)).toEqual(['owner-path']);
  });

  it('reports the owner in a POSIX path position', () => {
    const text = `Copied from /home/${HOME_OWNER}/build/datekit/src/parser.ts`;
    expect(scanHomePaths('seed.ts', text, ['owner']).map((f) => f.form)).toEqual(['owner-path']);
  });

  it('reports the 8.3 alias, which the long-form rule cannot see', () => {
    expect(HOME_OWNER_83).toBe(`${HOME_OWNER.slice(0, 6)}~1`);
    const text = `(\`C:\\Users\\${HOME_OWNER_83}\\…\`)`;
    expect(scanHomePaths('seed.md', text, ['owner']).map((f) => f.form)).toEqual(['owner-short']);
  });

  it('reports both spellings from one line of prose, because both are paths', () => {
    const text = `an 8.3 short path \`C:\\Users\\${HOME_OWNER_83}\\…\` names the same directory as \`C:\\Users\\${ownerAsPerson()} R A\\…\``;
    expect(scanHomePaths('seed.md', text, ['owner']).map((f) => f.form)).toEqual([
      'owner-path',
      'owner-short',
    ]);
  });

  it('does not report the owner used as a person, which a fixture may name', () => {
    const text = `expect(approve(${JSON.stringify(`${ownerAsPerson()} R A`)})).toBe(true)`;
    expect(scanHomePaths('seed.test.ts', text, ['owner'])).toEqual([]);
  });

  it('does not report an elided path, which is how this project quotes a screen', () => {
    const text = 'Run record:   C:\\Users\\…\\mergesutra\\.mergesutra\\runs\\run-x.json';
    expect(scanHomePaths('README.md', text)).toEqual([]);
  });

  it('does not report a regex character class that merely mentions Users', () => {
    const text = 'expect(page).not.toMatch(/[\\\\]Users[\\\\/]/i);';
    expect(scanHomePaths('seed.test.ts', text, ['concrete'])).toEqual([]);
  });

  it('reports any concrete home path on the artifact boundary, whoever it names', () => {
    const forms = scanHomePaths('README.md', 'see C:\\Users\\someone\\x\\y and /home/other/z', [
      'concrete',
    ]).map((f) => f.form);
    expect(forms).toEqual(['concrete-home-path', 'concrete-home-path']);
  });

  it('reports a home path that ends the text instead of continuing into a directory', () => {
    expect(scanHomePaths('seed.md', 'mounted at /home/someone', ['concrete'])).toHaveLength(1);
  });

  it('never echoes the identity it found', () => {
    const planted = [
      `C:\\Users\\${ownerAsPerson()} R A\\file.ts`,
      `C:\\Users\\${HOME_OWNER_83}\\file.ts`,
      `/home/${HOME_OWNER}/build/x`,
      'title: C:\\\\Users\\\\' + HOME_OWNER + '\\\\.ssh',
    ];
    for (const text of planted) {
      const found = scanHomePaths('seed.ts', text);
      expect(found.length, text).toBeGreaterThan(0);
      for (const finding of found) {
        expect(finding.excerpt.toLowerCase()).not.toContain(HOME_OWNER);
      }
    }
  });
});

describe('the published repository does not carry its author home', () => {
  const tree = trackedText();

  it('reads the whole tracked tree, the suite included', () => {
    const files = [...tree.keys()];
    expect(files.length, 'the tree scan found no files to read').toBeGreaterThan(100);
    const underTest = files.filter((file) => file.startsWith('tests/'));
    expect(
      underTest.length,
      'the tree scan quietly started excluding tests/, where the fixtures live',
    ).toBeGreaterThan(20);
    expect(files).toContain('CHANGELOG.md');
    expect(files).toContain('README.md');
    expect(files).toContain('docs/SECURITY_GAP_REGISTER.md');
  });

  it('names no home directory belonging to the developer, anywhere in it', () => {
    const findings = findingsBy(tree, ['owner']);
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('tolerates the elided spelling the tree actually uses', () => {
    const elidedLines = new Set<string>();
    for (const text of tree.values()) {
      for (const line of text.split('\n')) {
        if (/[/\\]Users[/\\]…/u.test(line)) elidedLines.add(line.trim());
      }
    }
    expect(
      elidedLines.size,
      'the quoting this rule exists to tolerate has itself gone missing, so the tolerance is untested',
    ).toBeGreaterThan(0);
    for (const line of elidedLines) {
      expect(scanHomePaths('quoting.md', line, ['owner']), line).toEqual([]);
    }
  });

  it('keeps the fixture directory inside the tree it scans', () => {
    const body = /function trackedText\(\): Map<string, string> \{[\s\S]*?\n\}/.exec(SELF)?.[0];
    expect(body, 'this file no longer defines the tree inventory').toBeTruthy();
    expect(body).toContain("['ls-files']");
    expect(
      body,
      'a tests/ exclusion here would inherit the credential gate blind spot into the boundary that exists to cover it',
    ).not.toMatch(/startsWith\(['"]tests\/['"]\)/);
  });
});

describe('the release path runs this gate', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    readonly scripts?: Record<string, string>;
  };

  it('is on the list that packs and publishes consult', () => {
    const verify = manifest.scripts?.['verify:package'] ?? '';
    expect(
      verify,
      'npm pack and npm publish no longer run the home-path boundary, so an artifact that names a person could ship',
    ).toContain('home-path-boundary.test.ts');
  });
});

describe.skipIf(!BUILD_PRESENT || !NPM_PRESENT)(
  'the installed artifact names nobody’s directory',
  () => {
    const shipped = shippedText();

    it('reads what npm itself says it would ship', () => {
      expect(shipped.size, 'the package scan found no files to read').toBeGreaterThan(20);
      expect(shipped.has('README.md')).toBe(true);
      expect(shipped.has('package.json')).toBe(true);
    });

    it('carries no concrete home path for any user', () => {
      const findings = findingsBy(shipped, ['concrete']);
      expect(findings, describeFindings(findings)).toEqual([]);
    });

    it('carries no owner path either, so neither rule is carrying the other', () => {
      const findings = findingsBy(shipped, ['owner']);
      expect(findings, describeFindings(findings)).toEqual([]);
    });
  },
);

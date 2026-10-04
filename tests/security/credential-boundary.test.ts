import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NAMED_SECRET_ENV_NAMES,
  SENSITIVE_HEADER_NAMES,
  broadMaskHits,
  isInertCredentialValue,
  runtimeSecretValues,
  scanForCredentials,
  type BroadMaskHit,
  type CredentialFamily,
  type CredentialFinding,
} from '../helpers/credentialScan.js';
import { npmCliScript, requireNpmCli } from '../helpers/npmInvocation.js';

/**
 * S12-24 — does anything this build hands a customer carry a credential?
 *
 * The register closed this item as "clean, with the false positives named", and
 * the naming was done once, by hand, over the commit set that existed when it
 * was written. A hand-run scan is a statement about the past. This file is the
 * same claim as a gate: three boundaries are re-derived and re-scanned on every
 * run, so a credential planted afterwards fails one of them.
 *
 * The three boundaries are the ones a customer actually crosses, measured rather
 * than assumed:
 *
 * 1. **The package.** Everything npm would put in a tarball, taken from npm's own
 *    inventory (`publish-contents.test.ts` established that npm is the only thing
 *    that decides), and read back from disk at exactly those paths. Source maps
 *    and declaration files are in this set: they are the artifacts nobody reviews
 *    by eye, and an embedded `sourcesContent` field would be a way to ship a file
 *    the allowlist had refused.
 * 2. **The tracked tree, outside `tests/`.** A visitor to the repository reads
 *    this, and it is where a hand-written example key tends to live.
 * 3. **History.** What a clone carries. Every line ever added outside `tests/`,
 *    from every reachable commit, is re-derived rather than trusted to the
 *    register's earlier count — that count named 117 commits and this checkout can
 *    now reach 150.
 *
 * `tests/` is excluded from boundaries 2 and 3, and the exclusion is itself
 * pinned rather than assumed: a suite that cannot plant a fake credential cannot
 * prove it detects one, so the fixtures carry them by design. What makes the
 * exclusion safe is that `tests/` never ships, which is asserted below against
 * the inventory rather than inherited from memory.
 *
 * No finding is reported with its value. `scanForCredentials` returns a preview
 * that keeps only the public prefix of the matched span; one control test asserts
 * that property over every planted secret in this file, because a leak check that
 * leaks is worse than none.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SELF = readFileSync(fileURLToPath(import.meta.url), 'utf8');

interface ConfigFile {
  readonly compilerOptions: { readonly outDir?: string };
}

const buildConfig = JSON.parse(
  readFileSync(path.join(ROOT, 'tsconfig.build.json'), 'utf8'),
) as ConfigFile;
const DIST_NAME = buildConfig.compilerOptions.outDir ?? 'dist';
const DIST_DIR = path.join(ROOT, DIST_NAME);
const BUILD_PRESENT = existsSync(DIST_DIR);

const NPM_CLI = npmCliScript();
const NPM_PRESENT = NPM_CLI !== null;

interface PackEntry {
  readonly path: string;
}

interface PackReport {
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: readonly PackEntry[];
}

let measured: PackReport | undefined;

/** npm's own answer to "what would this package contain", with lifecycle scripts disabled. */
function inventory(): PackReport {
  if (measured) return measured;
  const argv = [requireNpmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'];
  const result = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
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

let packed: Map<string, string> | undefined;

/** Text of everything that would ship, keyed by its package-relative path. */
function packedText(): Map<string, string> {
  if (packed) return packed;
  const map = new Map<string, string>();
  for (const entry of inventory().files) {
    const relativePath = entry.path.replace(/^package\//, '');
    const full = path.join(ROOT, relativePath);
    expect(existsSync(full), `npm lists ${relativePath} but this tree has no such file`).toBe(true);
    map.set(relativePath, readFileSync(full, 'utf8'));
  }
  packed = map;
  return map;
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

/** Tracked files a customer can read, excluding the fixtures that carry planted controls. */
function trackedNonTestFiles(): string[] {
  return git(['ls-files'])
    .split('\n')
    .filter((file) => file !== '' && !file.startsWith('tests/'));
}

/**
 * The prefix-bearing families, which carry no syntax-dependent judgement.
 *
 * Boundary 3 reads a patch, not a file: an `=` in a diff can be prose, and only
 * these five shapes are unambiguous enough to accuse a line of carrying a
 * credential without knowing what file it came from.
 */
const SHAPE_ONLY_FAMILIES: readonly CredentialFamily[] = [
  'bearer-key',
  'github-token',
  'slack-token',
  'aws-access-key-id',
  'private-key-material',
];

function shapeFindings(file: string, text: string): CredentialFinding[] {
  return scanForCredentials(file, text).filter((finding) =>
    SHAPE_ONLY_FAMILIES.includes(finding.family),
  );
}

/**
 * The one credential-shaped string this repository's readable tree carries.
 *
 * `docs/SECURITY_GAP_REGISTER.md` names a Stage 12 fixture value while reporting
 * that the fixture was caught and masked — measured as the only shape hit in 138
 * tracked non-test files and in 42,713 added lines outside `tests/`. The
 * allowance is one slot at one path for one family: a second key anywhere, or any
 * other family at that path, still fails the scan.
 */
const NAMED_PLANTED_CONTROLS = [
  {
    file: 'docs/SECURITY_GAP_REGISTER.md',
    family: 'bearer-key' as CredentialFamily,
    prefix: 'sk-',
    reason: 'names a Stage 12 redaction fixture in prose',
  },
];

function isControlled(finding: CredentialFinding): boolean {
  return NAMED_PLANTED_CONTROLS.some(
    (control) =>
      control.file === finding.file &&
      control.family === finding.family &&
      finding.excerpt.includes(control.prefix),
  );
}

function describeFindings(findings: readonly CredentialFinding[]): string {
  return findings
    .slice(0, 15)
    .map((f) => `${f.file}:${f.line} ${f.family} ${f.excerpt}`)
    .join('\n');
}

/** Values planted by this file. They are fake, and they are also the leak check. */
const PLANTED = {
  bearer: 'sk-Plant1234567890abcdef',
  githubClassic: 'ghp_Plant1234567890abcdefgh',
  githubFineGrained: 'github_pat_Plant1234567890ab',
  slack: 'xoxb-Plant12345678-1234567890123',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  assignment: 'Plant1234567890abcdefgh',
  header: 'Basic Pl1234567890abcdefghij',
  runtime: 'plant-runtime-value-1234567890',
};

const PEM_PLANTED = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'cGxhbnQta2V5LW1hdGVyaWFsLWRvZXMtbm90LWxvYWQ=',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

/** Every planted span a masked excerpt must not reproduce. */
const ALL_PLANTED = [...Object.values(PLANTED), 'cGxhbnQta2V5LW1hdGVyaWFs'];

function families(findings: readonly CredentialFinding[]): CredentialFamily[] {
  return [...new Set(findings.map((f) => f.family))].sort() as CredentialFamily[];
}

describe('the boundary detector reports every family it claims to (S12-24)', () => {
  it('reports a BharatCode/OpenAI-style bearer value', () => {
    const findings = scanForCredentials('planted.ts', `const auth = '${PLANTED.bearer}';`);
    expect(families(findings)).toEqual(['bearer-key']);
  });

  it('reports both GitHub token forms this project recognises', () => {
    expect(families(scanForCredentials('planted.md', PLANTED.githubClassic))).toEqual([
      'github-token',
    ]);
    expect(families(scanForCredentials('planted.md', PLANTED.githubFineGrained))).toEqual([
      'github-token',
    ]);
  });

  it('reports a Slack token and an AWS access key id', () => {
    expect(families(scanForCredentials('planted.md', PLANTED.slack))).toEqual(['slack-token']);
    expect(families(scanForCredentials('planted.md', PLANTED.aws))).toEqual(['aws-access-key-id']);
  });

  it('reports private key material that spans lines', () => {
    const findings = scanForCredentials('planted.txt', `here it is:\n${PEM_PLANTED}\nbye`);
    expect(families(findings)).toEqual(['private-key-material']);
    expect(findings[0]?.line).toBe(2);
  });

  it('reports an environment-style assignment of a named secret', () => {
    for (const name of NAMED_SECRET_ENV_NAMES) {
      const findings = scanForCredentials('planted.sh', `export ${name}=${PLANTED.assignment}`);
      expect(families(findings), `export ${name}=... must be reported`).toEqual([
        'secret-assignment',
      ]);
    }
  });

  it('reports a JSON assignment of a named secret carrying a quoted literal', () => {
    const findings = scanForCredentials('planted.json', `{ "GH_TOKEN": "${PLANTED.assignment}" }`);
    expect(families(findings)).toEqual(['secret-assignment']);
  });

  it('reports a sensitive header carrying a literal value', () => {
    for (const name of SENSITIVE_HEADER_NAMES) {
      const findings = scanForCredentials('planted.txt', `${name}: ${PLANTED.header}`);
      expect(families(findings), `${name}: <literal> must be reported`).toEqual([
        'authorization-header',
      ]);
    }
  });

  it('reports a runtime value wherever it appears verbatim', () => {
    const findings = scanForCredentials(
      'planted.md',
      `the note repeats the configured key: ${PLANTED.runtime}`,
      [PLANTED.runtime],
    );
    expect(families(findings)).toEqual(['known-secret-value']);
  });

  it('collects the values of the named environment variables, and only those', () => {
    const collected = runtimeSecretValues({
      BHARATCODE_API_KEY: PLANTED.runtime,
      GH_TOKEN: '',
      GITHUB_TOKEN: `  ${PLANTED.runtime}  `,
      HOME: '/somewhere/private',
      NPM_TOKEN: 'a-name-this-project-does-not-claim',
    });
    expect(collected.map((entry) => entry.name).sort()).toEqual([
      'BHARATCODE_API_KEY',
      'GITHUB_TOKEN',
    ]);
    expect(collected.map((entry) => entry.value)).toEqual([PLANTED.runtime, PLANTED.runtime]);
  });

  it('reports nothing without a masked excerpt, and never reports the value', () => {
    const corpus = [
      `const auth = '${PLANTED.bearer}';`,
      PLANTED.githubClassic,
      PLANTED.githubFineGrained,
      PLANTED.slack,
      PLANTED.aws,
      PEM_PLANTED,
      `export GITHUB_TOKEN=${PLANTED.assignment}`,
      `{ "GH_TOKEN": "${PLANTED.assignment}" }`,
      `authorization: ${PLANTED.header}`,
      `a line carrying ${PLANTED.runtime} verbatim`,
    ].join('\n');
    const findings = scanForCredentials('planted.txt', corpus, [PLANTED.runtime]);
    expect(new Set(findings.map((f) => f.family)).size).toBe(8);
    expect(findings.length).toBeGreaterThanOrEqual(10);
    for (const finding of findings) {
      expect(finding.excerpt, `${finding.family} excerpt must be masked`).toContain('[REDACTED]');
      for (const planted of ALL_PLANTED) {
        expect(
          finding.excerpt.includes(planted),
          `a ${finding.family} excerpt carried a planted value`,
        ).toBe(false);
      }
    }
  });
});

describe('the boundary detector leaves code alone that only looks like a credential', () => {
  it('ignores prose that carries a near-miss prefix', () => {
    const prose = [
      'the risk-classified gate is documented in README.md',
      'a breaking-change note and a short sk-abc fragment',
      'ghp_ is the classic prefix, mentioned without a token',
      'AKIA by itself is not an access key id',
      'argv-only mode, xoxb style names, and a PEM described in words',
    ].join('\n');
    expect(scanForCredentials('prose.md', prose)).toEqual([]);
  });

  it('ignores a type position, which is where most of the shipped vocabulary sits', () => {
    const positions = [
      'readonly apiKey: string;',
      'prompt_tokens: z.ZodOptional<z.ZodNumber>;',
      'promptTokens: z.number().int().nonnegative().nullable().default(null),',
      'readonly token: string;',
      "apiKeySource: 'environment'",
      'const token = argv[index];',
    ];
    for (const line of positions) {
      expect(scanForCredentials('types.d.ts', line), line).toEqual([]);
    }
  });

  it('ignores the three lines this product really builds its credentials from', () => {
    // src/bharatcode/client.ts:112 and :233, src/config/load-config.ts:69.
    const real = [
      '          apiKey: deps.config?.apiKey,',
      '          authorization: `Bearer ${auth}`,',
      '  const apiKey = env.BHARATCODE_API_KEY?.trim() || undefined;',
    ];
    for (const line of real) {
      expect(scanForCredentials('src.ts', line), line).toEqual([]);
    }
  });

  it('ignores placeholders, masked values, references and bare mentions', () => {
    const lines = [
      'GITHUB_TOKEN=<value>',
      'export BHARATCODE_API_KEY="$BHARATCODE_API_KEY"',
      'const GITHUB_TOKEN = process.env.GITHUB_TOKEN;',
      'authorization: Bearer <token>',
      'x-api-key: [REDACTED]',
      'Set the BHARATCODE_API_KEY environment variable.',
      'Credentials come only from `BHARATCODE_API_KEY` (environment)',
      'token=…',
      'DEPLOY_TOKEN=<value>',
      'password: hunter2',
    ];
    for (const line of lines) {
      expect(scanForCredentials('inert.txt', line), line).toEqual([]);
    }
  });

  it('draws the inert/finding line where a literal is what carries the secret', () => {
    expect(isInertCredentialValue(PLANTED.assignment)).toBe(false);
    expect(isInertCredentialValue(`"${PLANTED.assignment}"`)).toBe(false);
    expect(isInertCredentialValue('deps.config?.apiKey')).toBe(true);
    expect(isInertCredentialValue('z.ZodOptional<z.ZodNumber>')).toBe(true);
    expect(isInertCredentialValue('4096')).toBe(true);
    expect(isInertCredentialValue('')).toBe(true);
    expect(isInertCredentialValue('<value>')).toBe(true);
    expect(isInertCredentialValue('[REDACTED]')).toBe(true);
    expect(isInertCredentialValue('hunter2')).toBe(true);
  });
});

describe('the scan covers what the shipped redactor claims to cover', () => {
  it('names every environment secret the built redactor names', () => {
    expect(BUILD_PRESENT, 'dist/ must be built to compare vocabularies').toBe(true);
    const built = readFileSync(path.join(DIST_DIR, 'security', 'redaction.js'), 'utf8');
    for (const name of NAMED_SECRET_ENV_NAMES) {
      expect(
        built.includes(`'${name}'`),
        `${name} is scanned but the built redactor no longer names it`,
      ).toBe(true);
    }
    for (const header of SENSITIVE_HEADER_NAMES) {
      expect(
        built.includes(`'${header}'`),
        `${header} is scanned but the built redactor no longer names it`,
      ).toBe(true);
    }
  });

  it('covers every shape SECURITY_MODEL.md claims the redactor masks', () => {
    const model = readFileSync(path.join(ROOT, 'docs', 'SECURITY_MODEL.md'), 'utf8');
    const claim = /(^|\n)## 6\. Secret protection[^\n]*\n+([\s\S]*?)\n\n/.exec(model)?.[2] ?? '';
    expect(claim, 'SECURITY_MODEL.md no longer has a §6 claim to check').not.toBe('');
    for (const needle of ['sk-', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'xox', 'AKIA', 'PEM']) {
      expect(claim, `the doc claim no longer lists ${needle}`).toContain(needle);
    }
    // Every all-caps name the claim paragraph carries must be a name this scan
    // looks for. `AKIA` is the one token §6 lists that this scan reaches through a
    // key prefix rather than an environment variable.
    const shapePrefixesInClaim = new Set(['AKIA']);
    for (const match of claim.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) {
      const name = match[1] ?? '';
      const covered = NAMED_SECRET_ENV_NAMES.includes(name) || shapePrefixesInClaim.has(name);
      expect(covered, `${name} is claimed in §6 but covered by neither scan`).toBe(true);
    }
  });
});

describe('nothing that ships carries a credential (S12-24)', () => {
  it('scans exactly the files npm would pack, and they are not trivially few', () => {
    expect(NPM_PRESENT, 'npm must be reachable for the inventory').toBe(true);
    const report = inventory();
    const files = packedText();
    expect(files.size).toBe(report.files.length);
    expect(files.size).toBeGreaterThanOrEqual(400);
    const bytes = [...files.values()].reduce((sum, text) => sum + text.length, 0);
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(report.unpackedSize).toBeGreaterThan(1_000_000);
  });

  it('ships no test fixture, which is what makes excluding tests/ safe', () => {
    const roots = new Set([...packedText().keys()].map((file) => file.split('/')[0] ?? file));
    expect([...roots].sort()).toEqual([
      'BharatCode.txt',
      'LICENSE',
      'README.md',
      'dist',
      'package.json',
    ]);
    for (const excluded of ['tests', 'src', 'docs', 'coverage', '.mergesutra']) {
      expect(roots.has(excluded), `${excluded}/ must not reach the package`).toBe(false);
    }
  });

  it('finds no credential of any family in any packed file', () => {
    const findings: CredentialFinding[] = [];
    for (const [file, text] of packedText()) findings.push(...scanForCredentials(file, text));
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('finds no credential in the built maps and declarations nobody reads by eye', () => {
    const derived = [...packedText()].filter(
      ([file]) => file.endsWith('.map') || file.endsWith('.d.ts'),
    );
    expect(derived.length).toBeGreaterThanOrEqual(200);
    const findings: CredentialFinding[] = [];
    for (const [file, text] of derived) {
      expect(
        text.includes('sourcesContent'),
        `${file} embeds source the allowlist refused to ship`,
      ).toBe(false);
      findings.push(...scanForCredentials(file, text));
    }
    expect(findings, describeFindings(findings)).toEqual([]);
  });

  it('finds no value this machine advertises as a secret', () => {
    const values = runtimeSecretValues().map((entry) => entry.value);
    const hits: string[] = [];
    for (const [file, text] of packedText()) {
      for (const value of values) if (text.includes(value)) hits.push(file);
    }
    expect(hits, 'a credential configured on this host appears in the package').toEqual([]);
  });

  it('would fail loudly if a credential were added to a packed file', () => {
    const index = packedText().get(path.posix.join(DIST_NAME, 'index.js'));
    const note = packedText().get('BharatCode.txt');
    expect(index, 'dist/index.js must be in the scanned set').toBeTruthy();
    expect(note, 'BharatCode.txt must be in the scanned set').toBeTruthy();
    expect(
      families(scanForCredentials(`${DIST_NAME}/index.js`, `${index}\n${PLANTED.bearer}\n`)),
    ).toEqual(['bearer-key']);
    expect(
      families(scanForCredentials(`${DIST_NAME}/index.js`, `${index}\n${PEM_PLANTED}\n`)),
    ).toEqual(['private-key-material']);
  });
});

describe('the tracked tree carries no credential beyond the named control', () => {
  it('scans every tracked file outside the fixtures', () => {
    const files = trackedNonTestFiles();
    expect(files.length).toBeGreaterThanOrEqual(100);
    for (const file of files) {
      expect(existsSync(path.join(ROOT, file)), `${file} is tracked but absent`).toBe(true);
    }
  });

  it('finds nothing but the one documented fake key in the register', () => {
    const findings: CredentialFinding[] = [];
    for (const file of trackedNonTestFiles()) {
      findings.push(...scanForCredentials(file, readFileSync(path.join(ROOT, file), 'utf8')));
    }
    const unexpected = findings.filter((finding) => !isControlled(finding));
    expect(unexpected, describeFindings(unexpected)).toEqual([]);
    expect(findings.map((f) => `${f.file}#${f.family}`).sort()).toEqual(
      NAMED_PLANTED_CONTROLS.map((control) => `${control.file}#${control.family}`),
    );
  });

  it('has never tracked a file whose name announces it holds secrets', () => {
    const added = git(['log', '--all', '--diff-filter=A', '--name-only', '--format='])
      .split('\n')
      .filter((line) => line !== '');
    expect(new Set(added).size).toBeGreaterThan(100);
    const secretNamed = [
      ...new Set(
        added.filter((file) =>
          /(^|\/)\.env(\.|$)|\.pem$|(^|\/)id_rsa|(^|\/)\.npmrc|(^|\/)secrets?($|\/)/i.test(file),
        ),
      ),
    ];
    expect(secretNamed, `${secretNamed.length} secret-named path(s) ever tracked`).toEqual([]);
  });
});

describe('git history carries no credential outside the fixtures', () => {
  it('finds nothing but the named control in every line ever added', () => {
    const commits = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
    expect(commits.length).toBeGreaterThanOrEqual(150);
    const patch = git([
      'log',
      '--all',
      '-p',
      '--no-color',
      '--diff-filter=AMRC',
      '--',
      '.',
      ':(exclude)tests',
    ]);
    const findings: CredentialFinding[] = [];
    let current = '';
    let added = 0;
    for (const line of patch.split('\n')) {
      const header = /^diff --git a\/(\S+)/.exec(line);
      if (header?.[1]) current = header[1];
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      added += 1;
      findings.push(...shapeFindings(current, line.slice(1)));
    }
    expect(added).toBeGreaterThan(30_000);
    expect(findings.map((f) => `${f.file}#${f.family}`).sort()).toEqual(
      NAMED_PLANTED_CONTROLS.filter((control) => SHAPE_ONLY_FAMILIES.includes(control.family)).map(
        (control) => `${control.file}#${control.family}`,
      ),
    );
  });
});

describe('the masking vocabulary is a mask, not a detector (the named false positives)', () => {
  it('matches dozens of ordinary positions in the shipped artifact', () => {
    const hits: BroadMaskHit[] = [];
    for (const [file, text] of packedText()) hits.push(...broadMaskHits(file, text));
    expect(hits.length).toBeGreaterThanOrEqual(20);
    const codePositions = hits.filter((hit) => hit.form === 'code');
    expect(codePositions.length).toBeGreaterThanOrEqual(10);
    for (const hit of codePositions) {
      expect(isInertCredentialValue(hit.rightHandSide), `${hit.file}:${hit.line}`).toBe(true);
    }
  });

  it('matches no position that names a secret this project swears never to print', () => {
    const hits: BroadMaskHit[] = [];
    for (const [file, text] of packedText()) hits.push(...broadMaskHits(file, text));
    const named = hits.filter((hit) =>
      NAMED_SECRET_ENV_NAMES.some((name) => name.toLowerCase() === hit.name.toLowerCase()),
    );
    expect(
      named.map((hit) => `${hit.file}:${hit.line} ${hit.name} ${hit.form}`),
      'a broad mask hit names a real secret variable; re-measure before trusting either scan',
    ).toEqual([]);
  });

  it('is why the boundary scan requires a literal, proven on a measured line', () => {
    const found: BroadMaskHit[] = [];
    for (const [file, text] of packedText()) {
      for (const hit of broadMaskHits(file, text)) {
        if (hit.name.toLowerCase() === 'apikey' && hit.form === 'code') found.push(hit);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    const sample = found[0] as BroadMaskHit;
    expect(
      scanForCredentials(sample.file, `x ${sample.name}: ${sample.rightHandSide} y`),
      `${sample.file}:${sample.line} was matched as a credential`,
    ).toEqual([]);
  });
});

describe('the scan is on the release path, not only in the suite', () => {
  interface Manifest {
    readonly scripts?: Record<string, string>;
  }
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;

  it('runs inside verify:package, so a pack refuses rather than ships', () => {
    const verify = manifest.scripts?.['verify:package'] ?? '';
    expect(verify, 'package.json declares no verify:package script').not.toBe('');
    expect(verify, 'the credential scan is not on the packaging path').toContain(
      'credential-boundary.test.ts',
    );
    const prepack = manifest.scripts?.prepack ?? '';
    expect(prepack, 'prepack does not reach verify:package').toContain('verify:package');
  });
});

describe('this file measures the inventory without re-entering the pack', () => {
  it('invokes npm exactly once, and that one time with both safety flags', () => {
    const body = /function inventory\(\): PackReport \{[\s\S]*?\n\}/.exec(SELF)?.[0] ?? '';
    expect(body, 'this file no longer defines the npm inventory measurement').toContain("'pack'");
    expect(body, 'a lifecycle-enabled pack would run prepack inside the verifier').toContain(
      '--ignore-scripts',
    );
    expect(body, 'a real pack would write a tarball into the checkout').toContain('--dry-run');
    // Which spawn reaches npm is answered by the shape of the call, not by the
    // token `NPM_CLI`: a filter quoting that token would match its own source line.
    const npmSpawns = SELF.split('\n').filter((line) => /spawnSync\(process\.execPath/.test(line));
    expect(
      npmSpawns.map((line) => line.trim()),
      'a second npm invocation must carry the same two flags',
    ).toHaveLength(1);
  });
});

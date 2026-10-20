import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'customer-evidence.mjs');
const SCRIPT = path.join(ROOT, 'scripts', 'customer-evidence-bundle.mjs');
const runChild = promisify(execFile);

interface Rule {
  leaked: boolean;
  sanitized: string;
}

/** The credential shapes the payload hands the rules, named so a lookup is total. */
type ShapeName =
  'github-token' | 'bharat-live-key' | 'openai-shape' | 'bearer' | 'scripted-sentinel' | 'plain';

interface HarnessOutput {
  patterns: string[];
  shapes: Record<ShapeName, Rule>;
  home: string;
  scrubbed: string[];
  kept: string;
  holds: boolean[];
  repeat: boolean[];
  relative: string[];
}

const CANARY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const HOST_HOME = '/home/mergesutra-ci-probe';
/**
 * A Windows machine's own two spellings of one directory. The product prints both: a
 * JSON field escapes the separators and Git's 8.3 alias replaces the long user name,
 * so a scrub that only knows the plain form a POSIX log line uses ships the identity
 * anyway. These names are synthetic; no real account is quoted here.
 */
const WIN_HOME = 'C:\\Users\\Probe User';
const WIN_TEMP = 'C:\\Users\\PROBE~1\\AppData\\Local\\Temp';
const escaped = (value: string) => value.replaceAll('\\', '\\\\');
const forward = (value: string) => value.replaceAll('\\', '/');
/** Every spelling the evidence can hold for one root, in the order the matrix asserts. */
function spellings(root: string, tail: string): string[] {
  return [`${root}\\${tail}`, escaped(`${root}\\${tail}`), forward(`${root}/${tail}`)];
}
const HOST_TEXTS = [
  ...spellings(WIN_HOME, 'AppData\\mergesutra-s17-a'),
  ...spellings(WIN_TEMP, 'mergesutra-s17-b'),
];
const NOT_A_PATH = 'the value stayed undefined and undefinedundefined';

/**
 * The rules live under scripts/, which vitest must not bundle — its loader cannot
 * resolve an absolute path containing spaces — and the bundle command is the thing
 * the workflow actually runs, so both are driven as real processes here.
 */
const HARNESS = `
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [payloadPath, libPath] = process.argv.slice(1);
const lib = await import(pathToFileURL(libPath).href);
const input = JSON.parse(await readFile(payloadPath, 'utf8'));

const shapes = {};
for (const [name, text] of Object.entries(input.shapes)) {
  shapes[name] = { leaked: lib.leaked(text), sanitized: lib.sanitize(text) };
}

process.env.MERGESUTRA_EVIDENCE_ROOTS = JSON.stringify(input.roots);
const repeated = lib.leaked(input.canary);
const again = lib.leaked(input.canary);
const third = lib.leaked(input.canary);

process.stdout.write(
  JSON.stringify({
    patterns: lib.SECRET_PATTERNS.map((pattern) => String(pattern)),
    shapes,
    home: lib.scrubHost(input.homeText),
    scrubbed: input.hostTexts.map((text) => lib.scrubHost(text)),
    kept: lib.scrubHost(input.notAPath),
    holds: [...input.hostTexts, input.notAPath].map((text) => lib.holdsHostPath(text)),
    repeat: [repeated, again, third],
    relative: input.files.map((file) =>
      lib.relativePosix(input.root, input.root + '/' + file),
    ),
  }),
);
`;

let harness: HarnessOutput;
let scratch: string | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'mergesutra-evidence-spec-'));
  const payload = path.join(scratch, 'cases.json');
  await writeFile(
    payload,
    JSON.stringify({
      root: '/work',
      canary: `authorisation ${CANARY} reused`,
      files: ['a.log', 'nested/b.log', 'c.log'],
      shapes: {
        'github-token': `authorisation ${CANARY} reused`,
        'bharat-live-key': 'use bc_live_AAAAAAAAAAAA now',
        'openai-shape': 'sk-proj-BBBBBBBBBBBBBBBB',
        bearer: 'Authorization: Bearer abcdefghijklmnop',
        'scripted-sentinel': 'scripted-gateway-not-a-real-credential',
        plain: 'the scenario reached its expected outcome',
      } satisfies Record<ShapeName, string>,
      homeText: `${HOST_HOME}/repo/.mergesutra/runs/1/report.md`,
      roots: [WIN_HOME, WIN_TEMP, HOST_HOME],
      hostTexts: HOST_TEXTS,
      notAPath: NOT_A_PATH,
    }),
    'utf8',
  );
  const { stdout } = await runChild(
    process.execPath,
    ['--input-type=module', '-e', HARNESS, payload, LIB],
    {
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  harness = JSON.parse(stdout) as HarnessOutput;
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

/** Run the bundle command exactly the workflow will, then read back what it wrote. */
async function bundle(
  source: Record<string, string>,
  extraEnv: Record<string, string> = {},
  seedArtifact: Record<string, string> = {},
): Promise<{ code: number; stdout: string; artifact: Record<string, string> }> {
  const root = await mkdtemp(path.join(scratch as string, 'run-'));
  const inDir = path.join(root, 'export');
  const outDir = path.join(root, 'artifact');
  for (const [name, contents] of Object.entries(source)) {
    const file = path.join(inDir, ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
  }
  for (const [name, contents] of Object.entries(seedArtifact)) {
    const file = path.join(outDir, ...name.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
  }
  const result = await runChild(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      MERGESUTRA_GATE_EXPORT_ROOT: inDir,
      MERGESUTRA_GATE_ARTIFACT_ROOT: outDir,
      MERGESUTRA_EVIDENCE_ROOTS: JSON.stringify([WIN_HOME, WIN_TEMP, HOST_HOME]),
      ...extraEnv,
    },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (value) => ({ stdout: value.stdout, code: 0 }),
    (error: { code?: number; stdout?: string }) => ({
      stdout: error.stdout ?? '',
      code: typeof error.code === 'number' ? error.code : 1,
    }),
  );
  const artifact: Record<string, string> = {};
  const names = await readdir(outDir, { recursive: true }).catch(() => []);
  for (const name of names) {
    const file = path.join(outDir, String(name));
    artifact[String(name).replaceAll('\\', '/')] = await readFile(file, 'utf8').catch(
      () => '<unreadable>',
    );
  }
  await rm(root, { recursive: true, force: true });
  return { code: result.code, stdout: result.stdout, artifact };
}

describe('the customer evidence redaction rules', () => {
  it('covers the credential shapes this harness could ever be holding', () => {
    expect(harness.patterns.join(' ')).toContain('bc_live_');
    expect(harness.patterns.join(' ')).toContain('sk-');
    expect(harness.patterns.join(' ')).toContain('gh[pousr]_');
    expect(harness.patterns.join(' ')).toContain('github_pat_');
    expect(harness.patterns.join(' ')).toContain('Bearer');
  });

  it('flags a credential and leaves the scripted sentinel alone', () => {
    expect(harness.shapes['github-token'].leaked).toBe(true);
    expect(harness.shapes['bharat-live-key'].leaked).toBe(true);
    expect(harness.shapes['openai-shape'].leaked).toBe(true);
    expect(harness.shapes.bearer.leaked).toBe(true);
    expect(harness.shapes['scripted-sentinel'].leaked).toBe(false);
    expect(harness.shapes.plain.leaked).toBe(false);
  });

  it('replaces the secret, keeps the surrounding text, and matches the abnormal value', () => {
    expect(harness.shapes['github-token'].sanitized).toContain('[REDACTED]');
    expect(harness.shapes['github-token'].sanitized).not.toContain(CANARY);
    expect(harness.shapes['github-token'].sanitized).toContain('authorisation');
    expect(harness.shapes['github-token'].sanitized).toContain('reused');
    expect(harness.shapes.plain.sanitized).toBe('the scenario reached its expected outcome');
  });

  it('scans the same text three times with the same answer, so a global regex cannot drift', () => {
    expect(harness.repeat).toEqual([true, true, true]);
  });

  it('scrubs the host home out of a published path without inventing one', () => {
    expect(harness.home).not.toContain(HOST_HOME);
    expect(harness.home).toContain('[host-home]');
    expect(harness.home).toContain('report.md');
  });

  it('scrubs the same directory however the host spells it', () => {
    expect(harness.scrubbed).toHaveLength(HOST_TEXTS.length);
    harness.scrubbed.forEach((text, index) => {
      expect(text, HOST_TEXTS[index]).not.toMatch(/Probe User|PROBE~1/);
      expect(text, HOST_TEXTS[index]).toContain('[host-home]');
      expect(text, HOST_TEXTS[index]).toMatch(/AppData|mergesutra-s17-a|mergesutra-s17-b/);
    });
  });

  it('scrubs only roots it was told about, so harmless text is not rewritten', () => {
    expect(harness.kept).toBe(NOT_A_PATH);
    expect(harness.holds.at(-1)).toBe(false);
  });

  it('names a host path it can see, which is what makes the artifact scan mean something', () => {
    expect(harness.holds).toHaveLength(HOST_TEXTS.length + 1);
    expect(harness.holds.slice(0, HOST_TEXTS.length)).toEqual(HOST_TEXTS.map(() => true));
  });

  it('names bundled files relative to the export root, in POSIX form', () => {
    expect(harness.relative).toEqual(['a.log', 'nested/b.log', 'c.log']);
  });
});

describe('the artifact bundle the hosted job uploads', () => {
  it('redacts a canary planted in the raw evidence and still ships the file', async () => {
    const run = await bundle({
      'journey/02-issue.log': `token ${CANARY} appeared here\nstack line\n`,
      'journey/environment.json': JSON.stringify({
        primaryCheckout: `${HOST_HOME}/fixtures/repo`,
        trackedFiles: ['src/slugify.js'],
      }),
      'summary.json': JSON.stringify({ scenarios: [{ scenario: 'journey', verdict: 'PASS' }] }),
    });
    expect(run.code, run.stdout).toBe(0);
    expect(run.stdout).toContain('CUSTOMER_EVIDENCE_PASS files=3');
    // Redaction is disclosed, not swallowed: a reader of the log has to be able to
    // see that the product's own bytes held a credential shape before they shipped.
    expect(run.stdout).toContain('CUSTOMER_EVIDENCE_REDACTIONS 1');
    expect(run.stdout).toContain('journey/02-issue.log');
    expect(run.artifact['journey/02-issue.log']).toContain('[REDACTED]');
    expect(run.artifact['journey/02-issue.log']).not.toContain(CANARY);
    expect(run.artifact['journey/02-issue.log']).toContain('stack line');
    expect(run.artifact['journey/environment.json']).toContain('[host-home]');
    expect(run.artifact['journey/environment.json']).not.toContain(HOST_HOME);
    expect(run.artifact['journey/environment.json']).toContain('src/slugify.js');
    expect(run.artifact['summary.json']).toContain('journey');
  });

  it('ships a host path in no spelling the product can print', async () => {
    const run = await bundle({
      'journey/environment.json': JSON.stringify({
        workspace: `${WIN_TEMP}\\mergesutra-s17-journey-Aa1\\customer-checkout`,
        gitdirPointer: `gitdir: ${forward(WIN_TEMP)}/mergesutra-s17-journey-Aa1/.git`,
      }),
      'journey/02-issue.log': `workspace ${WIN_HOME}\\repo is where the customer ran it\n`,
    });
    expect(run.code, run.stdout).toBe(0);
    expect(run.artifact['journey/environment.json']).not.toMatch(/Probe User|PROBE~1/);
    expect(run.artifact['journey/environment.json']).toContain('[host-home]');
    expect(run.artifact['journey/environment.json']).toContain('mergesutra-s17-journey-Aa1');
    expect(run.artifact['journey/02-issue.log']).not.toContain(WIN_HOME);
  });

  it('refuses an artifact tree that still holds a host path', async () => {
    const run = await bundle(
      { 'journey/02-issue.log': 'nothing to hide here\n' },
      {},
      { 'stale-from-an-earlier-run.json': JSON.stringify({ workspace: WIN_TEMP }) },
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/CUSTOMER_EVIDENCE_FAIL \d+ problem/);
    expect(run.stdout).toContain('host path after redaction');
    expect(run.stdout).toContain('stale-from-an-earlier-run.json');
  });

  it('refuses to upload an artifact tree that still holds a credential shape', async () => {
    const run = await bundle(
      { 'journey/02-issue.log': 'nothing to hide here\n' },
      {},
      {
        'stale-from-an-earlier-run.log': `authorisation ${CANARY} reused\n`,
      },
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/CUSTOMER_EVIDENCE_FAIL \d+ problem/);
    expect(run.stdout).toContain('credential shape after redaction');
    expect(run.stdout).toContain('stale-from-an-earlier-run.log');
    // The scan looks at the whole tree the job would upload, not only what this
    // step wrote, so a file that arrived from anywhere else cannot ride along.
    expect(run.artifact['stale-from-an-earlier-run.log']).toContain(CANARY);
  });

  it('fails rather than shipping an empty bundle', async () => {
    const run = await bundle({});
    expect(run.code).toBe(1);
    expect(run.stdout.toLowerCase()).toContain('no evidence');
  });

  it('refuses to silently drop a file over the byte bound', async () => {
    const run = await bundle(
      { 'big.log': 'x'.repeat(4096), 'small.log': 'kept\n' },
      { MERGESUTRA_GATE_ARTIFACT_MAX_BYTES: '512' },
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('big.log');
    expect(run.stdout).toContain('over the 512 byte limit');
    expect(run.artifact['big.log']).toBeUndefined();
    expect(run.artifact['small.log']).toBe('kept\n');
  });

  it('fails when the job named neither tree, instead of quietly bundling nothing', async () => {
    const result = await runChild(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 16 * 1024 * 1024,
    }).then(
      (value) => ({ stdout: value.stdout, code: 0 }),
      (error: { code?: number; stdout?: string }) => ({
        stdout: error.stdout ?? '',
        code: typeof error.code === 'number' ? error.code : 1,
      }),
    );
    expect(result.stdout).toContain('MERGESUTRA_GATE_EXPORT_ROOT');
    expect(result.stdout).toContain('MERGESUTRA_GATE_ARTIFACT_ROOT');
    expect(result.code).toBe(1);
  });
});

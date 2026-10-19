import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'customer-gate-verify.mjs');
const runChild = promisify(execFile);

const REVISION = 'a'.repeat(40);
const OTHER_REVISION = 'b'.repeat(40);
const FIXTURE_BASE = '6f3a0adb17389b93fd76b95c21a1c9eb7b161998';
const IMAGE = 'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7';
const SCENARIOS = [
  'journey',
  'failed-assertion',
  'interruption',
  'repair',
  'stale-patch',
  'forged-metadata',
  'no-sandbox',
  'repeated',
];

function summary(overrides: Record<string, unknown> = {}) {
  return {
    startedAt: '2026-10-19T09:00:00.000Z',
    finishedAt: '2026-10-19T09:20:00.000Z',
    mergeSutraVersion: '0.1.0',
    identity: {
      revision: REVISION,
      platform: 'linux',
      nodeVersion: 'v24.18.0',
      sandboxImage: IMAGE,
      fixtureBaseSha: FIXTURE_BASE,
    },
    scenarios: SCENARIOS.map((scenario) => ({
      scenario,
      verdict: 'PASS',
      problems: [],
      exitCodes: ['doctor=0', 'implement=3'],
      oracle: ['1', '2', '3', '4', '5'].map((n) => ({
        id: `ORACLE-AC-${n}`,
        verdict: 'PASS',
        detail: 'ok',
      })),
      damage: [],
      secrets: [],
      cleanup: { removed: true, remaining: 0, lastError: null },
    })),
    ...overrides,
  };
}

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

let scratch: string | undefined;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'mergesutra-gate-verify-spec-'));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
});

/** Write a summary and run the gate exactly the workflow will: env in, exit code out. */
async function gate(
  body: unknown,
  env: Record<string, string | undefined> = {},
  fileName = 'summary.json',
): Promise<Run> {
  const file = path.join(scratch as string, fileName);
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NO_COLOR: '1',
    MERGESUTRA_GATE_SUMMARY: file,
    MERGESUTRA_GATE_REVISION: REVISION,
    MERGESUTRA_GATE_SANDBOX_IMAGE: IMAGE,
    MERGESUTRA_GATE_NOT_BEFORE: '2026-10-19T08:59:00.000Z',
    MERGESUTRA_GATE_NOW: '2026-10-19T10:00:00.000Z',
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  const result = await runChild(process.execPath, [SCRIPT], {
    env: base,
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (value) => ({ stdout: value.stdout, stderr: value.stderr, code: 0 }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      // A killed child reports no code, and a gate that died without a verdict is a failure.
      code: typeof error.code === 'number' ? error.code : 1,
    }),
  );
  return result;
}

describe('the hosted customer gate command', () => {
  it('exits 0 and says which scenarios it certified', async () => {
    const run = await gate(summary());
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('CUSTOMER_GATE_PASS scenarios=8');
  });

  it('exits 1 on a falsified summary and prints the claim it refused', async () => {
    const run = await gate(
      summary({
        scenarios: summary().scenarios.map((row) =>
          row.scenario === 'journey' ? { ...row, verdict: 'FAIL' } : row,
        ),
      }),
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('CUSTOMER_GATE_FAIL');
    expect(run.stdout).toMatch(/CUSTOMER_GATE_FAIL \d+ problem/);
    expect(run.stdout).toContain('journey');
  });

  it('refuses evidence from a different commit', async () => {
    const run = await gate(summary(), { MERGESUTRA_GATE_REVISION: OTHER_REVISION });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(REVISION);
    expect(run.stdout).toContain(OTHER_REVISION);
  });

  it('fails, rather than passing, when the gate itself was not configured', async () => {
    const missing = await gate(summary(), {
      MERGESUTRA_GATE_SUMMARY: undefined,
      MERGESUTRA_GATE_REVISION: undefined,
      MERGESUTRA_GATE_SANDBOX_IMAGE: undefined,
      MERGESUTRA_GATE_NOT_BEFORE: undefined,
    });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('MERGESUTRA_GATE_SUMMARY');
    expect(missing.stdout).toContain('MERGESUTRA_GATE_REVISION');
    expect(missing.stdout).toContain('MERGESUTRA_GATE_SANDBOX_IMAGE');
    expect(missing.stdout).toContain('MERGESUTRA_GATE_NOT_BEFORE');

    const empty = await gate(summary(), { MERGESUTRA_GATE_REVISION: '' });
    expect(empty.code).toBe(1);
    expect(empty.stdout).toContain('cannot bind the evidence');
    expect(empty.stdout).toContain('MERGESUTRA_GATE_REVISION');
  });

  it('fails when the named artifact is missing or is not readable JSON', async () => {
    const absent = await gate(summary(), {
      MERGESUTRA_GATE_SUMMARY: path.join(scratch as string, 'nope.json'),
    });
    expect(absent.code).toBe(1);
    expect(absent.stdout).toContain('nope.json');

    const broken = await gate('{not json', {}, 'broken.json');
    expect(broken.code).toBe(1);
    expect(broken.stdout.toLowerCase()).toContain('parse');
  });

  it('keeps its verdict line on stdout and its detail after it', async () => {
    const run = await gate(
      summary({
        scenarios: summary().scenarios.map((row) =>
          row.scenario === 'repeated' ? { ...row, secrets: ['01-journey.log'] } : row,
        ),
      }),
    );
    expect(run.code).toBe(1);
    const lines = run.stdout.split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toMatch(/^CUSTOMER_GATE_FAIL \d+ problem/);
    expect(lines.slice(1).join('\n')).toContain('credential-shaped');
    expect(run.stderr).toBe('');
  });
});

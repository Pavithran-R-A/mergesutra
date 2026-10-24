import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, describe, it, expect } from 'vitest';
import { runDoctor, formatDoctor, doctorAction, type Runner } from '../../src/cli/doctor.js';
import { createRenderer } from '../../src/cli/render.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import { NAMED_SECRET_ENV_NAMES } from '../helpers/credentialScan.js';

const KEY = 'sk-doctor-SECRETNOTSHOWN-000';
const DIGEST = `node@sha256:${'a'.repeat(64)}`;

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-doctor-sandbox-'));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const okRunner: Runner = async (file, args) => {
  if (file === 'git') return { code: 0, stdout: 'git version 2.55.0', stderr: '' };
  if (file === 'gh' && args[0] === 'auth') return { code: 0, stdout: 'Logged in', stderr: '' };
  if (file === 'gh') return { code: 0, stdout: 'gh version 2.96.0', stderr: '' };
  return { code: 1, stdout: '', stderr: 'not found' };
};

const missingGitRunner: Runner = async (file) => {
  if (file === 'git') throw new Error('spawn git ENOENT');
  return { code: 0, stdout: 'x', stderr: '' };
};

function statusOf(checks: { name: string; status: string }[], name: string): string {
  return checks.find((c) => c.name === name)?.status ?? 'MISSING';
}

describe('runDoctor', () => {
  it('passes the checks that need no sandbox (offline, reach skipped)', async () => {
    const checks = await runDoctor({
      env: { BHARATCODE_API_KEY: KEY },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    expect(statusOf(checks, 'Node')).toBe('PASS');
    expect(statusOf(checks, 'Git')).toBe('PASS');
    expect(statusOf(checks, 'GitHub CLI')).toBe('PASS');
    expect(statusOf(checks, 'GitHub auth')).toBe('PASS');
    expect(statusOf(checks, 'BharatCode key')).toBe('PASS');
    expect(statusOf(checks, 'BharatCode reach')).toBe('SKIP');
  });

  it('reports a missing BharatCode key as FAIL (handles config cleanly)', async () => {
    const checks = await runDoctor({ env: {}, run: okRunner, nodeVersion: '24.0.0' });
    expect(statusOf(checks, 'BharatCode key')).toBe('FAIL');
  });

  it('reports missing Git as FAIL', async () => {
    const checks = await runDoctor({
      env: { BHARATCODE_API_KEY: KEY },
      run: missingGitRunner,
      nodeVersion: '24.0.0',
    });
    expect(statusOf(checks, 'Git')).toBe('FAIL');
  });

  it('tests reachability only when connect is requested', async () => {
    const fakeClient = {
      healthCheck: async () => ({ reachable: true, configured: true, modelCount: 3 }),
    } as unknown as BharatCodeClient;
    const checks = await runDoctor({
      env: { BHARATCODE_API_KEY: KEY },
      run: okRunner,
      nodeVersion: '24.0.0',
      connect: true,
      makeClient: () => fakeClient,
    });
    expect(statusOf(checks, 'BharatCode reach')).toBe('PASS');
  });

  it('builds the production client when connect is requested and no factory is injected', async () => {
    // The shipped command has no dependency injection, so this is the only place the
    // production wiring is exercised: with a key present, --connect must actually ask
    // /models rather than report a SKIP that the live chain would read as a pass.
    const original = globalThis.fetch;
    let requested: string | undefined;
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'qwen-3.8-27b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const checks = await runDoctor({
        env: {
          BHARATCODE_API_KEY: KEY,
          BHARATCODE_API_BASE: 'https://bharatcode.test/api/model/v1',
        },
        run: okRunner,
        nodeVersion: '24.0.0',
        connect: true,
      });
      expect(statusOf(checks, 'BharatCode reach')).toBe('PASS');
      expect(requested).toBe('https://bharatcode.test/api/model/v1/models');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('flags an old Node runtime', async () => {
    const checks = await runDoctor({ env: {}, run: okRunner, nodeVersion: '18.0.0' });
    expect(statusOf(checks, 'Node')).toBe('FAIL');
  });
});

describe('repository sandbox readiness', () => {
  it('warns that repository commands will refuse when the sandbox is unconfigured', async () => {
    const checks = await runDoctor({
      env: { BHARATCODE_API_KEY: KEY },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    expect(statusOf(checks, 'Repository sandbox')).toBe('WARN');
    const detail = checks.find((c) => c.name === 'Repository sandbox')?.detail ?? '';
    expect(detail).toContain('MERGESUTRA_SANDBOX_IMAGE');
    expect(detail).toContain('MERGESUTRA_DOCKER_EXECUTABLE');
    expect(detail).toContain('SANDBOX_UNAVAILABLE');
  });

  it('does not call the environment ready when repository execution is unconfigured', async () => {
    const checks = await runDoctor({
      env: { BHARATCODE_API_KEY: KEY },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    const text = formatDoctor(checks, createRenderer({ color: false }));
    expect(text).toContain('Ready with warnings.');
    expect(text).not.toMatch(/^Ready\.$/m);
  });

  it('fails when only one mandatory variable is set', async () => {
    const cases = [
      { env: { MERGESUTRA_SANDBOX_IMAGE: DIGEST }, missing: 'MERGESUTRA_DOCKER_EXECUTABLE' },
      {
        env: { MERGESUTRA_DOCKER_EXECUTABLE: process.execPath },
        missing: 'MERGESUTRA_SANDBOX_IMAGE',
      },
    ];
    for (const { env, missing } of cases) {
      const checks = await runDoctor({ env, run: okRunner, nodeVersion: '24.0.0' });
      expect(statusOf(checks, 'Repository sandbox'), missing).toBe('FAIL');
      const detail = checks.find((c) => c.name === 'Repository sandbox')?.detail ?? '';
      expect(detail, missing).toContain(missing);
    }
  });

  it('fails a mutable image tag, naming the digest requirement', async () => {
    const checks = await runDoctor({
      env: {
        MERGESUTRA_SANDBOX_IMAGE: 'node:22',
        MERGESUTRA_DOCKER_EXECUTABLE: process.execPath,
      },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    expect(statusOf(checks, 'Repository sandbox')).toBe('FAIL');
    const detail = checks.find((c) => c.name === 'Repository sandbox')?.detail ?? '';
    expect(detail).toMatch(/digest/i);
  });

  it('fails a Docker executable selected by a relative path', async () => {
    const checks = await runDoctor({
      env: {
        MERGESUTRA_SANDBOX_IMAGE: DIGEST,
        MERGESUTRA_DOCKER_EXECUTABLE: 'docker',
      },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    expect(statusOf(checks, 'Repository sandbox')).toBe('FAIL');
    const detail = checks.find((c) => c.name === 'Repository sandbox')?.detail ?? '';
    expect(detail).toMatch(/absolute/i);
  });

  it('fails an absolute Docker path that is not an existing file', async () => {
    const cases = [path.join(await scratch(), 'docker-not-installed'), await scratch()];
    for (const dockerExecutable of cases) {
      const checks = await runDoctor({
        env: {
          MERGESUTRA_SANDBOX_IMAGE: DIGEST,
          MERGESUTRA_DOCKER_EXECUTABLE: dockerExecutable,
        },
        run: okRunner,
        nodeVersion: '24.0.0',
      });
      expect(statusOf(checks, 'Repository sandbox'), dockerExecutable).toBe('FAIL');
      const detail = checks.find((c) => c.name === 'Repository sandbox')?.detail ?? '';
      expect(detail, dockerExecutable).toMatch(/not an existing file/i);
    }
  });

  it('passes a digest-pinned image with an existing absolute Docker CLI, without running it', async () => {
    const dir = await scratch();
    const dockerExecutable = path.join(dir, 'docker');
    await writeFile(dockerExecutable, 'not executed by doctor');
    const checks = await runDoctor({
      env: {
        MERGESUTRA_SANDBOX_IMAGE: DIGEST,
        MERGESUTRA_DOCKER_EXECUTABLE: dockerExecutable,
      },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    // `okRunner` answers a docker invocation with code 1, so a PASS here is also
    // evidence that the check inspected the configured path instead of launching it.
    expect(statusOf(checks, 'Repository sandbox')).toBe('PASS');
    const detail = checks.find((c) => c.name === 'Repository sandbox')?.detail ?? '';
    expect(detail).toMatch(/fail-closed/i);
  });
});

describe('formatDoctor', () => {
  it('renders all check names and never leaks the API key value', async () => {
    const checks = await runDoctor({
      env: { BHARATCODE_API_KEY: KEY },
      run: okRunner,
      nodeVersion: '24.0.0',
    });
    const text = formatDoctor(checks, createRenderer({ color: false }));
    expect(text).toContain('MergeSutra doctor');
    expect(text).toContain('BharatCode key');
    expect(text).not.toContain(KEY);
  });

  it('prints no credential value this machine names, and echoes no gh auth output', async () => {
    // What this screen promises about itself is about credential VALUES: one value for every
    // named credential variable, plus the token line a real `gh auth status` prints on stdout.
    const planted: Record<string, string> = {};
    for (const name of NAMED_SECRET_ENV_NAMES) planted[name] = `sk-doctor-${name}-NOTPRINTED-000`;
    const ghToken = 'ghp_DoctorAuthStatusLineMustNotBeEchoed1234567890';
    const authRunner: Runner = async (file, args) => {
      if (file === 'git') return { code: 0, stdout: 'git version 2.55.0', stderr: '' };
      if (file === 'gh' && args[0] === 'auth') {
        return {
          code: 0,
          stdout: `github.com\n  Logged in to github.com account someone\n  - Active token: ${ghToken}\n`,
          stderr: '',
        };
      }
      if (file === 'gh') return { code: 0, stdout: 'gh version 2.96.0 (2026-07-02)', stderr: '' };
      return { code: 1, stdout: '', stderr: 'not found' };
    };

    const checks = await runDoctor({ env: planted, run: authRunner, nodeVersion: '24.0.0' });
    const text = formatDoctor(checks, createRenderer({ color: false }));

    for (const [name, value] of Object.entries(planted)) {
      expect(text, `${name} reached the doctor screen`).not.toContain(value);
    }
    expect(text, 'stdout read off gh is not display copy for this screen').not.toContain(ghToken);
    expect(statusOf(checks, 'GitHub auth'), 'the check still reports what it measured').toBe(
      'PASS',
    );
    expect(text).toContain('GitHub auth');
  });
});

describe('doctorAction exit codes', () => {
  it('returns non-zero when a FAIL is present', async () => {
    let code = 0;
    code = await doctorAction(
      { noColor: true },
      { env: {}, run: okRunner, nodeVersion: '24.0.0' },
      () => {},
    );
    expect(code).not.toBe(0);
  });

  it('returns zero when nothing fails (warnings and skips allowed)', async () => {
    const code = await doctorAction(
      { noColor: true },
      { env: { BHARATCODE_API_KEY: KEY }, run: okRunner, nodeVersion: '24.0.0' },
      () => {},
    );
    expect(code).toBe(0);
  });
});

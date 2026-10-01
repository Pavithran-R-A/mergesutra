import { describe, it, expect } from 'vitest';
import { runDoctor, formatDoctor, doctorAction, type Runner } from '../../src/cli/doctor.js';
import { createRenderer } from '../../src/cli/render.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import { NAMED_SECRET_ENV_NAMES } from '../helpers/credentialScan.js';

const KEY = 'sk-doctor-SECRETNOTSHOWN-000';

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
  it('passes when the environment is complete (offline, reach skipped)', async () => {
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

  it('flags an old Node runtime', async () => {
    const checks = await runDoctor({ env: {}, run: okRunner, nodeVersion: '18.0.0' });
    expect(statusOf(checks, 'Node')).toBe('FAIL');
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

  it('returns zero when everything passes or is skipped', async () => {
    const code = await doctorAction(
      { noColor: true },
      { env: { BHARATCODE_API_KEY: KEY }, run: okRunner, nodeVersion: '24.0.0' },
      () => {},
    );
    expect(code).toBe(0);
  });
});

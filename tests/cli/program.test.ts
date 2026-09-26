import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { run, buildProgram } from '../../src/cli/program.js';
import { VERSION } from '../../src/version.js';
import { defaultRunStoreRoot } from '../../src/state/run-store.js';
import type { Runner } from '../../src/cli/doctor.js';
import { memoryRunStore } from '../helpers/github.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture(): { lines: string[]; write: (l: string) => void; out: () => string } {
  const lines: string[] = [];
  return {
    lines,
    write: (l: string) => lines.push(l),
    out: () => lines.join('\n'),
  };
}

const okRunner: Runner = async (file, args) => {
  if (file === 'git') return { code: 0, stdout: 'git version 2.55.0', stderr: '' };
  if (file === 'gh' && args[0] === 'auth') return { code: 0, stdout: 'ok', stderr: '' };
  if (file === 'gh') return { code: 0, stdout: 'gh version 2.96', stderr: '' };
  return { code: 1, stdout: '', stderr: '' };
};

describe('mergesutra CLI', () => {
  it('--help exits 0 and shows usage', async () => {
    const c = capture();
    const code = await run(['node', 'mergesutra', '--help'], { write: c.write, writeErr: c.write });
    expect(code).toBe(0);
    expect(c.out()).toContain('mergesutra');
    expect(c.out()).toContain('doctor');
  });

  it('--version prints the version and exits 0', async () => {
    const c = capture();
    const code = await run(['node', 'mergesutra', '--version'], { write: c.write });
    expect(code).toBe(0);
    expect(c.out()).toContain(VERSION);
  });

  it('exposes a program object with the expected commands', () => {
    const program = buildProgram({});
    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain('doctor');
    expect(names).toContain('issue');
    expect(names).toContain('pr');
  });

  it('a planned command says so truthfully and exits non-zero', async () => {
    const c = capture();
    const code = await run(['node', 'mergesutra', 'pr'], {
      write: c.write,
      env: { NO_COLOR: '1' },
    });
    expect(code).toBe(2);
    expect(c.out()).toContain('planned');
    expect(c.out()).toContain('Currently working commands:');
    expect(c.out()).toContain('issue (intake)');
  });

  it('does not pretend a later stage ran: no planned command exits 0', async () => {
    for (const name of ['run', 'pr', 'status', 'resume']) {
      const c = capture();
      const code = await run(['node', 'mergesutra', name], {
        write: c.write,
        env: { NO_COLOR: '1' },
      });
      expect(code, name).toBe(2);
    }
  });

  it('has stopped treating `report` as planned, and writes nothing without a run', async () => {
    const c = capture();
    const err = capture();
    const cwd = await mkdtemp(path.join(tmpdir(), 'mergesutra-planned-'));
    tempDirs.push(cwd);

    const code = await run(['node', 'mergesutra', 'report'], {
      write: c.write,
      writeErr: err.write,
      env: { NO_COLOR: '1' },
      report: { store: memoryRunStore(), cwd },
    });

    expect(code).not.toBe(2);
    expect(c.out()).not.toContain('is planned, not yet implemented');
    expect(code).not.toBe(0);
    expect(err.out()).toMatch(/nothing to report|no run/i);
    // A report that failed to find a run must not leave a directory behind that
    // a later reader could mistake for a pack.
    const listed = await readdir(defaultRunStoreRoot(cwd)).catch(() => null);
    expect(listed ?? []).toEqual([]);
  });

  it('has stopped treating `verify` as planned, without making it succeed', async () => {
    const c = capture();
    const err = capture();
    const code = await run(['node', 'mergesutra', 'verify'], {
      write: c.write,
      writeErr: err.write,
      env: { NO_COLOR: '1' },
    });
    expect(code).not.toBe(2);
    expect(c.out()).not.toContain('is planned, not yet implemented');
    // With no run record to point at, it fails as a stage would, not as a stub.
    expect(code).not.toBe(0);
    expect(err.out()).toMatch(/[Rr]un/);
  });

  it('stops treating `plan` as a planned command, without making it succeed', async () => {
    const c = capture();
    const code = await run(['node', 'mergesutra', 'plan'], {
      write: c.write,
      env: { NO_COLOR: '1' },
    });
    expect(code).not.toBe(2);
    expect(c.out()).not.toContain('is planned, not yet implemented');
    expect(code).not.toBe(0);
  });

  it('contract with nothing to build on fails instead of inventing criteria', async () => {
    const out = capture();
    const err = capture();
    const code = await run(['node', 'mergesutra', 'contract'], {
      write: out.write,
      writeErr: err.write,
      env: { NO_COLOR: '1' },
      contract: { store: memoryRunStore() },
    });
    expect(code).not.toBe(0);
    expect(out.out()).not.toContain('CONTRACT_DERIVED');
    expect(err.out()).toContain('No run records exist yet.');
    expect(err.out()).toContain('mergesutra issue <url>');
  });

  it('doctor command runs with injected environment', async () => {
    const c = capture();
    const code = await run(['node', 'mergesutra', 'doctor'], {
      write: c.write,
      doctor: {
        env: { BHARATCODE_API_KEY: 'sk-cli-SECRET-1234567' },
        run: okRunner,
        nodeVersion: '24.0.0',
      },
    });
    expect(code).toBe(0);
    expect(c.out()).toContain('MergeSutra doctor');
    expect(c.out()).not.toContain('sk-cli-SECRET-1234567');
  });
});

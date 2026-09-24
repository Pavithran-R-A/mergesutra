import { describe, it, expect } from 'vitest';
import { run, buildProgram } from '../../src/cli/program.js';
import { VERSION } from '../../src/version.js';
import type { Runner } from '../../src/cli/doctor.js';
import { memoryRunStore } from '../helpers/github.js';

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
    expect(c.out()).toContain('issue (intake only)');
  });

  it('does not pretend a later stage ran: no planned command exits 0', async () => {
    for (const name of ['plan', 'run', 'verify', 'review', 'report', 'pr', 'status', 'resume']) {
      const c = capture();
      const code = await run(['node', 'mergesutra', name], {
        write: c.write,
        env: { NO_COLOR: '1' },
      });
      expect(code, name).toBe(2);
    }
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

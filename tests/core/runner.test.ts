import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { createRunner, defaultRunner, safeRun, type Runner } from '../../src/core/runner.js';

/**
 * These tests spawn the *current Node binary* with `-e`. That is the only way
 * to prove the security property this module exists for: arguments reach the
 * child process as literal argv values, never as shell syntax.
 */

const NODE = process.execPath;
const ECHO_ARGV = 'process.stdout.write(process.argv.slice(1).join("|"))';

/**
 * Set an environment variable for one test, then put it back exactly.
 *
 * The point is to have a genuinely live variable in `process.env` while a real
 * child is started, because the claim under test is about *inheritance* — and an
 * injected fake env would test the option, not the default.
 */
async function withEnv<T>(name: string, value: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** Reads one variable out of the child's own environment, or says it wasn't there. */
const readEnv = (name: string): string => `process.stdout.write(process.env.${name} ?? "ABSENT")`;

const SENTINEL = 'MERGESUTRA-TEST-CREDENTIAL-4f9c1a7b';

const createdDirs: string[] = [];

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-runner-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(async () => {
  // A test that leaves its scratch directory behind is not hostile-proof, it is
  // just noisy — so remove them whether or not the assertions passed.
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('createRunner', () => {
  it('captures stdout, stderr and a zero exit code', async () => {
    const result = await createRunner()(NODE, ['-e', 'console.log("hi")']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.stderr).toBe('');
  });

  it('reports a non-zero exit code instead of throwing', async () => {
    const result = await createRunner()(NODE, ['-e', 'console.error("boom"); process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('passes hostile values through as literal arguments, never as shell syntax', async () => {
    const dir = await emptyDir();
    const result = await createRunner({ cwd: dir })(NODE, [
      '-e',
      ECHO_ARGV,
      'rm -rf /',
      'a && echo PWNED',
      ';touch pwned.txt',
      '|ls',
      '>pwned2.txt',
      '$(whoami)',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      'rm -rf /|a && echo PWNED|;touch pwned.txt||ls|>pwned2.txt|$(whoami)',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('bounds runaway output instead of buffering it forever', async () => {
    const result = await createRunner({ maxOutputBytes: 1024 })(NODE, [
      '-e',
      'process.stdout.write("x".repeat(200000))',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/output exceeded 1024 bytes/);
    // A receipt has to say *why* a command ended without reading its stderr like
    // prose, so the reason is a fact on the result and not a substring.
    expect(result.truncated).toBe(true);
    expect(result.timedOut).not.toBe(true);
  });

  it('bounds a hanging command instead of waiting for it', async () => {
    const start = Date.now();
    const result = await createRunner({ timeoutMs: 400 })(NODE, [
      '-e',
      'setTimeout(() => process.exit(0), 30000)',
    ]);
    expect(Date.now() - start).toBeLessThan(20_000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/timed out after 400ms/);
    expect(result.timedOut).toBe(true);
    expect(result.truncated).not.toBe(true);
  });

  it('says so when a command finished on its own two feet', async () => {
    const result = await createRunner()(NODE, ['-e', 'process.exit(3)']);

    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('turns a missing executable into a failed result, not an unhandled rejection', async () => {
    const result = await createRunner()('definitely-not-a-real-program-mergesutra', ['--version']);
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).toContain('definitely-not-a-real-program-mergesutra');
    expect(result.stderr).not.toContain('\n');
  });

  it('collapses a failed command to its first stderr line so a check stays readable', async () => {
    const result = await createRunner()(NODE, [
      '-e',
      'console.error("first\\nsecond\\nthird"); process.exit(1)',
    ]);
    expect(result.stderr).toBe('first');
  });

  it('keeps the default runner inside the documented limits', async () => {
    const result = await defaultRunner(NODE, ['-e', ECHO_ARGV, 'plain']);
    expect(result.stdout).toBe('plain');
  });
});

describe('the environment a started command receives', () => {
  it('does not hand the model credential to a command that prints its own environment', async () => {
    await withEnv('BHARATCODE_API_KEY', SENTINEL, async () => {
      const result = await createRunner()(NODE, ['-e', readEnv('BHARATCODE_API_KEY')]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('ABSENT');
      expect(result.stdout).not.toContain(SENTINEL);
      // The scrub is of the copy handed to the child, never of this process: a
      // version that deleted the key from `process.env` would stop the adapter
      // from being able to speak to the model at all.
      expect(process.env.BHARATCODE_API_KEY).toBe(SENTINEL);
    });
  });

  it('scrubs the credential from an environment a caller supplied, not only the inherited one', async () => {
    // The invariant has to hold of the object this function is *given*, because a
    // stage that assembles its own env would otherwise be a second door.
    const result = await createRunner({
      env: { BHARATCODE_API_KEY: SENTINEL, bharatcode_api_key: SENTINEL },
    })(NODE, ['-e', readEnv('BHARATCODE_API_KEY')]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ABSENT');
  });

  it('keeps the credential out of the environment a bare default runner hands on', async () => {
    await withEnv('BHARATCODE_API_KEY', SENTINEL, async () => {
      const result = await defaultRunner(NODE, ['-e', readEnv('BHARATCODE_API_KEY')]);

      expect(result.stdout).toBe('ABSENT');
    });
  });

  it('still passes the token the GitHub read transport authenticates from', async () => {
    // Deliberate scope, pinned so a later over-broad scrub cannot quietly break
    // `mergesutra issue` for everyone who authenticates through the environment:
    // `gh` is MergeSutra's read transport and it reads its own credential from
    // here, so stripping it would refuse the product's first command.
    await withEnv('GH_TOKEN', SENTINEL, async () => {
      const result = await createRunner()(NODE, ['-e', readEnv('GH_TOKEN')]);

      expect(result.stdout).toBe(SENTINEL);
    });
  });

  it('still passes PATH, so a program named without a path is still found', async () => {
    const result = await createRunner()(NODE, [
      '-e',
      'process.stdout.write(String(process.env.PATH ?? process.env.Path ?? ""))',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('still passes the ordinary variables a repository build depends on', async () => {
    await withEnv('MERGESUTRA_ORDINARY_BUILD_VAR', 'keep-me', async () => {
      const result = await createRunner()(NODE, ['-e', readEnv('MERGESUTRA_ORDINARY_BUILD_VAR')]);

      expect(result.stdout).toBe('keep-me');
    });
  });
});

describe('safeRun', () => {
  it('returns the result when the command runs', async () => {
    const result = await safeRun(defaultRunner, NODE, ['-e', 'console.log(1)']);
    expect(result?.stdout.trim()).toBe('1');
  });

  it('returns null when the runner itself explodes', async () => {
    const exploding: Runner = async () => {
      throw new Error('spawn blew up');
    };
    expect(await safeRun(exploding, 'anything', [])).toBeNull();
  });
});

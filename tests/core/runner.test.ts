import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { createRunner, defaultRunner, safeRun, type Runner } from '../../src/core/runner.js';

/**
 * These tests spawn the *current Node binary* with `-e`. That is the only way
 * to prove the security property this module exists for: arguments reach the
 * child process as literal argv values, never as shell syntax.
 */

const NODE = process.execPath;
const ECHO_ARGV = 'process.stdout.write(process.argv.slice(1).join("|"))';

async function emptyDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mergesutra-runner-'));
}

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

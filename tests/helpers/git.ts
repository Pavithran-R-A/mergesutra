import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { defaultRunner } from '../../src/core/runner.js';
import { makeFixtureTree, NODE_REPO_FILES } from './fixture.js';

/**
 * Repositories that really are Git, for the tests that refuse to pretend.
 *
 * Most of the suite answers `git` with a script, because a fixture that depends
 * on the machine's git is a fixture that fails differently on every laptop. The
 * few tests here are the ones whose whole claim is about real Git — that a
 * worktree can be created at a commit, and that the checkout survives it — so
 * they get a real one, and skip themselves when this machine has no git at all.
 */

export async function hasGit(): Promise<boolean> {
  const result = await defaultRunner('git', ['--version']).catch(() => null);
  return result?.code === 0;
}

/**
 * A committed throwaway repository holding exactly these files.
 *
 * The `core.hooksPath` and `core.autocrlf` steps are not project setup, they are
 * test-honesty steps: an operator's machine may carry a global `core.hooksPath`
 * pointing at tooling that is not installed here, and a fixture that runs it pays
 * several seconds per commit and starts failing on a timeout instead of on an
 * assertion. A global `core.autocrlf` would rewrite the line endings of every
 * checkout, so a later stage's digest of a file would name bytes nobody wrote.
 * Both settings are written into *this temporary repository* — never the user's
 * config — and the directory the hooks name stays empty, so Git finds none to run.
 */
export async function initRepository(
  files: Record<string, string>,
): Promise<{ dir: string; base: string }> {
  const dir = await makeFixtureTree(files);
  const hooks = path.join(dir, '.no-hooks');
  await mkdir(hooks, { recursive: true });
  const steps: readonly (readonly string[])[] = [
    ['init', '-q'],
    ['config', 'user.name', 'MergeSutra Test'],
    ['config', 'user.email', 'test@mergesutra.invalid'],
    ['config', 'core.hooksPath', hooks],
    ['config', 'core.autocrlf', 'false'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'base'],
  ];
  for (const args of steps) {
    const result = await defaultRunner('git', ['-C', dir, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  const head = await headOf(dir);
  return { dir, base: head };
}

/**
 * A committed throwaway repository: a Node project with the gates a repository
 * contract reads, and `.mergesutra/` ignored so a workspace cannot dirty it.
 */
export async function realRepository(extra: Record<string, string> = {}): Promise<string> {
  const { dir } = await initRepository({
    ...NODE_REPO_FILES,
    '.gitignore': '.mergesutra/\nnode_modules/\n',
    'src/parse.ts':
      'export function parseDate(input: string): Date {\n  return new Date(input);\n}\n',
    ...extra,
  });
  return dir;
}

export async function headOf(directory: string): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD']);
  return result.code === 0 ? result.stdout.trim().toLowerCase() : '';
}

/** The checkout's own `git status`, so a test can prove it did not dirty anything. */
export async function statusOf(directory: string, ...args: string[]): Promise<string> {
  const result = await defaultRunner('git', ['-C', directory, 'status', '--porcelain', ...args]);
  return result.stdout;
}

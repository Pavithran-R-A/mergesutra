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
 * A committed throwaway repository: a Node project with the gates a repository
 * contract reads, and `.mergesutra/` ignored so a workspace cannot dirty it.
 */
export async function realRepository(extra: Record<string, string> = {}): Promise<string> {
  const repo = await makeFixtureTree({
    ...NODE_REPO_FILES,
    '.gitignore': '.mergesutra/\nnode_modules/\n',
    'src/parse.ts':
      'export function parseDate(input: string): Date {\n  return new Date(input);\n}\n',
    ...extra,
  });
  const steps: readonly (readonly string[])[] = [
    ['init', '-q'],
    ['config', 'user.name', 'MergeSutra Test'],
    ['config', 'user.email', 'test@mergesutra.invalid'],
    ['add', '.'],
    ['commit', '-q', '-m', 'base'],
  ];
  for (const args of steps) {
    const result = await defaultRunner('git', ['-C', repo, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return repo;
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

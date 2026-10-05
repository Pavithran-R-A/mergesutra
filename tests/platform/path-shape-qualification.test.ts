import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { createRunner, githubReadRunner } from '../../src/core/runner.js';
import { runIntake } from '../../src/intake/intake.js';
import { inspectLocalRepository } from '../../src/intake/local-repo.js';
import { memoryRunStore } from '../helpers/github.js';

const scratch: string[] = [];

async function realRepositoryWithSpaces(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'Merge Sutra path shape '));
  scratch.push(root);
  const repo = path.join(root, 'repo with spaces');
  await mkdir(repo, { recursive: true });

  const run = createRunner({ cwd: repo });
  for (const [file, args] of [
    ['git', ['init', '-b', 'main']],
    ['git', ['config', 'user.name', 'MergeSutra Test']],
    ['git', ['config', 'user.email', 'mergesutra@example.invalid']],
  ] as const) {
    const result = await run(file, args);
    expect(result.code, result.stderr).toBe(0);
  }

  await writeFile(path.join(repo, 'README.md'), '# path shape\n', 'utf8');
  expect((await run('git', ['add', 'README.md'])).code).toBe(0);
  expect((await run('git', ['commit', '-m', 'fixture'])).code).toBe(0);
  expect(
    (await run('git', ['remote', 'add', 'origin', 'https://github.com/example/path-shape.git']))
      .code,
  ).toBe(0);
  expect((await run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'])).code).toBe(0);
  expect(
    (
      await run('git', [
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      ])
    ).code,
  ).toBe(0);

  return repo;
}

async function withHome<T>(
  name: 'HOME' | 'USERPROFILE',
  value: string,
  body: () => Promise<T>,
): Promise<T> {
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  if (name === 'HOME') {
    process.env.HOME = value;
    delete process.env.USERPROFILE;
  } else {
    delete process.env.HOME;
    process.env.USERPROFILE = value;
  }
  try {
    return await body();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
  }
}

afterAll(async () => {
  for (const dir of scratch.splice(0, scratch.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('host path-shape qualification', () => {
  it('discovers real Git through PATH inside a temp repository whose path contains spaces', async () => {
    const repo = await realRepositoryWithSpaces();
    const snapshot = await inspectLocalRepository(repo);

    expect(snapshot.toplevel).toContain('repo with spaces');
    expect(snapshot.gitVersion).toMatch(/^git version /);
    expect(snapshot.branch).toBe('main');
    expect(snapshot.defaultBranch).toBe('main');
    expect(path.relative(tmpdir(), snapshot.toplevel)).not.toMatch(/^\.\.[/\\\\]/);

    if (process.platform === 'win32') {
      expect(snapshot.toplevel).toMatch(/^[A-Za-z]:[\\\\/]/);
    }
  });

  it('accepts forward-slash spelling of the same Windows drive-letter repository', async (ctx) => {
    if (process.platform !== 'win32') ctx.skip();

    const repo = await realRepositoryWithSpaces();
    const forwardSlashed = repo.replaceAll('\\\\', '/');
    const snapshot = await inspectLocalRepository(forwardSlashed);

    expect(path.resolve(snapshot.toplevel)).toBe(path.resolve(repo));
  });

  it.each(['HOME', 'USERPROFILE'] as const)(
    'shortens a real repository path through %s even when the home path contains spaces',
    async (name) => {
      const repo = await realRepositoryWithSpaces();
      const snapshot = await inspectLocalRepository(repo);
      const home = path.dirname(snapshot.toplevel);

      const result = await withHome(name, home, () =>
        runIntake({ repoPath: repo }, { store: memoryRunStore() }),
      );
      const local = result.checks.find((check) => check.name === 'Local repository');

      expect(local?.status).toBe('PASS');
      expect(local?.detail).toMatch(/^~[/\\\\]repo with spaces @ /);
    },
  );

  const hosted = process.env.GITHUB_ACTIONS === 'true' ? it : it.skip;
  hosted('discovers the GitHub CLI on the same hosted runner without needing auth', async () => {
    const result = await githubReadRunner('gh', ['--version']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^gh version /);
  });
});

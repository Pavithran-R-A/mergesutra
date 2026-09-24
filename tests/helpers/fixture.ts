import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Scratch repositories for discovery tests.
 *
 * Discovery is entirely about reading a real directory tree, so the tests are
 * given a real one — inside the OS temp directory, created and removed by the
 * test process. `snapshotTree` exists so a test can prove that a read-only
 * module left the tree exactly as it found it.
 */

export async function makeFixtureTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-fixture-'));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}

/**
 * Whether this process may create symlinks. Windows needs developer mode or
 * elevation, so the link-defence tests report themselves as skipped rather than
 * passing without testing anything.
 */
export const CAN_SYMLINK: boolean = await (async () => {
  const probe = await mkdtemp(path.join(tmpdir(), 'mergesutra-linkprobe-'));
  try {
    await symlink(path.join(probe, 'target'), path.join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true }).catch(() => undefined);
  }
})();

export type LinkKind = 'file' | 'directory';

/**
 * Link `linkPath` to `target`. On Windows a directory target becomes a junction,
 * which resolves the same way and needs no elevation.
 */
export async function makeLink(target: string, linkPath: string, kind: LinkKind): Promise<boolean> {
  await mkdir(path.dirname(linkPath), { recursive: true });
  const type = kind === 'directory' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

/** Sorted, forward-slashed relative paths of every file under `dir`. */
export async function snapshotTree(dir: string, prefix = '.'): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix === '.' ? '' : prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === '.' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await snapshotTree(dir, relative)));
    else out.push(relative);
  }
  return out.sort();
}

/** A minimal but realistic Node repository with CI that enforces its checks. */
export const NODE_REPO_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'datekit',
      engines: { node: '>=22' },
      scripts: {
        check: 'npm run format:check && npm run lint && npm run typecheck && npm run test',
        'format:check': 'prettier --check .',
        lint: 'eslint .',
        typecheck: 'tsc -p tsconfig.json --noEmit',
        test: 'vitest run',
        build: 'tsc -p tsconfig.build.json',
      },
    },
    null,
    2,
  ),
  'package-lock.json': '{}\n',
  'CONTRIBUTING.md': '# Contributing\n\nRun `npm run check` before pushing.\n',
  '.github/workflows/ci.yml': [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  checks:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: npm ci',
    '      - run: npm run format:check',
    '      - run: |',
    '          npm run lint',
    '          npm run typecheck',
    '      - name: Test',
    '        run: npm test',
    '',
  ].join('\n'),
  CODEOWNERS: '# owners\n/src/** @datekit-core\ndocs/ @datekit-docs\n',
};

/**
 * The shape many real repositories actually have: CI runs one composite script
 * and every gate hides behind it. Reporting "nothing is required" here would
 * make the contract worthless, so this is the end-to-end case.
 */
export const COMPOSITE_REPO_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'datekit',
      scripts: {
        check: 'npm run format:check && npm run lint && npm run typecheck && npm test',
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        build: 'tsc -p tsconfig.build.json',
      },
    },
    null,
    2,
  ),
  'package-lock.json': '{}\n',
  '.github/workflows/ci.yml': [
    'name: ci',
    'on:',
    '  pull_request:',
    'jobs:',
    '  all:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: npm ci',
    '      - run: npm run check',
    '',
  ].join('\n'),
};

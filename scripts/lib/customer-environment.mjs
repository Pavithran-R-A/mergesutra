import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The customer's repository, built with real Git operations.
 *
 * Stage 17's subject is a person who clones a repository, puts their work in a
 * linked worktree (the layout that Stage 16 had to learn to survive), and runs
 * MergeSutra against that worktree. So this is not a synthesised directory: it is
 * a `git clone` of a real repository with real history, a `git worktree add` of a
 * real branch, and the base commit pinned to what the host advertised before the
 * clone started — because an intake that pins one commit and an inspection that
 * reads another are, correctly, two different repositories as far as the product
 * is concerned.
 *
 * The primary checkout is deliberately the *linked* worktree, and the parent clone
 * stays untouched, so every measurement below can prove which of the two moved.
 */

export const CUSTOMER_REPOSITORY_URL =
  'https://github.com/Pavithran-R-A/mergesutra-e2e-fixture.git';
export const CUSTOMER_ISSUE_URL =
  'https://github.com/Pavithran-R-A/mergesutra-e2e-fixture/issues/1';
export const CUSTOMER_BASE_SHA = '6f3a0adb17389b93fd76b95c21a1c9eb7b161998';
export const CUSTOMER_DEFAULT_BRANCH = 'main';
export const CUSTOMER_WORKTREE_BRANCH = 'issue-1';

/**
 * Every Git call this harness makes, with the operator's hook configuration
 * taken out of it.
 *
 * A machine that has `core.hooksPath` set globally to a tool this repository
 * does not use makes a real `git clone` and `git worktree add` fail for a reason
 * that has nothing to do with the customer's repository. The fix is not to skip
 * the hook — it is to name a hooks directory that does not exist, so Git finds
 * nothing to run and the checkout proceeds exactly as the customer's would have
 * on a clean machine.
 */
const HOOK_ISOLATION = ['-c', 'core.hooksPath='];

export function git(argv, cwd, { allowFailure = false } = {}) {
  const result = spawnSync('git', [...HOOK_ISOLATION, ...argv], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 120_000,
  });
  const record = {
    argv,
    exitCode: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (!allowFailure && record.exitCode !== 0) {
    throw new Error(
      `git ${argv.join(' ')} exited ${String(record.exitCode)}: ${firstLine(record.stderr || record.stdout)}`,
    );
  }
  return record;
}

function firstLine(text) {
  return (text || '').split(/\r?\n/)[0] ?? '';
}

/** Git prints POSIX separators; comparisons here must not depend on the shell's. */
export function normalizePath(text) {
  return String(text).trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * Clone the customer repository and turn the checkout the customer works in into
 * a linked worktree of a real branch at the pinned base commit.
 */
export async function buildCustomerEnvironment({ root, onFail }) {
  const parent = path.join(root, 'customer');
  const workspace = path.join(root, 'customer-wt');

  const advertised = git(
    ['ls-remote', '--exit-code', CUSTOMER_REPOSITORY_URL, `refs/heads/${CUSTOMER_DEFAULT_BRANCH}`],
    root,
    { allowFailure: true },
  );
  if (advertised.exitCode !== 0) {
    onFail('the customer repository is not readable; qualification cannot continue');
  }
  const advertisedSha = advertised.stdout.trim().split(/\s+/)[0] ?? '';
  if (advertisedSha !== CUSTOMER_BASE_SHA) {
    onFail(
      `the customer repository's default branch is at ${advertisedSha}, but the qualification is written against base ${CUSTOMER_BASE_SHA}`,
    );
  }

  git(
    [
      'clone',
      '--no-tags',
      '--single-branch',
      '--branch',
      CUSTOMER_DEFAULT_BRANCH,
      CUSTOMER_REPOSITORY_URL,
      parent,
    ],
    root,
  );
  const cloned = git(['rev-parse', 'HEAD'], parent);
  if (cloned.stdout.trim() !== CUSTOMER_BASE_SHA) {
    onFail('the customer clone is not at the pinned base commit');
  }

  git(
    ['worktree', 'add', '-b', CUSTOMER_WORKTREE_BRANCH, workspace, CUSTOMER_DEFAULT_BRANCH],
    parent,
  );

  const head = git(['rev-parse', 'HEAD'], workspace);
  const gitdirFile = await readFile(path.join(workspace, '.git'), 'utf8');
  if (!/^gitdir: /.test(gitdirFile)) {
    onFail('the primary checkout is not a linked worktree (its .git is not a gitdir pointer file)');
  }

  return {
    root,
    parent,
    workspace,
    baseSha: head.stdout.trim(),
    gitdirPointer: gitdirFile.trim(),
    history: git(['log', '--format=%H %s'], parent).stdout.trim().split(/\r?\n/),
  };
}

/** sha256 of every tracked file, by repository-relative path. */
export async function trackedSnapshot(workspace) {
  const listing = git(['ls-files', '-z'], workspace);
  const names = listing.stdout.split('\0').filter(Boolean).sort();
  const out = {};
  for (const name of names) {
    const bytes = await readFile(path.join(workspace, name));
    out[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

/**
 * Everything a customer would notice if it changed: contents, branch, HEAD,
 * dirty state, worktree registration, and the shared Git metadata directory.
 */
export async function customerState(environment) {
  const { parent, workspace } = environment;
  const [tracked, parentTracked] = await Promise.all([
    trackedSnapshot(workspace),
    trackedSnapshot(parent),
  ]);
  return {
    workspaceHead: git(['rev-parse', 'HEAD'], workspace).stdout.trim(),
    workspaceBranch: git(['branch', '--show-current'], workspace).stdout.trim(),
    workspaceStatus: git(['status', '--porcelain'], workspace).stdout,
    workspaceTracked: tracked,
    parentHead: git(['rev-parse', 'HEAD'], parent).stdout.trim(),
    parentStatus: git(['status', '--porcelain'], parent).stdout,
    parentTracked,
    worktrees: parseWorktrees(git(['worktree', 'list', '--porcelain'], parent).stdout),
    gitdirPointer: (await readFile(path.join(workspace, '.git'), 'utf8')).trim(),
  };
}

/** One `git worktree list --porcelain` entry, so registration can be compared per checkout. */
export function parseWorktrees(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = {
        path: normalizePath(line.slice('worktree '.length)),
        head: '',
        branch: '',
        flags: '',
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim();
    } else if (line.trim() !== '') {
      current.flags += `${line.trim()} `;
    }
  }
  return entries;
}

/**
 * The patch, measured by Git itself rather than taken from the product's word.
 *
 * Stage 7 records a patch identity it computed from the workspace; the only way
 * to know that identity describes the change a reviewer would actually see is to
 * compute a second one, from a different tool, over the same bytes.
 */
export function independentPatchIdentity(workspace, baseSha) {
  const diff = git(['diff', '--no-ext-diff', '--no-color', baseSha, '--'], workspace, {
    allowFailure: true,
  });
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], workspace);
  const names = untracked.stdout.split('\0').filter(Boolean).sort();
  const hasher = createHash('sha256');
  hasher.update(diff.stdout);
  hasher.update(`\n--- untracked ${String(names.length)}\n`);
  hasher.update(names.join('\n'));
  return {
    digest: hasher.digest('hex'),
    files: diffFiles(diff.stdout),
    // The patch as a *set of paths*: what Git says the change touches, from two
    // commands, with no hashing. This is what the product's own file list is
    // compared against — the two digests can never be compared, because they are
    // digests of different things, but the file set is the same fact either way.
    changed: [
      ...new Set([...diffFiles(diff.stdout), ...names.filter((name) => !isScratch(name))]),
    ].sort(),
    diffLines: diff.stdout.split(/\r?\n/).length,
  };
}

function diffFiles(text) {
  const out = [];
  for (const match of text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) {
    out.push(match[1]);
  }
  return out.sort();
}

/**
 * The product's patch identity, re-derived from the bytes on disk.
 *
 * `describePatch` (src/verify/patch.ts) documents its canonical form exactly:
 * sha256 over `mergesutra-patch/1`, `base <sha>`, then one line per file sorted
 * by path — `tracked|untracked CHANGE path content-sha`, with `absent` for a
 * deletion — where the file list is Git's `diff --name-status --no-renames
 * --no-ext-diff` for the base plus `ls-files --others --exclude-standard` minus
 * anything under `.mergesutra/`. Re-implementing that form here, in another
 * language and another process, is the only reading of a recorded identity that
 * proves it still describes the workspace: a digest the harness merely echoed
 * back would prove nothing.
 */
export function rederiveProductPatchIdentity(workspace, baseSha) {
  const tracked = git(
    ['diff', '--name-status', '--no-renames', '--no-ext-diff', '-z', baseSha],
    workspace,
    { allowFailure: true },
  );
  const fields = tracked.stdout
    .split('\0')
    .map((token) => token.trim())
    .filter(Boolean);
  const files = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = (fields[index] ?? '').charAt(0);
    files.push({
      tracked: true,
      change: letter === 'D' ? 'DELETED' : letter === 'A' ? 'ADDED' : 'MODIFIED',
      path: fields[index + 1],
    });
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], workspace);
  for (const name of untracked.stdout
    .split('\0')
    .map((token) => token.trim())
    .filter(Boolean)) {
    if (isScratch(name)) continue;
    files.push({ tracked: false, change: 'ADDED', path: name });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const lines = ['mergesutra-patch/1', `base ${baseSha}`];
  const digests = [];
  for (const file of files) {
    let content = 'absent';
    if (file.change !== 'DELETED') {
      content = createHash('sha256')
        .update(readFileSync(path.join(workspace, file.path)))
        .digest('hex');
    }
    digests.push(
      `${file.tracked ? 'tracked' : 'untracked'} ${file.change} ${file.path} ${content}`,
    );
  }
  lines.push(...digests);
  return {
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
    files: files.map((file) => file.path),
  };
}

function isScratch(name) {
  const normalised = String(name).replaceAll('\\', '/');
  return normalised.startsWith('.mergesutra/') || normalised.includes('/.mergesutra/');
}

/** Names of every file under `dir`, for the "nothing else moved" proof. */
export async function fileInventory(dir) {
  const found = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) found.push(path.relative(dir, full).replaceAll('\\', '/'));
    }
  }
  await visit(dir);
  return found.sort();
}

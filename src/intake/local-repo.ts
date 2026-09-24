import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import type { CommitRef, RepositoryContext, RepositoryIdentity } from '../github/types.js';

/**
 * Reading an existing local repository.
 *
 * Every command here is a read-only query. MergeSutra never writes to the
 * user's checkout during intake: no config changes, no fetch, no checkout, no
 * index touched. The point is to learn four things with provenance — which
 * repository this is, which commit is the base, whether it is dirty, and
 * whether it actually matches the issue the user asked about.
 *
 * Patching the wrong repository is the failure mode this exists to prevent.
 */

export interface LocalRepositorySnapshot {
  readonly requestedPath: string;
  readonly toplevel: string;
  readonly branch: string;
  readonly isDetachedHead: boolean;
  readonly head: CommitRef;
  readonly originUrl: string;
  readonly origin: RepositoryContext | null;
  readonly defaultBranch: string;
  readonly isDirty: boolean;
  readonly dirtyCount: number;
  /** Bounded sample so a report cannot be flooded by a giant status. */
  readonly dirtySample: readonly string[];
  readonly isLinkedWorktree: boolean;
  readonly gitVersion: string;
}

export interface InspectLocalRepositoryDeps {
  readonly run?: Runner;
}

const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_DIRTY_SAMPLE = 10;

function gitFailure(reason: string, output: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Local repository check failed: ${reason}.`,
    remediation: 'Point --repo at a directory inside a Git working tree you have already cloned.',
    details: { output: bound(output, 200) },
  });
}

export async function inspectLocalRepository(
  directory: string,
  deps: InspectLocalRepositoryDeps = {},
): Promise<LocalRepositorySnapshot> {
  const run = deps.run ?? defaultRunner;
  const requestedPath = path.resolve(directory);

  if (requestedPath.includes('\0')) {
    throw gitFailure('the path contains a NUL byte', '');
  }
  if (!existsSync(requestedPath)) {
    throw gitFailure(`no such directory: ${bound(requestedPath, 120)}`, '');
  }
  if (!statSync(requestedPath).isDirectory()) {
    throw gitFailure(`not a directory: ${bound(requestedPath, 120)}`, '');
  }

  const inside = await git(run, requestedPath, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const bare = await git(run, requestedPath, ['rev-parse', '--is-bare-repository']);
    if (bare.code === 0 && bare.stdout.trim() === 'true') {
      throw gitFailure('that repository is bare and has no working tree', bare.stderr);
    }
    throw gitFailure('not a Git working tree', inside.stderr || inside.stdout);
  }

  const [toplevel, head, branchRef, status, originRemote, originHead, commonDir, version] =
    await Promise.all([
      git(run, requestedPath, ['rev-parse', '--show-toplevel']),
      git(run, requestedPath, ['rev-parse', 'HEAD']),
      git(run, requestedPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(run, requestedPath, ['status', '--porcelain']),
      git(run, requestedPath, ['config', '--get', 'remote.origin.url']),
      git(run, requestedPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
      git(run, requestedPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(run, requestedPath, ['--version']),
    ]);

  const sha = head.stdout.trim();
  if (head.code !== 0 || !SHA_PATTERN.test(sha)) {
    throw gitFailure('the repository has no resolvable HEAD commit', head.stderr || head.stdout);
  }

  const dirtyLines =
    status.code === 0 ? status.stdout.split('\n').filter((l) => l.trim() !== '') : [];
  const toplevelPath = toplevel.code === 0 ? toplevel.stdout.trim() : requestedPath;
  const defaultBranch =
    originHead.code === 0 ? originHead.stdout.trim().replace(/^origin\//, '') : '';
  const branchName = branchRef.stdout.trim();

  return {
    requestedPath,
    toplevel: toplevelPath,
    branch: branchName === 'HEAD' ? '(detached)' : branchName || '(unknown)',
    isDetachedHead: branchName === 'HEAD',
    head: { sha, shortSha: sha.slice(0, 10), source: 'local-git' },
    originUrl: originRemote.code === 0 ? originRemote.stdout.trim() : '',
    origin: parseRepositoryUrl(originRemote.code === 0 ? originRemote.stdout.trim() : ''),
    defaultBranch,
    isDirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    dirtySample: dirtyLines.slice(0, MAX_DIRTY_SAMPLE).map((l) => bound(l, 120)),
    isLinkedWorktree:
      commonDir.code === 0 && !samePath(commonDir.stdout.trim(), path.join(toplevelPath, '.git')),
    gitVersion: firstLine(version.stdout) || 'unknown',
  };
}

function git(run: Runner, cwd: string, args: readonly string[]) {
  return run('git', ['-C', cwd, ...args]);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Recognise both remote forms.
 *
 * Accepts https/http/ssh/git scp-style URLs and nothing else; anything that
 * does not clearly identify `owner/repo` yields null rather than a guess.
 */
export function parseRepositoryUrl(rawUrl: string): RepositoryContext | null {
  const value = rawUrl.trim();
  if (value.length === 0 || value.includes('\0')) return null;

  const scpStyle = /^[^/@\s]+@([^:\s]+):(.+)$/.exec(value);
  if (scpStyle && !value.includes('://')) {
    const host = scpStyle[1]?.toLowerCase() ?? '';
    const repoPath = cleanRepoPath(scpStyle[2] ?? '');
    const parts = splitRepoPath(repoPath);
    return parts ? { host, owner: parts.owner, repo: parts.repo } : null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:' &&
    url.protocol !== 'ssh:' &&
    url.protocol !== 'git:'
  ) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = splitRepoPath(cleanRepoPath(decodeURIComponent(url.pathname).replace(/^\/+/, '')));
  return parts ? { host, owner: parts.owner, repo: parts.repo } : null;
}

function cleanRepoPath(value: string): string {
  let out = value.replace(/^\/+/, '').replace(/\/+$/, '');
  if (out.endsWith('.git')) out = out.slice(0, -4);
  return out;
}

function splitRepoPath(value: string): { owner: string; repo: string } | null {
  const segments = value.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2] ?? '';
  const repo = segments[segments.length - 1] ?? '';
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

/** True when the local clone is the same repository the issue belongs to. */
export function originMatches(snapshot: LocalRepositorySnapshot, ctx: RepositoryContext): boolean {
  if (!snapshot.origin) return false;
  return (
    snapshot.origin.owner.toLowerCase() === ctx.owner.toLowerCase() &&
    snapshot.origin.repo.toLowerCase() === ctx.repo.toLowerCase()
  );
}

/**
 * What the clone alone can prove about the repository.
 *
 * Fork/archived/private flags stay null: they are properties of the hosted
 * repository, and a local clone is not evidence about them.
 */
export function identityFromLocalSnapshot(
  snapshot: LocalRepositorySnapshot,
): RepositoryIdentity | null {
  if (!snapshot.origin || snapshot.defaultBranch.length === 0) return null;
  const { host, owner, repo } = snapshot.origin;
  return {
    host,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    defaultBranch: snapshot.defaultBranch,
    isFork: null,
    isArchived: null,
    isPrivate: null,
    htmlUrl: `https://${host}/${owner}/${repo}`,
    description: '',
    source: 'local-git',
  };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

function bound(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

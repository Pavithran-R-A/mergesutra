import path from 'node:path';
import { AppError } from '../core/errors.js';

/**
 * Path containment.
 *
 * Any path that arrives from outside MergeSutra — a repository-relative string,
 * a run identifier, a model suggestion — is resolved and then proved to sit
 * inside an authorized root before it is used.
 *
 * This is a containment check, not a sandbox: it judges strings, and a symlink
 * or Windows junction that *points* outside a root still reads as inside until
 * it is realpath'd. Stages that write into a workspace resolve links first;
 * see docs/SECURITY_MODEL.md.
 */

/** Case-insensitive on the platforms whose filesystems are case-insensitive. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function forCompare(value: string, caseInsensitive: boolean): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** True when `candidate` is `root` itself or lives beneath it. */
export function isInsideRoot(
  root: string,
  candidate: string,
  options: { readonly caseInsensitive?: boolean } = {},
): boolean {
  const caseInsensitive = options.caseInsensitive ?? isCaseInsensitivePlatform();
  const base = forCompare(root, caseInsensitive);
  const target = forCompare(candidate, caseInsensitive);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Resolve `candidate` against `root` and prove it stays inside.
 *
 * Absolute paths and `..` segments are refused outright rather than normalised
 * into whatever location they happen to resolve to; a caller that means a
 * different root has to say so explicitly.
 */
export function resolveInsideRoot(root: string, candidate: string, label = 'path'): string {
  if (candidate.length === 0) throw containmentError(label, 'was empty');
  if (candidate.includes('\0')) throw containmentError(label, 'contains a NUL byte');
  if (path.isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate) || candidate.startsWith('\\')) {
    throw containmentError(label, 'must be relative to the authorized root');
  }
  if (candidate.split(/[\\/]+/).includes('..')) {
    throw containmentError(label, 'contains a parent traversal segment');
  }
  const resolved = path.resolve(root, candidate);
  if (!isInsideRoot(root, resolved)) {
    throw containmentError(label, 'resolves outside the authorized root');
  }
  return resolved;
}

/**
 * True when any segment is exactly `.git`.
 *
 * Both the tool policy and the writer refuse these paths. In a linked worktree
 * `.git` is a *file* that points at the real admin directory, so a write that
 * looks like it stays inside the workspace can still land in the repository's
 * guts — the name is what to look for, not the shape of the target. Compared
 * case-insensitively because Windows filenames are.
 */
export function hasGitSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git');
}

function containmentError(label: string, reason: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Refusing to use ${label}: ${reason}.`,
    remediation: 'Keep every MergeSutra path inside the workspace or run directory it belongs to.',
    details: { label, reason },
  });
}

/** A value safe to become a single file-name segment (run IDs, evidence keys). */
export function isSafePathSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) && !value.includes('..');
}

export function assertSafePathSegment(value: string, label = 'identifier'): string {
  if (!isSafePathSegment(value)) {
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use ${label} as a file name: ${JSON.stringify(value)}.`,
      remediation: `Supply a ${label} of 1-80 characters from [A-Za-z0-9._-], starting with a letter or digit.`,
      details: { label },
    });
  }
  return value;
}

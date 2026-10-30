import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { isInsideRoot, resolveInsideRoot } from './path-safety.js';

/**
 * Realpath the deepest existing ancestor and re-attach the rest.
 *
 * `realpath` fails on a path that does not exist yet, and both halves of Stage 6
 * ask about files that may not be there: a plan writes into a directory that has
 * not been created, and a read may name a file the repository never had. Walking
 * up until something resolves is enough to judge where a symlink or a Windows
 * junction along the way would lead — a link three directories above the target
 * cannot hide — without inventing a destination for a leaf that does not exist.
 */
export async function resolveExistingAncestor(absolute: string): Promise<string> {
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export interface ConfinedFile {
  readonly absolute: string;
  readonly size: number;
  readonly mode: number;
}

/**
 * A file the host may read only if every link on the way stays inside the root.
 *
 * The lexical check in `resolveInsideRoot` judges the name; it cannot see that a
 * directory named in the middle of the path is a symlink or junction pointing at
 * a home directory. A gate runs with the workspace mounted writable, so it can
 * leave such a link behind — and a host-side read that followed it would put a
 * file the run never owned into a review prompt or an upload. Both ends are
 * realpath'd and compared, the leaf must be a regular file rather than a link,
 * and a missing file is either a refusal or, for callers that are describing a
 * deletion, `null`.
 */
export async function resolveConfinedFile(
  root: string,
  relativePath: string,
  label: string,
  options: { readonly allowMissing?: boolean } = {},
): Promise<ConfinedFile | null> {
  const absolute = resolveInsideRoot(root, relativePath, label);
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) {
    throw refusal(label, 'the authorized root cannot be resolved');
  }
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    if (options.allowMissing === true) return null;
    throw refusal(label, 'the file does not exist');
  }
  if (!isInsideRoot(realRoot, real)) {
    throw refusal(label, 'a link or junction on the way resolves outside the workspace');
  }
  const facts = await lstat(absolute).catch(() => null);
  if (facts === null) {
    if (options.allowMissing === true) return null;
    throw refusal(label, 'the file does not exist');
  }
  if (facts.isSymbolicLink()) {
    throw refusal(label, 'the path is a symbolic link');
  }
  if (!facts.isFile()) {
    throw refusal(label, 'the path is not a regular file');
  }
  // Return the resolved path, not the spelling: a caller that read `absolute`
  // would reopen the name and follow whatever a later swap put there.
  return { absolute: real, size: facts.size, mode: facts.mode };
}

function refusal(label: string, reason: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Refusing to read ${label}: ${reason}.`,
    remediation:
      'Keep every file a stage reads inside this run’s workspace, and replace links that point out of it with regular files.',
    details: { label, reason },
  });
}

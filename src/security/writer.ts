import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { hasGitSegment, isInsideRoot, resolveInsideRoot } from './path-safety.js';
import { resolveExistingAncestor } from './realpath.js';

/**
 * The only way MergeSutra puts bytes on disk in a workspace — Stage 5.
 *
 * Stage 2's reader is read-only by construction, which is a fine guarantee for
 * a tool that only looks. This is the other half: the one module allowed to
 * write, and the boundary that makes "confined to the workspace of this run"
 * true rather than intended.
 *
 * The rules, in the order they are applied:
 *
 * - the target must be a relative path with no `..`, no absolute prefix and no
 *   NUL byte — refused before anything is touched;
 * - no segment may be `.git`, in any spelling;
 * - every existing component of the path is resolved with `realpath`, and the
 *   result must still be inside the root. This is what catches a symlink or a
 *   Windows junction named `src` that points at a home directory — a lexical
 *   check sees a harmless relative path where the filesystem sees an escape;
 * - an existing target that is a symlink is refused even when it points inside,
 *   because writing through a link is the repository choosing the real
 *   destination;
 * - the text must be within the byte cap, and the write is atomic: a temp file
 *   in the same directory, then a rename. A crash mid-write leaves the old file
 *   or the new one, never half of either.
 *
 * There is deliberately no delete, rename or chmod here. The security model
 * calls those destructive, and a writer that cannot delete cannot be talked
 * into emptying a checkout.
 */

export const MAX_WRITE_BYTES = 1024 * 1024;

export interface WriteReceipt {
  readonly relativePath: string;
  readonly bytes: number;
  /** False when this replaced a file that was already there. */
  readonly created: boolean;
}

export interface ConfinedWriter {
  /** Link-resolved root; every write is proved against this. */
  readonly root: string;
  writeText(relativePath: string, text: string): Promise<WriteReceipt>;
  exists(relativePath: string): Promise<boolean>;
}

function refusal(relativePath: string, why: string, remediation?: string): AppError {
  return new AppError({
    kind: 'validation',
    message: `Refusing to write '${bound(relativePath)}': ${why}.`,
    remediation:
      remediation ??
      'Write only inside the workspace of this run, using repository-relative paths.',
    details: { path: bound(relativePath) },
  });
}

export async function openConfinedWriter(candidateRoot: string): Promise<ConfinedWriter> {
  if (candidateRoot.includes('\0')) {
    throw refusal(
      candidateRoot,
      'the authorized root contains a NUL byte',
      'Re-run with a clean path.',
    );
  }
  const requested = path.resolve(candidateRoot);
  const info = await stat(requested).catch(() => null);
  if (!info?.isDirectory()) {
    throw refusal(
      candidateRoot,
      'the authorized root is not an existing directory',
      'Create the workspace before writing to it.',
    );
  }
  const root = await realpath(requested);

  async function confine(relativePath: string): Promise<string> {
    const absolute = resolveInsideRoot(root, relativePath, `write target '${relativePath}'`);
    if (hasGitSegment(relativePath)) {
      throw refusal(relativePath, 'the path crosses .git');
    }
    const real = await resolveExistingAncestor(absolute);
    if (!isInsideRoot(root, real)) {
      throw refusal(relativePath, 'a link or directory on the way resolves outside the workspace');
    }
    return absolute;
  }

  return {
    root,

    async writeText(relativePath, text) {
      const absolute = await confine(relativePath);
      if (text.includes('\0')) throw refusal(relativePath, 'the content contains a NUL byte');
      const buffer = Buffer.from(text, 'utf8');
      if (buffer.byteLength > MAX_WRITE_BYTES) {
        throw refusal(
          relativePath,
          `${buffer.byteLength} bytes is over the ${MAX_WRITE_BYTES}-byte single-write cap`,
          'Split the change, or let the verification stage report that the file is too large.',
        );
      }

      const existing = await lstat(absolute).catch(notFound);
      if (existing?.isSymbolicLink()) {
        throw refusal(relativePath, 'the target is a symlink');
      }
      if (existing?.isDirectory()) {
        throw refusal(relativePath, 'the target is a directory');
      }

      await mkdir(path.dirname(absolute), { recursive: true });
      const temp = path.join(
        path.dirname(absolute),
        `.mergesutra-tmp-${process.pid}-${Date.now()}`,
      );
      try {
        const handle = await open(temp, 'wx', 0o644);
        try {
          await handle.writeFile(buffer);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await renameChecked(temp, absolute, relativePath);
      } catch (error) {
        await rmQuiet(temp);
        throw error;
      }

      return {
        relativePath: relativePath.replaceAll('\\', '/'),
        bytes: buffer.byteLength,
        created: existing === null,
      };
    },

    async exists(relativePath) {
      try {
        const absolute = await confine(relativePath);
        const info = await lstat(absolute).catch(() => null);
        return info !== null && !info.isSymbolicLink() && info.isFile();
      } catch {
        return false;
      }
    },
  };
}

async function renameChecked(from: string, to: string, relativePath: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    throw refusal(relativePath, error instanceof Error ? error.message : 'the rename failed');
  }
}

async function rmQuiet(target: string): Promise<void> {
  await rm(target, { force: true }).catch(() => undefined);
}

function notFound(): null {
  return null;
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 100 ? oneLine : `${oneLine.slice(0, 97)}...`;
}

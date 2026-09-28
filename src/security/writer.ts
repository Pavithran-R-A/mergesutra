import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { hasGitSegment, isInsideRoot, resolveInsideRoot } from './path-safety.js';
import { resolveExistingAncestor } from './realpath.js';
import { sha256Hex } from './digest.js';

/**
 * The only way MergeSutra puts bytes on disk in a workspace — Stage 5, with
 * Stage 7's compare-before-write rule.
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
 * Then the rule Stage 7 added, which is why `writeText` has a third argument:
 *
 * - a write carries a **precondition** about the version being replaced — the
 *   digest of the bytes the caller was shown, or `expectedAbsent` for a file the
 *   caller believes is new. Immediately before the rename the writer reads the
 *   disk itself and proves the precondition still holds; if it does not, nothing
 *   is replaced and the failure is `STALE_FILE`;
 * - and the same last moment re-proves the *way* — the ancestor resolution above
 *   is run again before the rename, because the steps in between take time and a
 *   directory that was real when the write was planned can be replaced by a link
 *   while it proceeds.
 *
 * This is optimistic concurrency, not a filesystem transaction. The window
 * between that final check and the rename cannot be closed from user space, and
 * pretending otherwise would be the same overclaim the check exists to remove.
 * What it does buy is the guarantee that matters here: a caller cannot replace a
 * file it never observed, and a caller cannot overwrite a change that landed
 * after it looked.
 *
 * There is deliberately no delete, rename or chmod here, and no `force` on a
 * precondition. The security model calls those destructive, and a writer that
 * cannot delete cannot be talked into emptying a checkout — a writer whose
 * precondition can be waved past is a writer that overwrites unseen work.
 */

export const MAX_WRITE_BYTES = 1024 * 1024;

/** Machine-readable conflict code, so a caller can tell stale from refused. */
export const STALE_FILE = 'STALE_FILE';

/**
 * What the caller believes about the bytes already there.
 *
 * A structural union rather than an options bag: there is no field to add later
 * that would make "we did not look" expressible.
 */
export type WritePrecondition =
  { readonly expectedSha256: string } | { readonly expectedAbsent: true };

export interface WriteReceipt {
  readonly relativePath: string;
  readonly bytes: number;
  /** False when this replaced a file that was already there. */
  readonly created: boolean;
  /** Digest of the bytes now on disk, hashed from what was written. */
  readonly contentSha256: string;
}

export interface ConfinedWriter {
  /** Link-resolved root; every write is proved against this. */
  readonly root: string;
  writeText(
    relativePath: string,
    text: string,
    precondition: WritePrecondition,
  ): Promise<WriteReceipt>;
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

    async writeText(relativePath, text, precondition) {
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
        // The proof happens here, after the bytes are safe on disk and before the
        // one operation that replaces anything. Everything above is reversible.
        //
        // The way is proved again, not just the bytes. The check at the top of this
        // function judged a directory that may no longer exist: a temp file was
        // written, synced and read back since, and an ancestor that was a plain
        // directory then can be a link now. Proving it a second time here narrows
        // the window to the microseconds before the rename; it does not close it,
        // and docs/SECURITY_MODEL.md says so rather than this comment implying the
        // check is a transaction.
        await confine(relativePath);
        await verifyPrecondition(absolute, relativePath, precondition);
        await renameChecked(temp, absolute, relativePath);
      } catch (error) {
        await rmQuiet(temp);
        throw error;
      }

      return {
        relativePath: relativePath.replaceAll('\\', '/'),
        bytes: buffer.byteLength,
        created: existing === null,
        contentSha256: sha256Hex(buffer),
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

/**
 * Prove the caller's account of the current bytes against the disk, now.
 *
 * The digest is deliberately not echoed back on failure. A refusal that carried
 * the new digest would let a caller satisfy the precondition without ever
 * reading the file it is about to overwrite, which is the exact gap this closes.
 */
async function verifyPrecondition(
  absolute: string,
  relativePath: string,
  precondition: WritePrecondition,
): Promise<void> {
  const current = await lstat(absolute).catch(notFound);

  if ('expectedAbsent' in precondition) {
    if (current !== null) {
      throw stale(
        relativePath,
        'a file exists at this path, so it was not absent when it was last observed',
      );
    }
    return;
  }

  if (current === null) {
    throw stale(
      relativePath,
      'there is no file at this path, so the digest this write was based on matches nothing',
    );
  }
  if (!current.isFile()) {
    throw stale(relativePath, 'what exists at this path is not a regular file');
  }
  if (current.size > MAX_WRITE_BYTES) {
    throw refusal(
      relativePath,
      `the file on disk is ${current.size} bytes, over the ${MAX_WRITE_BYTES}-byte size MergeSutra can read back and replace`,
      'A file too large to hand over whole is too large to replace whole; report it instead.',
    );
  }
  const onDisk = await readFile(absolute);
  if (sha256Hex(onDisk) !== precondition.expectedSha256) {
    throw stale(
      relativePath,
      'the bytes on disk are no longer the version this write was based on',
    );
  }
}

function stale(relativePath: string, why: string): AppError {
  return new AppError({
    kind: 'validation',
    message:
      `Refusing to write '${bound(relativePath)}': ${STALE_FILE} — ${why}. ` +
      'Nothing was replaced. Read the file again and use the digest from that read.',
    remediation:
      'Re-read the file, then send the write again based on what is there now. There is no way to force a stale write.',
    details: { code: STALE_FILE, path: bound(relativePath) },
  });
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

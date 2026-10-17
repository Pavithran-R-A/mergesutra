import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isInsideRoot, isSamePath } from '../security/path-safety.js';

/**
 * Which Git directory MergeSutra may trust when it measures a run workspace.
 *
 * Stage 5 gives every run a *linked* worktree, and Git stores a linked worktree's
 * metadata in the primary repository: the workspace's `.git` is a one-line pointer
 * file, and the admin directory holding its `HEAD` and index lives outside the
 * workspace. That layout is what this module turns into a security property. A run
 * executes repository-controlled commands with the workspace mounted read-write,
 * so anything inside that workspace — including its `.git` entry — is writable by
 * the run. If MergeSutra measured the patch by asking Git to *discover* the
 * repository from the workspace, Git would read whatever configuration was planted
 * there, and Git configuration can name programs to run (`core.fsmonitor`,
 * `core.hooksPath`, `diff.<driver>.textconv`, a `remote.<name>.url` using
 * `ext::`). A gate that only did `mkdir .git` would then get its chosen program
 * executed by MergeSutra's own trusted read, outside the sandbox, or get a
 * forged-but-internally-consistent repository handed back as the run's patch.
 *
 * So the rule is structural rather than a deny-list: a workspace's Git directory
 * is trusted only when it is a pointer to a directory *outside* the workspace that
 * independently points back at it. The workspace's own metadata bytes are then
 * never consulted, and a planted `.git` changes nothing the run can either execute
 * or fool.
 *
 * A workspace whose `.git` is a real directory — a plain checkout — cannot meet
 * that rule, because its metadata sits inside the writable area. Callers must
 * treat `null` as "this workspace cannot be measured safely", not as an
 * invitation to fall back to discovery.
 */

export interface TrustedGitDir {
  /** The linked worktree's own admin directory, resolved, outside `workTree`. */
  readonly gitDir: string;
  /** The workspace it describes, resolved. */
  readonly workTree: string;
}

const POINTER = /^gitdir:[ \t]*(.+?)[ \t]*$/;

export async function resolveTrustedGitDir(workspace: string): Promise<TrustedGitDir | null> {
  let workTree: string;
  try {
    workTree = await realpath(workspace);
  } catch {
    return null;
  }

  const pointerPath = path.join(workTree, '.git');
  const status = await lstat(pointerPath).catch(() => null);
  // `lstat`, not `stat`: a symlink to a pointer file is still a link the run put
  // there, and a `.git` directory is metadata inside the writable area. `isFile()`
  // is false for both.
  if (!status?.isFile()) return null;

  const target = pointerTarget(await read(pointerPath), workTree);
  if (target === null) return null;
  const gitDir = await realpath(target).catch(() => null);
  if (gitDir === null || isInsideRoot(workTree, gitDir)) return null;

  // The admin directory has to belong to *this* worktree, so a pointer aimed at a
  // sibling run's metadata is refused instead of measured as if it were this run's.
  // Git writes that back-pointer itself when it creates the worktree, and the run
  // cannot forge one because the file lives outside the directory it may write in.
  const back = await read(path.join(gitDir, 'gitdir'));
  if (back === null || !isSamePath(await resolveAgainst(back, gitDir), pointerPath)) return null;

  return { gitDir, workTree };
}

function pointerTarget(contents: string | null, workTree: string): string | null {
  if (contents === null) return null;
  const first = (contents.split(/\r?\n/)[0] ?? '').trim();
  const raw = POINTER.exec(first)?.[1]?.trim();
  if (!raw || raw.includes('\0')) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(workTree, raw);
}

async function resolveAgainst(value: string, base: string): Promise<string> {
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(base, trimmed);
}

async function read(file: string): Promise<string | null> {
  return await readFile(file, 'utf8').catch(() => null);
}

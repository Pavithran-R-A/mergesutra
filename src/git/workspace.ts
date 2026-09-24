import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import { decideTool } from '../process/tool-policy.js';
import { assertSafePathSegment, isCaseInsensitivePlatform } from '../security/path-safety.js';

/**
 * Giving a run its own workspace — Stage 5.
 *
 * The rule this serves is in the product spec: never casually edit the user's
 * primary checkout. A run that changes files does it in a dedicated Git
 * worktree pinned to the exact base SHA the run recorded, so the human's own
 * working directory — with whatever they had half-finished in it — is not
 * touched, and so "what did MergeSutra change" has an unambiguous answer:
 * everything in this directory that is not in that commit.
 *
 * What this module does and does not do:
 *
 * - It writes exactly one thing: a new worktree under `.mergesutra/worktrees/`,
 *   inside the repository the run belongs to, which is where the user already
 *   agreed files could appear.
 * - It refuses to proceed if that directory is *not* git-ignored, because a
 *   workspace that shows up as untracked noise in `git status` is the one way
 *   this design could still damage the human's checkout.
 * - It detects a dirty primary checkout and reports it. It never stashes,
 *   cleans, resets or removes anything. A `worktree add` at a pinned SHA does
 *   not need the primary to be clean, so dirty state is a fact in the record
 *   rather than a blocker — silently throwing away someone's work is not an
 *   option MergeSutra gets to choose.
 * - It is idempotent: preparing the same run twice returns the same workspace,
 *   and a workspace that is not at the recorded base SHA is refused rather than
 *   reset.
 *
 * And the part the security model insists on: a worktree is isolation for
 * *clarity*, not a sandbox. Git shares one object database between every
 * worktree of a repository, and a process inside a worktree can still name an
 * absolute path elsewhere. The guarantee that writes stay inside the run is
 * `src/security/writer.ts`, and this module does not claim to replace it.
 */

export const WORKTREE_BASE_DIR = '.mergesutra/worktrees';
const BRANCH_PREFIX = 'mergesutra';
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_DIRTY_SAMPLE = 10;

export interface PrepareWorkspaceInput {
  /** Any directory inside the user's checkout. */
  readonly primaryRoot: string;
  /** The run's own id; becomes part of the directory and branch name. */
  readonly runId: string;
  /** The commit recorded by intake. The worktree is created at exactly this. */
  readonly baseSha: string;
}

export interface PreparedWorkspace {
  /** Absolute path of the workspace the run owns. */
  readonly path: string;
  /** Repository-relative, forward-slashed, as it appears in `git status`. */
  readonly relativePath: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly toplevel: string;
  /** True when an earlier attempt already created this exact workspace. */
  readonly reused: boolean;
  readonly primaryDirty: boolean;
  readonly dirtyCount: number;
  readonly dirtySample: readonly string[];
}

export interface PrepareWorkspaceDeps {
  readonly run?: Runner;
}

function refusal(reason: string, remediation: string, output = ''): AppError {
  return new AppError({
    kind: 'validation',
    message: `Cannot prepare a workspace: ${reason}.`,
    remediation,
    details: output.length > 0 ? { output: bound(output) } : undefined,
  });
}

export async function prepareWorkspace(
  input: PrepareWorkspaceInput,
  deps: PrepareWorkspaceDeps = {},
): Promise<PreparedWorkspace> {
  const run = deps.run ?? defaultRunner;
  const runId = assertSafePathSegment(input.runId, 'run id');
  const baseSha = input.baseSha.toLowerCase();
  if (!SHA_PATTERN.test(baseSha)) {
    throw refusal(
      `'${bound(input.baseSha)}' is not a full commit SHA`,
      'Run `mergesutra issue` or `mergesutra inspect` first, so the base commit is one MergeSutra read from the repository.',
    );
  }

  const primary = path.resolve(input.primaryRoot);
  if (primary.includes('\0')) {
    throw refusal('the repository path contains a NUL byte', 'Re-run with a normal path.');
  }

  const toplevel = await git(run, primary, ['rev-parse', '--show-toplevel']);
  if (toplevel.code !== 0 || toplevel.stdout.trim().length === 0) {
    throw refusal(
      `${bound(primary)} is not a Git working tree`,
      'Clone the repository first, or point --repo at a directory inside one.',
      toplevel.stderr,
    );
  }
  const root = toplevel.stdout.trim();

  const exists = await git(run, root, ['cat-file', '-t', baseSha]);
  if (exists.code !== 0 || exists.stdout.trim() !== 'commit') {
    throw refusal(
      `the base commit ${baseSha.slice(0, 12)} is not in this repository`,
      'Fetch the commit the run was created against, or re-run intake against the clone that has it.',
      exists.stderr,
    );
  }

  const relativePath = `${WORKTREE_BASE_DIR}/${runId}`;
  const workspace = path.join(root, '.mergesutra', 'worktrees', runId);
  const branch = `${BRANCH_PREFIX}/${runId}`;

  await requireIgnored(run, root, relativePath);
  const dirty = await dirtyState(run, root);

  const registered = await registeredWorktrees(run, root);
  if (registered.has(await comparable(workspace))) {
    const existing = await headAt(run, workspace);
    if (existing === baseSha) {
      return {
        path: await realOr(workspace),
        relativePath,
        branch,
        baseSha,
        toplevel: root,
        reused: true,
        ...dirty,
      };
    }
    throw refusal(
      `a workspace for run ${runId} exists but is at ${bound(existing ?? 'an unreadable commit')}, not the recorded base ${baseSha.slice(0, 12)}`,
      'Remove that worktree yourself if you are sure, then re-run.',
    );
  }
  if (existsSync(workspace)) {
    throw refusal(
      `${relativePath} is already a directory that Git does not know about`,
      'Move those files aside yourself — MergeSutra will not delete anything it did not create.',
    );
  }
  const takenBranch = await git(run, root, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  if (takenBranch.code === 0) {
    throw refusal(
      `the branch ${branch} already exists and is not attached to a workspace`,
      'Re-run with a different run id, or delete that branch yourself.',
    );
  }

  const addArgs = ['worktree', 'add', '-b', branch, workspace, baseSha];
  if (!creationIsAllowed(root, ['git', '-C', root, ...addArgs])) {
    throw refusal(
      'the tool policy does not allow this workspace to be created',
      'Report this as a bug: creating a worktree is a WRITE inside the repository the run was pointed at.',
    );
  }
  const created = await git(run, root, addArgs);
  if (created.code !== 0) {
    throw refusal(
      `git could not create the workspace (${created.code})`,
      'Check that this repository is not locked by another process, then re-run.',
      created.stderr || created.stdout,
    );
  }
  const at = await headAt(run, workspace);
  if (at !== baseSha) {
    throw refusal(
      `the workspace was created at ${bound(at ?? 'an unreadable commit')} instead of the base ${baseSha.slice(0, 12)}`,
      'Report this as a bug: a run must start from the commit its record names.',
    );
  }

  return {
    path: await realOr(workspace),
    relativePath,
    branch,
    baseSha,
    toplevel: root,
    reused: false,
    ...dirty,
  };
}

/**
 * The pre-flight that protects the user's checkout.
 *
 * `git check-ignore` exits 0 only when the path is actually ignored, so this is
 * Git's own answer to "will creating this directory dirty your status?". If it
 * is not ignored, the worktree would show up as thousands of untracked files
 * and the human's next commit could sweep them in — which is a worse outcome
 * than a refused run.
 */
async function requireIgnored(run: Runner, root: string, relativePath: string): Promise<void> {
  const check = await git(run, root, ['check-ignore', '--', relativePath]);
  if (check.code === 0) return;
  if (check.code !== 1) {
    throw refusal(
      'Git would not say whether the workspace directory is ignored',
      'Add `.mergesutra/` to .gitignore, then re-run.',
      check.stderr,
    );
  }
  throw refusal(
    `${relativePath} is not git-ignored, so creating it would leave untracked files in your checkout`,
    'Add `.mergesutra/` to the repository .gitignore — MergeSutra will not edit it for you.',
  );
}

async function dirtyState(
  run: Runner,
  root: string,
): Promise<{ primaryDirty: boolean; dirtyCount: number; dirtySample: readonly string[] }> {
  const status = await git(run, root, ['status', '--porcelain']);
  const lines = status.code === 0 ? status.stdout.split(/\r?\n/).filter((l) => l.length > 0) : [];
  return {
    primaryDirty: lines.length > 0,
    dirtyCount: lines.length,
    dirtySample: lines.slice(0, MAX_DIRTY_SAMPLE).map((line) => bound(line)),
  };
}

async function registeredWorktrees(run: Runner, root: string): Promise<Set<string>> {
  const list = await git(run, root, ['worktree', 'list', '--porcelain']);
  const found = new Set<string>();
  if (list.code !== 0) return found;
  for (const line of list.stdout.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    found.add(await comparable(line.slice('worktree '.length).trim()));
  }
  return found;
}

async function headAt(run: Runner, directory: string): Promise<string | null> {
  const head = await git(run, directory, ['rev-parse', '--verify', 'HEAD']);
  const sha = head.stdout.trim().toLowerCase();
  return head.code === 0 && SHA_PATTERN.test(sha) ? sha : null;
}

/**
 * The workspace's real path, so a later stage compares one spelling of it.
 *
 * Falls back to the path Git was given if nothing resolves — a scripted test
 * runner describes a worktree that is not on this disk.
 */
async function realOr(value: string): Promise<string> {
  return realpath(value).catch(() => value);
}

/**
 * A path ready to be compared with one Git printed.
 *
 * Git echoes back the spelling it was given, and on Windows one directory has
 * at least two spellings — its long name and an 8.3 short one. Realpathing both
 * sides is what stops an existing workspace looking like an unknown directory,
 * which would be refused instead of reused. Case is folded only where the
 * filesystem folds it.
 */
async function comparable(value: string): Promise<string> {
  const resolved = await realpath(value).catch(() => path.resolve(value));
  const trimmed = resolved.replace(/[\\/]+$/, '');
  return isCaseInsensitivePlatform() ? trimmed.toLowerCase() : trimmed;
}

function git(run: Runner, cwd: string, args: readonly string[]) {
  return run('git', ['-C', cwd, ...args]);
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/**
 * The one mutating command this module issues goes through the same controller
 * every later stage must pass through, so the answer to "did the workspace
 * manager decide for itself that it was allowed?" is no: a `git worktree add`
 * the tool policy would refuse is refused here too.
 */
function creationIsAllowed(primaryRoot: string, argv: readonly string[]): boolean {
  return decideTool({ op: 'execute', argv, cwd: primaryRoot }, { workspace: primaryRoot }).allowed;
}

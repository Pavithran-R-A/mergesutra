import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createRunner, defaultRunner, type RunResult, type Runner } from '../core/runner.js';
import { AppError } from '../core/errors.js';
import { resolveTrustedGitDir, type TrustedGitDir } from '../git/workspace-git-dir.js';
import { sha256Hex } from '../security/digest.js';
import { resolveConfinedFile } from '../security/realpath.js';

/**
 * Naming a patch, so evidence can be proved to describe it — Stage 7.
 *
 * A receipt says "`npm test` exited 0". That claim is only worth anything if it
 * says *which* code it ran against, and "the workspace looked like this" is not
 * an answer a later reader can check. So this module asks Git what differs from
 * the run's base commit and turns the answer into one digest: same digest, same
 * patch; different digest, different patch. A receipt for patch A can then be
 * shown not to describe patch B, which is the whole reason Stage 7 needs an
 * identity at all.
 *
 * Four decisions worth stating:
 *
 * - **The bytes on disk are the patch, not the model's memory of writing them.**
 *   Every gate runs against this directory, so a file a dependency or a fix-up
 *   script changed counts too. Nothing here asks what MergeSutra intended.
 * - **Git is told which repository to read.** A run may write anywhere inside its
 *   workspace, and a workspace's `.git` entry is one of the bytes it can write, so
 *   letting Git *discover* the repository here would let the code under review
 *   choose which configuration the trusted read obeys — and Git configuration
 *   names programs to run. The measurement goes through the metadata directory the
 *   run cannot author, and a workspace whose own metadata does not resolve to one
 *   is refused rather than measured anyway.
 * - **Whatever Git ignores stays out, and so does `.mergesutra/` even if Git
 *   does not know to ignore it.** A run's own evidence directory must not become
 *   part of the patch its evidence describes, and a nested workspace under
 *   `.mergesutra/worktrees` is another run's code.
 * - **The digest is over content, not over `git diff` text.** Diff output is a
 *   rendering — it moves with git's version and configuration — whereas a file's
 *   bytes are the same on every machine that reads them.
 * - **A file's mode is part of the patch.** An executable bit changes what a
 *   checkout would run and what a commit would carry, so it is measured beside
 *   the bytes rather than left for whoever publishes them. Git answers for a
 *   tracked path — including on a Windows checkout, where the index is the only
 *   place the bit can exist — and the disk answers for an untracked one. Only the
 *   flag is bound, and only when it is set, so a patch that carries no executable
 *   file keeps the identity it had before the bit was measured: for such a patch
 *   the older line set already described it completely.
 *
 * This module runs read-only Git commands and hashes files. It never stages,
 * commits, cleans, resets or removes anything.
 */

export const PATCH_SCHEMA_VERSION = 1;

const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** MergeSutra's own scratch, which is never part of the patch it describes. */
const MERGESUTRA_SEGMENT = '.mergesutra/';
/** A patch file beyond this is refused rather than read into this process. */
const MAX_PATCH_FILE_BYTES = 40 * 1024 * 1024;

export const patchChangeSchema = z.enum(['ADDED', 'MODIFIED', 'DELETED']);
export type PatchChange = z.infer<typeof patchChangeSchema>;

export const patchFileFactSchema = z
  .object({
    /** Repository-relative, forward-slashed, exactly as Git reported it. */
    path: z.string().min(1),
    /** False for a file Git has never seen — which is still a gate's input. */
    tracked: z.boolean(),
    change: patchChangeSchema,
    /** Null only for a deletion; there is nothing left to hash. */
    contentSha256: z.string().regex(DIGEST_PATTERN).nullable(),
    /**
     * Whether the path carries an executable bit, as Git would record it.
     *
     * False for a deletion: there is no file for a bit to be set on, and the mode
     * of a path being removed changes nothing about what the patch does.
     */
    executable: z.boolean(),
  })
  .strict();
export type PatchFileFact = z.infer<typeof patchFileFactSchema>;

export const patchDescriptionSchema = z
  .object({
    schemaVersion: z.literal(PATCH_SCHEMA_VERSION),
    baseSha: z.string().regex(SHA_PATTERN),
    /** The one field a receipt carries: proof of which patch the gate ran on. */
    identity: z.string().regex(DIGEST_PATTERN),
    files: z.array(patchFileFactSchema).readonly(),
  })
  .strict();
export type PatchDescription = z.infer<typeof patchDescriptionSchema>;

export interface DescribePatchInput {
  /** The workspace a run owns — the Git worktree Stage 5 prepared for it. */
  readonly workspace: string;
  /** The commit the run recorded as its base. The diff is measured from here. */
  readonly baseSha: string;
}

export interface DescribePatchDeps {
  readonly run?: Runner;
}

export async function describePatch(
  input: DescribePatchInput,
  deps: DescribePatchDeps = {},
): Promise<PatchDescription> {
  const run = deps.run ?? defaultRunner;
  const baseSha = input.baseSha.trim().toLowerCase();
  if (!SHA_PATTERN.test(baseSha)) {
    throw new AppError({
      kind: 'validation',
      message: `Cannot name a patch: '${bound(input.baseSha)}' is not a full commit SHA.`,
      remediation:
        'Use the base commit recorded by intake, so the diff has a fixed starting point.',
    });
  }

  const measured = await measure(input.workspace);
  const root = measured.workTree;
  const head = await git(run, measured, ['rev-parse', 'HEAD']);
  const headSha = head.stdout.trim().toLowerCase();
  if (head.code !== 0 || headSha !== baseSha) {
    throw new AppError({
      kind: 'validation',
      message:
        `Cannot name a patch: the workspace's HEAD is ${bound(headSha || 'unreadable')}, ` +
        `not the recorded base commit ${baseSha.slice(0, 12)}.`,
      remediation:
        'Point verification at the workspace for this run, or re-record the base. MergeSutra will not reset a checkout to make the numbers line up.',
      details: { workspace: root, head: headSha, baseSha },
    });
  }

  const tracked = await trackedChanges(run, measured, baseSha);
  const untracked = await untrackedAdditions(run, measured);
  const files = await hashIn(root, [...tracked, ...untracked]);
  const identity = identityOf({ baseSha, files });

  return parsePatchDescription({ schemaVersion: PATCH_SCHEMA_VERSION, baseSha, identity, files });
}

/**
 * The directory pair Git is told to read, or nothing at all.
 *
 * There is no fallback here on purpose. A workspace whose own `.git` entry does not
 * lead outside itself is a workspace whose repository a run could have authored,
 * and the difference between "unmeasurable" and "measured against the run's own
 * invention" is the whole point of a patch identity.
 */
async function measure(workspace: string): Promise<TrustedGitDir> {
  const trusted = await resolveTrustedGitDir(workspace);
  if (trusted !== null) return trusted;
  throw new AppError({
    kind: 'validation',
    message:
      `Cannot name a patch: ${bound(workspace)} has no Git metadata a run could not have written, ` +
      'so its repository is not trustworthy as the thing being measured.',
    remediation:
      'Measure the workspace MergeSutra prepared for this run (Stage 5 creates it). MergeSutra will not let Git discover a repository from inside the directory under review, because configuration found there can name programs to run.',
  });
}

/**
 * MergeSutra's own check of the patch, and the one place its command is spelled.
 *
 * Stage 7 asks every workspace one question the repository never asked it: does
 * the patch still carry conflict markers or trailing whitespace. The answer comes
 * from Git, and Git needs the repository — which is the fact that made this check
 * unrunnable where it used to run. A sandbox mounts the workspace and nothing
 * else, and a linked worktree's metadata lives outside it, so the same gate that
 * measures cleanly on the host exits 128 in the container (`docs/SECURITY_GAP_REGISTER.md`
 * S16-4 measured both readings on a real customer worktree). Handing the container
 * the metadata would be the wrong fix: read-only, it exposes `remote.<name>.url`,
 * which a customer may have written with a token in it; writable, it hands the run
 * the hooks MergeSutra itself obeys.
 *
 * So this is a measurement, not a command under review, and it runs beside the
 * other one. Three things keep that honest, and the second is why the argv is a
 * constant rather than a field:
 *
 * - Git is told which repository to read, through `measure` and nothing else, so
 *   the S16-2 refusal applies here too — a workspace that could have authored its
 *   own metadata is refused instead of measured with discovery.
 * - The command comes from this constant. A verification plan is a document, and a
 *   document a run can write inside its own workspace could otherwise name any Git
 *   command for a host read; equality with a literal in source is the whole of the
 *   authority here, and it leaves the plan no choice to make.
 * - Only a gate MergeSutra declared for itself qualifies. A repository's own
 *   `git diff --check` step keeps going to the sandbox, because there the command
 *   is the customer's and it is under review.
 */
export const WORKSPACE_CHECK: readonly string[] = ['git', 'diff', '--check'];

/** The shape this decision reads, told structurally so no plan type is needed here. */
export interface WorkspaceCheckCandidate {
  readonly argv: readonly string[];
  readonly provenance: { readonly source: string };
  readonly requirementLevel: string;
}

/** Whether a gate is MergeSutra's own check, command for command. */
export function isWorkspaceCheck(gate: WorkspaceCheckCandidate): boolean {
  return (
    gate.provenance.source === 'MERGESUTRA_BUILTIN' &&
    gate.requirementLevel === 'MERGESUTRA_ADDITIONAL' &&
    gate.argv.length === WORKSPACE_CHECK.length &&
    WORKSPACE_CHECK.every((token, index) => gate.argv[index] === token)
  );
}

export interface WorkspaceCheckDeps {
  readonly timeoutMs?: number;
  readonly run?: Runner;
}

export async function runWorkspaceCheck(
  workspace: string,
  deps: WorkspaceCheckDeps = {},
): Promise<RunResult> {
  const measured = await measure(workspace);
  const run = deps.run ?? createRunner({ timeoutMs: deps.timeoutMs });
  return git(run, measured, WORKSPACE_CHECK.slice(1));
}

/**
 * Whether evidence still describes the patch in front of it.
 *
 * Deliberately a comparison of two digests and nothing more. A receipt that
 * stores its patch identity can be re-checked after a resume by recomputing the
 * identity and calling this — the old record is never edited, which is how a
 * report can show that a gate ran and *then* the patch changed.
 */
export interface StalenessVerdict {
  readonly status: 'CURRENT' | 'STALE';
  readonly recordedIdentity: string;
  readonly currentIdentity: string;
  readonly reason: string;
}

export function stalenessOf(recorded: string, current: string): StalenessVerdict {
  const before = requireDigest(recorded, 'recorded patch identity');
  const after = requireDigest(current, 'current patch identity');
  if (before === after) {
    return {
      status: 'CURRENT',
      recordedIdentity: before,
      currentIdentity: after,
      reason: 'The evidence describes the patch that is here now.',
    };
  }
  return {
    status: 'STALE',
    recordedIdentity: before,
    currentIdentity: after,
    reason:
      `This evidence was gathered against a different patch (${before.slice(0, 12)}) ` +
      `and the workspace now holds ${after.slice(0, 12)}. It is kept for the record ` +
      'and does not count towards the result.',
  };
}

/** Re-validate a description read back off disk; a corrupt record must fail loudly. */
export function parsePatchDescription(value: unknown): PatchDescription {
  const parsed = patchDescriptionSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError({
      kind: 'validation',
      message: `Refusing to use a patch description that does not match MergeSutra's own shape: ${issue?.path.join('.') ?? 'document'}: ${issue?.message ?? 'invalid'}.`,
      remediation: 'Re-run verification so the description is computed from the current workspace.',
    });
  }
  return parsed.data;
}

interface DraftFile {
  readonly path: string;
  readonly tracked: boolean;
  readonly change: PatchChange;
  /** What Git records for a tracked path; null when only the disk can answer. */
  readonly executable: boolean | null;
}

async function trackedChanges(
  run: Runner,
  measured: TrustedGitDir,
  baseSha: string,
): Promise<DraftFile[]> {
  // `--no-renames` is not a detail: a rename reported as R would carry two paths
  // and Git's similarity score, and the identity would then depend on a
  // heuristic. Two files — one gone, one new — is the same fact with no guesswork.
  //
  // `--raw` rather than `--name-status`, because the destination mode is half of
  // what a commit changes: a script that gained its executable bit has the same
  // bytes and a different effect. Git reports that mode from its index even where
  // the filesystem has no bit to read (Windows), which is the only way this can be
  // measured on every host the product runs on.
  const result = await git(run, measured, [
    'diff',
    '--raw',
    '--no-renames',
    '--no-ext-diff',
    '-z',
    baseSha,
  ]);
  if (result.code !== 0) {
    throw new AppError({
      kind: 'invalid-response',
      message: 'Git would not say what this workspace changed.',
      remediation: 'Check that the workspace is intact, then re-run verification.',
      details: { stderr: bound(result.stderr) },
    });
  }
  return rawChanges(result.stdout).map(({ status, path: relative, executable }) => ({
    path: relative,
    tracked: true,
    change: changeOf(status),
    executable,
  }));
}

async function untrackedAdditions(run: Runner, measured: TrustedGitDir): Promise<DraftFile[]> {
  const result = await git(run, measured, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (result.code !== 0) {
    throw new AppError({
      kind: 'invalid-response',
      message: 'Git would not list the untracked files in this workspace.',
      remediation: 'Check that the workspace is intact, then re-run verification.',
      details: { stderr: bound(result.stderr) },
    });
  }
  return tokens(result.stdout)
    .filter((relative) => !isMergeSutraScratch(relative))
    .map((relative) => ({
      path: relative,
      tracked: false,
      change: 'ADDED' as const,
      executable: null,
    }));
}

/**
 * Digest every named file, sorted by path.
 *
 * Sorting first is what makes the identity independent of the order Git happened
 * to print in, and `contentSha256: null` for a deletion keeps "the file is gone"
 * as a fact that changes the patch rather than as a gap in it.
 */
async function hashIn(root: string, drafts: readonly DraftFile[]): Promise<PatchFileFact[]> {
  const sorted = [...drafts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const facts: PatchFileFact[] = [];
  for (const draft of sorted) {
    if (draft.change === 'DELETED') {
      facts.push({ ...draft, contentSha256: null, executable: false });
      continue;
    }
    const confined = await resolveConfinedFile(root, draft.path, `patch file '${draft.path}'`);
    if (confined === null) {
      throw new AppError({
        kind: 'validation',
        message: `Cannot name a patch: '${draft.path}' disappeared while it was being measured.`,
        remediation: 'Check that the workspace is intact, then re-run verification.',
      });
    }
    if (confined.size > MAX_PATCH_FILE_BYTES) {
      throw new AppError({
        kind: 'validation',
        message:
          `Cannot name a patch: '${draft.path}' is ${String(confined.size)} bytes, beyond the ` +
          `${String(MAX_PATCH_FILE_BYTES)}-byte limit for a measured file.`,
        remediation: 'Remove or shrink the file, or publish it through a human-controlled process.',
      });
    }
    const bytes = await readFile(confined.absolute);
    facts.push({
      ...draft,
      contentSha256: sha256Hex(bytes),
      // Git answered for a tracked path; only an untracked file needs the disk to
      // say whether it would be added executable.
      executable: draft.executable ?? (confined.mode & 0o111) !== 0,
    });
  }
  return facts;
}

function identityOf(input: {
  readonly baseSha: string;
  readonly files: readonly PatchFileFact[];
}): string {
  const lines = [`mergesutra-patch/${PATCH_SCHEMA_VERSION}`, `base ${input.baseSha}`];
  for (const file of input.files) {
    // The marker appears only when the bit is set, which keeps a patch that
    // carries no executable file at the identity it had before the bit was
    // measured — for such a patch the older line set described it completely.
    // A patch that does carry one gets a new name, because the old one did not.
    lines.push(
      [
        file.tracked ? 'tracked' : 'untracked',
        file.executable ? `${file.change} exec` : file.change,
        file.path,
        file.contentSha256 ?? 'absent',
      ].join(' '),
    );
  }
  return sha256Hex(lines.join('\n'));
}

function changeOf(status: string): PatchChange {
  const letter = status.charAt(0);
  if (letter === 'D') return 'DELETED';
  if (letter === 'A') return 'ADDED';
  return 'MODIFIED';
}

interface RawChange {
  readonly status: string;
  readonly path: string;
  readonly executable: boolean;
}

/** `--raw -z` alternates `:<old> <new> <oldsha> <newsha> <status>` and path. */
function rawChanges(stdout: string): RawChange[] {
  const fields = tokens(stdout);
  const found: RawChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index] ?? '';
    const relative = fields[index + 1] ?? '';
    if (!meta.startsWith(':') || relative.length === 0) continue;
    const parts = meta.slice(1).split(' ');
    const newMode = parts[1] ?? '';
    const status = parts[4] ?? '';
    if (status.length === 0) continue;
    // A deletion's destination mode is `000000`; nothing is left to execute.
    found.push({
      status,
      path: relative,
      executable: (Number.parseInt(newMode, 8) & 0o111) !== 0,
    });
  }
  return found;
}

function tokens(stdout: string): string[] {
  return stdout
    .split('\0')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isMergeSutraScratch(relative: string): boolean {
  const normalised = relative.replace(/\\/g, '/');
  return normalised.startsWith(MERGESUTRA_SEGMENT) || normalised.includes(`/${MERGESUTRA_SEGMENT}`);
}

function requireDigest(value: string, label: string): string {
  const lowered = value.trim().toLowerCase();
  if (!DIGEST_PATTERN.test(lowered)) {
    throw new AppError({
      kind: 'validation',
      message: `Cannot judge staleness: the ${label} is not a 64-character hex digest.`,
      remediation:
        'A patch identity comes from describePatch; nothing else may be recorded as one.',
      details: { label, value: bound(value) },
    });
  }
  return lowered;
}

function git(run: Runner, measured: TrustedGitDir, args: readonly string[]) {
  // The pair comes before the subcommand, so Git never discovers a repository from
  // the directory under review, and `--no-optional-locks` keeps the "read-only"
  // claim in this module's header honest: a measurement must not take the index
  // lock a run's own `git` invocation is holding.
  return run('git', [
    '--git-dir',
    measured.gitDir,
    '--work-tree',
    measured.workTree,
    '--no-optional-locks',
    ...args,
  ]);
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

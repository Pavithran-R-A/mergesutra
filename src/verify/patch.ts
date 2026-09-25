import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { defaultRunner, type Runner } from '../core/runner.js';
import { AppError } from '../core/errors.js';
import { sha256Hex } from '../security/digest.js';
import { resolveInsideRoot } from '../security/path-safety.js';

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
 * Three decisions worth stating:
 *
 * - **The bytes on disk are the patch, not the model's memory of writing them.**
 *   Every gate runs against this directory, so a file a dependency or a fix-up
 *   script changed counts too. Nothing here asks what MergeSutra intended.
 * - **Whatever Git ignores stays out, and so does `.mergesutra/` even if Git
 *   does not know to ignore it.** A run's own evidence directory must not become
 *   part of the patch its evidence describes, and a nested workspace under
 *   `.mergesutra/worktrees` is another run's code.
 * - **The digest is over content, not over `git diff` text.** Diff output is a
 *   rendering — it moves with git's version and configuration — whereas a file's
 *   bytes are the same on every machine that reads them.
 *
 * This module runs read-only Git commands and hashes files. It never stages,
 * commits, cleans, resets or removes anything.
 */

export const PATCH_SCHEMA_VERSION = 1;

const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** MergeSutra's own scratch, which is never part of the patch it describes. */
const MERGESUTRA_SEGMENT = '.mergesutra/';

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
  /** The workspace a run owns — a Git worktree or checkout. */
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

  const toplevel = await git(run, input.workspace, ['rev-parse', '--show-toplevel']);
  const root = toplevel.stdout.trim();
  if (toplevel.code !== 0 || root.length === 0) {
    throw new AppError({
      kind: 'validation',
      message: `Cannot name a patch: ${bound(input.workspace)} is not a Git workspace.`,
      remediation:
        'Verify inside the workspace the run prepared; MergeSutra does not diff an arbitrary directory.',
      details: { stderr: bound(toplevel.stderr) },
    });
  }

  const head = await git(run, root, ['rev-parse', 'HEAD']);
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

  const tracked = await trackedChanges(run, root, baseSha);
  const untracked = await untrackedAdditions(run, root);
  const files = await hashIn(root, [...tracked, ...untracked]);
  const identity = identityOf({ baseSha, files });

  return parsePatchDescription({ schemaVersion: PATCH_SCHEMA_VERSION, baseSha, identity, files });
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
}

async function trackedChanges(run: Runner, root: string, baseSha: string): Promise<DraftFile[]> {
  // `--no-renames` is not a detail: a rename reported as R would carry two paths
  // and Git's similarity score, and the identity would then depend on a
  // heuristic. Two files — one gone, one new — is the same fact with no guesswork.
  const result = await git(run, root, [
    'diff',
    '--name-status',
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
  return pairs(result.stdout).map(([status, relative]) => ({
    path: relative,
    tracked: true,
    change: changeOf(status),
  }));
}

async function untrackedAdditions(run: Runner, root: string): Promise<DraftFile[]> {
  const result = await git(run, root, ['ls-files', '--others', '--exclude-standard', '-z']);
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
    .map((relative) => ({ path: relative, tracked: false, change: 'ADDED' as const }));
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
      facts.push({ ...draft, contentSha256: null });
      continue;
    }
    const absolute = resolveInsideRoot(root, draft.path, 'patch file');
    const bytes = await readFile(absolute);
    facts.push({ ...draft, contentSha256: sha256Hex(bytes) });
  }
  return facts;
}

function identityOf(input: {
  readonly baseSha: string;
  readonly files: readonly PatchFileFact[];
}): string {
  const lines = [`mergesutra-patch/${PATCH_SCHEMA_VERSION}`, `base ${input.baseSha}`];
  for (const file of input.files) {
    lines.push(
      [
        file.tracked ? 'tracked' : 'untracked',
        file.change,
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

/** `-z` output is NUL-separated; `--name-status` alternates status and path. */
function pairs(stdout: string): [string, string][] {
  const fields = tokens(stdout);
  const found: [string, string][] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] ?? '';
    const relative = fields[index + 1] ?? '';
    if (status.length > 0 && relative.length > 0) found.push([status, relative]);
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

function git(run: Runner, cwd: string, args: readonly string[]) {
  return run('git', ['-C', cwd, ...args]);
}

function bound(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

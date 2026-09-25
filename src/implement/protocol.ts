import { z } from 'zod';
import { AppError } from '../core/errors.js';
import {
  isRepositoryRelativeDirectory,
  isRepositoryRelativePath,
} from '../security/path-safety.js';
import { isArgvShaped } from '../security/command-safety.js';
import { criterionIdSchema } from '../plan/schema.js';

/**
 * The action protocol — Stage 6's answer to "the model may not have a shell".
 *
 * An implementation loop that pastes model prose into a terminal is the failure
 * mode this project exists to avoid, so BharatCode never emits commands. It
 * emits one JSON object per turn, chosen from a closed list of operations, each
 * carrying only the fields that operation needs. Everything else — which
 * workspace, which argv, what timeout, what risk class, whether this is allowed
 * in this phase — is decided by MergeSutra after parsing, through the Stage 5
 * boundaries.
 *
 * Three properties are deliberate:
 *
 * - `strict()` on every variant, so `{action:'WRITE_FILE', path:'…', force:true}`
 *   is a refusal rather than a silently-ignored field;
 * - a discriminated union, so an action name that is not on the list cannot be
 *   constructed and the error says which ones are;
 * - no variant can name a criterion status, a contract version, a file outside
 *   the workspace, or a command string. There is no field to lie in.
 *
 * Stage 7 added a fourth, on the one action that changes bytes: a write must say
 * which version of the file it replaces. See `preconditionSchema`.
 */

/** Content the model may propose in one write. The writer's own cap is higher. */
export const MAX_ACTION_CONTENT_CHARS = 64 * 1024;
const MAX_REASON_CHARS = 300;
const MAX_SUMMARY_CHARS = 2_000;

/**
 * A file a read or write names. `.` is not a file, so the strict rule applies.
 */
const pathSchema = z.string().min(1).refine(isRepositoryRelativePath, {
  message:
    'Paths must be repository-relative POSIX paths: no `..`, no absolute path, no drive letter, no backslash.',
});

/**
 * A directory, where `.` is the only honest spelling of "the workspace root".
 *
 * Listing and search are the actions that name a directory, and a model that is
 * asked for a relative path has no way to say "the whole tree" without either
 * `.` or an absolute path. Refusing `.` would push it to the absolute path.
 */
const directorySchema = z.string().min(1).refine(isRepositoryRelativeDirectory, {
  message:
    'A directory must be `.` for the workspace root, or a repository-relative POSIX path with no `..` and no absolute prefix.',
});

const argvSchema = z.array(z.string().min(1)).min(1).refine(isArgvShaped, {
  message:
    'A check must be an argv array with no shell composition characters; MergeSutra never runs a command string.',
});

const reasonSchema = z.string().min(1).max(MAX_REASON_CHARS);

/** Where an action says it helps. Optional, because exploration is legitimate. */
const criteriaSchema = z.array(criterionIdSchema).default([]);

/**
 * Which version of the file this write replaces, in the writer's own shape.
 *
 * Required, and a union of two strict objects, so the two ways a write can be
 * honest are the only two ways it can be *written*: name the digest of the file
 * you were shown, or say the path is absent. Neither, both, and a
 * `force`/`ignoreStale` override are all unparseable — which is the point, since
 * "and then it overwrote a file it never read" was Stage 6's real gap.
 */
const preconditionSchema = z.union(
  [
    z.object({ expectedSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    z.object({ expectedAbsent: z.literal(true) }).strict(),
  ],
  {
    message:
      'A write must say what it replaces: `replaces: { "expectedSha256": "<64 hex digest>" }` for the version MergeSutra reported to you, or `replaces: { "expectedAbsent": true }` for a file you believe is new. There is no way to write without saying.',
  },
);

const read = z
  .object({
    action: z.literal('READ_FILE'),
    path: pathSchema,
    reason: reasonSchema,
  })
  .strict();

const list = z
  .object({
    action: z.literal('LIST_FILES'),
    /** Defaults to the workspace root; `.` is the only way to name that. */
    path: directorySchema.default('.'),
    reason: reasonSchema,
  })
  .strict();

const search = z
  .object({
    action: z.literal('SEARCH'),
    query: z.string().min(2).max(200),
    scope: directorySchema.optional(),
    reason: reasonSchema,
  })
  .strict();

const write = z
  .object({
    action: z.literal('WRITE_FILE'),
    path: pathSchema,
    /**
     * Complete intended file content, not a diff. One representation, chosen
     * because a whole file can be size-checked, confinement-checked and written
     * atomically without a patch parser — and a patch parser is a second
     * protocol with its own escapes. See ADR-027.
     */
    content: z.string().min(1).max(MAX_ACTION_CONTENT_CHARS),
    /** Which version of the file this replaces. Required; see `preconditionSchema`. */
    replaces: preconditionSchema,
    criterionIds: criteriaSchema,
    reason: reasonSchema,
  })
  .strict();

const check = z
  .object({
    action: z.literal('RUN_CHECK'),
    argv: argvSchema,
    criterionIds: criteriaSchema,
    reason: reasonSchema,
  })
  .strict();

const revision = z
  .object({
    action: z.literal('PROPOSE_CONTRACT_REVISION'),
    criterionId: criterionIdSchema,
    previous: z.string().min(1).max(MAX_REASON_CHARS),
    proposed: z.string().min(1).max(MAX_REASON_CHARS),
    reason: reasonSchema,
    /** The evidence the model believes justifies the change — a file, a line, an error. */
    sourceEvidence: z.string().min(1).max(MAX_REASON_CHARS),
  })
  .strict();

const finish = z
  .object({
    action: z.literal('FINISH'),
    summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
    /** A model claim about coverage. It is not a status and cannot become one. */
    criteriaBelievedComplete: criteriaSchema,
  })
  .strict();

const blocked = z
  .object({
    action: z.literal('BLOCKED'),
    reason: z.string().min(1).max(MAX_SUMMARY_CHARS),
  })
  .strict();

export const loopActionSchema = z.discriminatedUnion('action', [
  read,
  list,
  search,
  write,
  check,
  revision,
  finish,
  blocked,
]);

export type LoopAction = z.infer<typeof loopActionSchema>;
export type WriteAction = z.infer<typeof write>;
export type CheckAction = z.infer<typeof check>;
export type FinishAction = z.infer<typeof finish>;
export type RevisionAction = z.infer<typeof revision>;

export const ACTION_KINDS = [
  'READ_FILE',
  'LIST_FILES',
  'SEARCH',
  'WRITE_FILE',
  'RUN_CHECK',
  'PROPOSE_CONTRACT_REVISION',
  'FINISH',
  'BLOCKED',
] as const;

/**
 * Parse one model turn into an action, or say precisely why it is not one.
 *
 * The message is what gets fed back for a bounded repair, so it names the
 * allowed kinds when the discriminator is wrong — an unhelpful "invalid input"
 * is how a loop spends its request budget on a misunderstanding.
 */
export function parseAction(value: unknown): LoopAction {
  const parsed = loopActionSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const unknownKind =
    typeof value === 'object' && value !== null && 'action' in value
      ? String((value as { action: unknown }).action)
      : null;
  const detail =
    unknownKind !== null && !(ACTION_KINDS as readonly string[]).includes(unknownKind)
      ? `'${unknownKind}' is not an operation MergeSutra offers. Choose one of: ${ACTION_KINDS.join(', ')}.`
      : `${issue?.path.join('.') || 'action'}: ${issue?.message ?? 'the object did not match the action schema'}`;
  throw new AppError({
    kind: 'validation',
    message: `Rejected model action: ${detail}`,
    remediation: 'Ask for exactly one JSON object with an `action` field from the allowed list.',
  });
}

/** Criterion ids the action names, so they can be checked against the contract. */
export function actionCriterionIds(action: LoopAction): string[] {
  if ('criterionIds' in action) return [...action.criterionIds];
  if (action.action === 'FINISH') return [...action.criteriaBelievedComplete];
  if (action.action === 'PROPOSE_CONTRACT_REVISION') return [action.criterionId];
  return [];
}

/** Ids the contract never issued — a model inventing obligations or coverage. */
export function unknownActionCriterionIds(
  action: LoopAction,
  knownCriterionIds: readonly string[],
): string[] {
  const known = new Set(knownCriterionIds);
  return actionCriterionIds(action).filter((id) => !known.has(id));
}

/**
 * The identity used to spot a no-progress loop.
 *
 * Deliberately structural: the operation plus its normalized target, so
 * `npm test` asked twice is the same identity and a reworded `reason` does not
 * launder it into a fresh attempt. Result and workspace state are the other two
 * halves of that judgement and live in the loop, not here.
 */
export function actionIdentity(action: LoopAction): string {
  switch (action.action) {
    case 'READ_FILE':
    case 'LIST_FILES':
      return `${action.action}:${action.path}`;
    case 'SEARCH':
      return `search:${action.query.trim().toLowerCase()}:${action.scope ?? '.'}`;
    case 'WRITE_FILE':
      return `write:${action.path}`;
    case 'RUN_CHECK':
      return `check:${action.argv.join(' ')}`;
    case 'PROPOSE_CONTRACT_REVISION':
      return `revision:${action.criterionId}`;
    case 'FINISH':
      return 'finish';
    case 'BLOCKED':
      return 'blocked';
  }
}

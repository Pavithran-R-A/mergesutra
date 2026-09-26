import { AppError } from '../core/errors.js';
import { defaultRunner, type Runner } from '../core/runner.js';
import { openConfinedReader, secretReason, type ConfinedReader } from '../security/reader.js';
import { isRepositoryRelativePath } from '../security/path-safety.js';
import type { AcceptanceCriterion } from '../contract/schema.js';
import type { RunRecord } from '../state/run-record.js';
import { stalenessOf, type PatchChange, type PatchDescription } from '../verify/patch.js';
import type { GateOutcome } from '../verify/engine.js';
import {
  assembleScopeFiles,
  buildReviewManifest,
  type ReviewContextManifest,
  type ReviewScopeFile,
} from './manifest.js';

/**
 * What a reviewer is shown — Stage 9.
 *
 * This module decides whether the stage's central claim is true. A review is
 * worth having only if the reviewer was handed *the work* — the bytes, the
 * obligations and what the gates actually said — and not the author's account of
 * it. So the context carries the issue, the Acceptance Contract, the plan as one
 * model's stated intent, every receipt with its command's output tail, and the
 * patch itself; and it deliberately carries none of the implementation loop's
 * transcript, its log, or its assertion that it finished. That last group is
 * named in `excluded` so a reader of the record can see the omission was a
 * choice, made on purpose, and recorded.
 *
 * The same reasoning sets the limits. Credentials and binary bytes never travel,
 * whatever the patch contains. The patch text is bounded per file and in total,
 * and when the budget runs out the *omission* is recorded as a fact: a reviewer
 * that quietly received half a diff will describe the half it saw as though it
 * were the patch.
 *
 * Reading happens through Stage 5's confined reader and one read-only `git diff`
 * per changed file. Nothing here writes, deletes, or runs anything the run has
 * not already measured.
 */

export const REVIEW_CONTEXT_SCHEMA_VERSION = 1;

/** Content-bearing files one review may be shown. Deletions and refusals are free. */
export const MAX_REVIEW_FILES = 40;
/** Per file. Matches Stage 6's read budget so one stage's context is another's ceiling. */
export const MAX_REVIEW_FILE_BYTES = 32 * 1024;
/** Across the whole patch, so a large refactor cannot spend the request on itself. */
export const MAX_REVIEW_CONTEXT_BYTES = 160 * 1024;

const TRUNCATION_NOTICE = '\n\n(truncated)';
const NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
/** Below this, sending a file is worse than saying there was no room for it. */
const MINIMUM_ROOM = 16;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface ReviewContextLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_REVIEW_CONTEXT_LIMITS: ReviewContextLimits = {
  maxFiles: MAX_REVIEW_FILES,
  maxFileBytes: MAX_REVIEW_FILE_BYTES,
  maxTotalBytes: MAX_REVIEW_CONTEXT_BYTES,
};

export const REVIEW_FILE_PRESENTATIONS = ['DIFF', 'FULL_CONTENT', 'DELETED', 'WITHHELD'] as const;
export type ReviewFilePresentation = (typeof REVIEW_FILE_PRESENTATIONS)[number];

export interface ReviewPatchFile {
  readonly path: string;
  readonly change: PatchChange;
  readonly tracked: boolean;
  /** Stage 7's digest of the whole file, so a quotation can be checked against it. */
  readonly contentSha256: string | null;
  readonly presentation: ReviewFilePresentation;
  readonly text: string;
  readonly truncated: boolean;
  /** Why this file is being shown this way. Never empty. */
  readonly reason: string;
}

export interface ReviewSkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface ReviewIssueFact {
  readonly canonical: string;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly commentCount: number;
  readonly wasTruncated: boolean;
  /** Rule ids the intake scan raised on this text, without quoting it again. */
  readonly injectionFindings: readonly string[];
  readonly untrusted: true;
}

export interface ReviewCriterionFact {
  readonly id: string;
  readonly statement: string;
  readonly requirementType: string;
  readonly status: string;
  /** What Stage 7's mapper was willing to say, or null when it never reached it. */
  readonly evidenceStatus: string | null;
  readonly gateIds: readonly string[];
  readonly limitations: readonly string[];
}

export interface ReviewPlanFact {
  readonly summary: string;
  readonly rootCause: string;
  readonly model: string;
  readonly filesToTouch: readonly string[];
  readonly validationCommands: readonly string[];
  readonly criteriaCovered: readonly string[];
  readonly criteriaUnaddressed: readonly { id: string; reason: string }[];
  readonly questionsForHuman: readonly string[];
  readonly untrusted: true;
}

export interface ReviewGateFact {
  readonly gateId: string;
  readonly argv: readonly string[];
  readonly status: string;
  readonly result: string;
  readonly exitCode: number | null;
  readonly termination: string;
  readonly patchIdentity: string;
  readonly outputSha256: string;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
}

export interface ReviewVerificationFact {
  readonly result: string;
  readonly workspace: string;
  readonly baseSha: string;
  /** The patch every receipt below claims it ran against. */
  readonly patchIdentity: string;
  readonly currentPatchIdentity: string;
  readonly currency: 'CURRENT' | 'STALE';
  readonly currencyReason: string;
  readonly gates: readonly ReviewGateFact[];
  readonly notes: readonly string[];
  readonly contamination: { gateId: string; reason: string } | null;
}

export interface ReviewContext {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly baseSha: string;
  readonly reviewedPatchIdentity: string;
  readonly issue: ReviewIssueFact;
  readonly criteria: readonly ReviewCriterionFact[];
  readonly plan: ReviewPlanFact | null;
  readonly verification: ReviewVerificationFact;
  readonly limitations: readonly string[];
  readonly files: readonly ReviewPatchFile[];
  readonly skipped: readonly ReviewSkippedFile[];
  /**
   * Files the plan said it would change and this patch left alone, read from the
   * workspace under the same confinement and budgets as the patch. A diff cannot
   * show its own omissions, so the review would be unable to either.
   */
  readonly scope: readonly ReviewScopeFile[];
  /** Why an in-scope file was not sent, and how much reading the budget allowed. */
  readonly scopeLimitations: readonly string[];
  /** The ids a finding may cite, authored here from the material on the page. */
  readonly manifest: ReviewContextManifest;
  /** Bytes of patch content actually sent. */
  readonly bytes: number;
  readonly limits: ReviewContextLimits;
  /** What this context left out, and why. Read by the human, not by the model. */
  readonly excluded: readonly string[];
}

export interface AssembleReviewContextInput {
  readonly record: RunRecord;
  readonly workspace: string;
  readonly patch: PatchDescription;
  readonly limits?: Partial<ReviewContextLimits>;
}

export interface AssembleReviewContextDeps {
  readonly reader?: ConfinedReader;
  readonly run?: Runner;
}

/**
 * The things a review context refuses to carry, stated in the document itself.
 *
 * An omission nobody wrote down is indistinguishable from one nobody noticed, so
 * this list ships with every context and reaches every report.
 */
export const REVIEW_CONTEXT_EXCLUSIONS: readonly string[] = [
  'The Stage 6 loop transcript — its reads, its writes and its action log — because it records ' +
    'one agent’s attempts, not the bytes a reviewer is being asked to judge.',
  'The loop’s finish claim, which is the assertion under review and therefore cannot be part of ' +
    'the evidence for it.',
  'Model claims carried in Stage 7’s evidence record, for the same reason: they are kept as ' +
    'claims and are never handed back as context.',
  'The contents of any file that holds a credential, and of any file that is not text.',
];

export async function assembleReviewContext(
  input: AssembleReviewContextInput,
  deps: AssembleReviewContextDeps = {},
): Promise<ReviewContext> {
  const { record, patch } = input;
  const limits = { ...DEFAULT_REVIEW_CONTEXT_LIMITS, ...(input.limits ?? {}) };
  const contract = requireContract(record);
  const verification = requireVerification(record);
  const base = requireBase(record);
  requireSameBase(patch, base);
  requireDigest(patch);

  const reader = deps.reader ?? (await openConfinedReader(input.workspace));
  const run = deps.run ?? defaultRunner;
  const currency = stalenessOf(verification.patchIdentity, patch.identity);

  const limitations = [
    ...record.limitations,
    ...(contract.limitations ?? []),
    ...(record.issue
      ? []
      : [
          'This run has no issue document, so the reviewer cannot read the ' +
            'request the criteria came from.',
        ]),
  ];

  const patchFiles = await describePatchFiles({
    reader,
    run,
    workspace: input.workspace,
    baseSha: patch.baseSha,
    patch,
    limits,
  });

  const scope = await assembleScopeFiles({ record, patch }, { reader });

  const withoutManifest = {
    schemaVersion: REVIEW_CONTEXT_SCHEMA_VERSION,
    runId: record.runId,
    baseSha: patch.baseSha,
    reviewedPatchIdentity: patch.identity,
    issue: issueFact(record),
    criteria: contract.criteria.map((criterion) => criterionFact(criterion, record)),
    plan: record.plan ? planFact(record.plan) : null,
    verification: {
      result: verification.result,
      workspace: verification.workspace,
      baseSha: verification.baseSha,
      patchIdentity: verification.patchIdentity,
      currentPatchIdentity: currency.currentIdentity,
      currency: currency.status,
      currencyReason: currency.reason,
      gates: verification.gates.map(gateFact),
      notes: [...verification.notes],
      contamination: verification.contamination
        ? {
            gateId: verification.contamination.gateId,
            reason: verification.contamination.reason,
          }
        : null,
    },
    limitations,
    files: patchFiles.files,
    skipped: patchFiles.skipped,
    scope: scope.files,
    scopeLimitations: scope.limitations,
    bytes: patchFiles.bytes,
    limits,
    excluded: REVIEW_CONTEXT_EXCLUSIONS,
  } satisfies Omit<ReviewContext, 'manifest'>;

  return { ...withoutManifest, manifest: buildReviewManifest(withoutManifest, record.contract) };
}

function issueFact(record: RunRecord): ReviewIssueFact {
  const issue = record.issue;
  return {
    canonical: record.issueRef?.canonical ?? '(no issue reference recorded)',
    url: issue?.url ?? record.issueRef?.url ?? '',
    title: issue?.title ?? '',
    state: issue?.state ?? '',
    body: issue?.body ?? '',
    labels: [...(issue?.labels ?? [])],
    commentCount: issue?.commentCount ?? 0,
    wasTruncated: issue?.wasTruncated ?? false,
    injectionFindings: (issue?.injectionFindings ?? []).map((finding) => finding.ruleId),
    untrusted: true,
  };
}

function criterionFact(criterion: AcceptanceCriterion, record: RunRecord): ReviewCriterionFact {
  const entry = record.evidence?.criteria.find((item) => item.criterionId === criterion.id);
  return {
    id: criterion.id,
    statement: criterion.statement,
    requirementType: criterion.requirementType,
    status: criterion.status,
    evidenceStatus: entry ? entry.status : null,
    gateIds: entry ? [...entry.gateIds] : [],
    limitations: [...criterion.limitations, ...(entry ? entry.limitations : [])],
  };
}

function planFact(plan: NonNullable<RunRecord['plan']>): ReviewPlanFact {
  return {
    summary: plan.body.summary,
    rootCause: plan.body.rootCause,
    model: plan.provenance.model,
    filesToTouch: plan.body.changes.map((change) => change.file),
    validationCommands: plan.body.validationCommands.map((command) => command.argv.join(' ')),
    criteriaCovered: [...plan.body.criteriaCovered],
    criteriaUnaddressed: plan.body.criteriaUnaddressed.map((item) => ({ ...item })),
    questionsForHuman: [...plan.body.questionsForHuman],
    untrusted: true,
  };
}

function gateFact(outcome: GateOutcome): ReviewGateFact {
  const receipt = outcome.receipt;
  return {
    gateId: receipt.gateId,
    argv: [...receipt.argv],
    status: outcome.status,
    result: receipt.result,
    exitCode: receipt.exitCode,
    termination: receipt.termination,
    patchIdentity: receipt.patchIdentity,
    outputSha256: receipt.outputSha256,
    stdoutSummary: receipt.stdoutSummary,
    stderrSummary: receipt.stderrSummary,
  };
}

interface PatchReadingInput {
  readonly reader: ConfinedReader;
  readonly run: Runner;
  readonly workspace: string;
  readonly baseSha: string;
  readonly patch: PatchDescription;
  readonly limits: ReviewContextLimits;
}

async function describePatchFiles(
  input: PatchReadingInput,
): Promise<{ files: ReviewPatchFile[]; skipped: ReviewSkippedFile[]; bytes: number }> {
  const files: ReviewPatchFile[] = [];
  const skipped: ReviewSkippedFile[] = [];
  let bytes = 0;
  let sent = 0;

  for (const file of input.patch.files) {
    if (file.change === 'DELETED') {
      files.push({
        ...shapeOf(file),
        presentation: 'DELETED',
        text: '',
        truncated: false,
        reason: 'The patch deleted this file, so there is nothing left to read.',
      });
      continue;
    }
    const secret = secretReason(file.path);
    if (secret) {
      files.push({
        ...shapeOf(file),
        presentation: 'WITHHELD',
        text: '',
        truncated: false,
        reason: `The patch touches this file but its content is withheld because ${secret}.`,
      });
      continue;
    }
    if (!isRepositoryRelativePath(file.path)) {
      skipped.push({ path: file.path, reason: 'the path is not a repository-relative file name' });
      continue;
    }
    if (sent >= input.limits.maxFiles) {
      skipped.push({
        path: file.path,
        reason: `the review file budget of ${input.limits.maxFiles} content files is spent`,
      });
      continue;
    }
    const room = input.limits.maxTotalBytes - bytes;
    if (room <= MINIMUM_ROOM) {
      skipped.push({
        path: file.path,
        reason: 'the review context byte budget is exhausted; no content was sent',
      });
      continue;
    }
    const cap = Math.min(room, input.limits.maxFileBytes);
    const read = file.tracked
      ? await trackedContent(input, file.path, cap)
      : await addedContent(input.reader, file.path, cap);
    if ('refusal' in read) {
      files.push({
        ...shapeOf(file),
        presentation: 'WITHHELD',
        text: '',
        truncated: false,
        reason: `The patch touches this file and its content is withheld: ${read.refusal}`,
      });
      continue;
    }
    bytes += Buffer.byteLength(read.text, 'utf8');
    sent += 1;
    files.push({ ...shapeOf(file), ...read });
  }

  return { files, skipped, bytes };
}

async function trackedContent(
  input: PatchReadingInput,
  relativePath: string,
  cap: number,
): Promise<PatchContent | Refusal> {
  const result = await input
    .run('git', [
      '-C',
      input.workspace,
      'diff',
      '--no-ext-diff',
      '--no-renames',
      input.baseSha,
      '--',
      relativePath,
    ])
    .catch(() => null);
  if (!result || result.code !== 0) {
    return { refusal: 'Git would not produce a diff for it' };
  }
  const diff = result.stdout.replace(/\r\n/g, '\n');
  if (diff.trim() === '') {
    const whole = await addedContent(input.reader, relativePath, cap);
    return 'refusal' in whole
      ? whole
      : {
          ...whole,
          presentation: 'FULL_CONTENT',
          reason: 'Git reported no textual difference for this file, so it is shown whole.',
        };
  }
  return fit(diff, cap, 'DIFF', 'The unified diff of this file against the run’s base commit.');
}

async function addedContent(
  reader: ConfinedReader,
  relativePath: string,
  cap: number,
): Promise<PatchContent | Refusal> {
  const room = Math.max(1, cap - NOTICE_BYTES);
  try {
    const receipt = await reader.readText(relativePath, room);
    return fit(
      receipt.text,
      cap,
      'FULL_CONTENT',
      receipt.truncated
        ? 'This new file is larger than the per-file budget, so it is sent in part.'
        : 'A new file has no history to diff against, so it is shown whole.',
    );
  } catch (error) {
    return { refusal: oneLine(errorMessage(error)) };
  }
}

interface Refusal {
  readonly refusal: string;
}

function fit(
  text: string,
  cap: number,
  presentation: ReviewFilePresentation,
  reason: string,
): PatchContent {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= cap) return { presentation, text, truncated: false, reason };
  const room = Math.max(0, cap - NOTICE_BYTES);
  return {
    presentation,
    text: `${sliceBytes(text, room)}${TRUNCATION_NOTICE}`,
    truncated: true,
    reason: `${reason} It was cut at the budget; the part after this point was not sent.`,
  };
}

type PatchContent = Pick<ReviewPatchFile, 'presentation' | 'text' | 'truncated' | 'reason'>;

function shapeOf(file: PatchDescription['files'][number]) {
  return {
    path: file.path,
    change: file.change,
    tracked: file.tracked,
    contentSha256: file.contentSha256,
  };
}

function requireContract(record: RunRecord) {
  if (record.acceptanceContract) return record.acceptanceContract;
  throw new AppError({
    kind: 'validation',
    message: 'Cannot assemble a review context: this run has no Acceptance Contract.',
    remediation: 'Run `mergesutra contract` first. A review with no obligations is an opinion.',
  });
}

function requireVerification(record: RunRecord) {
  if (record.verification) return record.verification;
  throw new AppError({
    kind: 'validation',
    message: 'Cannot assemble a review context: nothing has been verified in this run yet.',
    remediation:
      'Run `mergesutra verify` first. A reviewer that cannot see which gates ran has nothing to check a green result against.',
  });
}

function requireBase(record: RunRecord): string {
  const sha = record.implementation?.workspace.baseSha ?? record.base?.sha;
  if (!sha || !COMMIT.test(sha)) {
    throw new AppError({
      kind: 'validation',
      message: 'Cannot assemble a review context: this run recorded no base commit to diff from.',
      remediation: 'Re-run intake and implement so the workspace carries the commit it started at.',
    });
  }
  return sha.toLowerCase();
}

function requireSameBase(patch: PatchDescription, base: string): void {
  if (patch.baseSha.toLowerCase() === base) return;
  throw new AppError({
    kind: 'validation',
    message:
      `Cannot review this patch: it was measured from base ${patch.baseSha.slice(0, 12)}, ` +
      `while this run is recorded against ${base.slice(0, 12)}.`,
    remediation:
      'Describe the patch of this run’s workspace. A diff from another base is a different change.',
  });
}

function requireDigest(patch: PatchDescription): void {
  if (DIGEST.test(patch.identity)) return;
  throw new AppError({
    kind: 'validation',
    message: 'Cannot bind a review: the patch identity is not a 64-character hex digest.',
    remediation: 'A patch identity comes from describePatch; nothing else may be named as one.',
    details: { identity: patch.identity.slice(0, 80) },
  });
}

function sliceBytes(text: string, count: number): string {
  const buffer = Buffer.from(text, 'utf8').subarray(0, count);
  // Decoding a partial multi-byte character yields U+FFFD; drop the tail instead.
  return buffer.toString('utf8').replace(/\uFFFD+$/, '');
}

function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, ' ');
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 197)}...`;
}

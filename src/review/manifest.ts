import { isRepositoryRelativePath } from '../security/path-safety.js';
import { looksBinary, secretReason, type ConfinedReader } from '../security/reader.js';
import { defaultRedactor } from '../security/redaction.js';
import type { RunRecord } from '../state/run-record.js';
import type { PatchChange, PatchDescription } from '../verify/patch.js';
import type {
  ReviewCriterionFact,
  ReviewGateFact,
  ReviewPatchFile,
  ReviewSkippedFile,
} from './context.js';

/**
 * Who owns the names a finding may point at — Stage 9's provenance layer.
 *
 * A reviewer has no tools, so the only checkable form of "this finding is
 * grounded" is "this finding cites material MergeSutra put on the page, under an
 * id MergeSutra assigned". That has to be a *list authored here*, because the
 * alternative is letting the model name a file to gain standing: every path it
 * invents would become a repair target, and the confined reader's care in
 * deciding what may be read would amount to nothing.
 *
 * The manifest therefore covers six kinds of thing, each with a different amount
 * of authority behind it:
 *
 * - `PATCH` — a file this patch changes, shown as its diff or its bytes.
 * - `SOURCE` — a file the plan said it would touch and the patch left alone,
 *   whose current bytes were read from the repository and sent. This is the kind
 *   that lets a review report the defect a diff cannot contain: the file that is
 *   missing from it.
 * - `CRITERION` / `RECEIPT` — the obligations this run owes and the gates that
 *   answered for them.
 * - `POLICY` — the repository files the Stage 2 contract was read from. Named,
 *   never sent: knowing `package.json` exists is not the same as having shown it.
 *
 * Two numbers make the difference between a citation and a boast: how many lines
 * of the material actually reached the page, and whether that was all of it. A
 * finding about line 4,000 of a file whose first 40 lines were sent describes
 * something nobody showed the reviewer, whatever its author believes.
 */

export const REVIEW_MANIFEST_SCHEMA_VERSION = 1;

/** Files read *besides* the patch, per review, and how much of each may travel. */
export const MAX_REVIEW_SCOPE_FILES = 8;
export const MAX_REVIEW_SCOPE_FILE_BYTES = 8 * 1024;
export const MAX_REVIEW_SCOPE_TOTAL_BYTES = 24 * 1024;

export const REVIEW_REFERENCE_KINDS = [
  'PATCH',
  'SOURCE',
  'CRITERION',
  'RECEIPT',
  'POLICY',
] as const;
export type ReviewReferenceKind = (typeof REVIEW_REFERENCE_KINDS)[number];

/**
 * How the material reached the page. `LISTED` and `NOT_SENT` carry no bytes.
 *
 * The four patch presentations are repeated here rather than spread from
 * `context.ts` because this module must not import a value from the file that
 * imports it. The repetition is checked: every place a patch file's presentation
 * is copied into a reference is a compile error if a word is missing below.
 */
export const REVIEW_REFERENCE_PRESENTATIONS = [
  'DIFF',
  'FULL_CONTENT',
  'DELETED',
  'WITHHELD',
  'SOURCE',
  'LISTED',
  'NOT_SENT',
] as const;
export type ReviewReferencePresentation = (typeof REVIEW_REFERENCE_PRESENTATIONS)[number];

export const REVIEW_REF_PATTERN = /^CTX-[0-9]{3}$/;

export interface ReviewReference {
  /** Assigned by MergeSutra, in the order the material appears on the page. */
  readonly ref: string;
  readonly kind: ReviewReferenceKind;
  readonly path: string | null;
  readonly criterionId: string | null;
  readonly gateId: string | null;
  readonly presentation: ReviewReferencePresentation;
  readonly change: PatchChange | null;
  /** Lines of this material that were on the page — zero when none were sent. */
  readonly linesSent: number;
  readonly totalLines: number | null;
  readonly partial: boolean;
  readonly origin: string;
  readonly detail: string;
}

export interface ReviewContextManifest {
  readonly schemaVersion: number;
  readonly runId: string;
  /** The patch this manifest was authored for; it may not vouch for another. */
  readonly reviewedPatchIdentity: string;
  readonly references: readonly ReviewReference[];
  /** Files a plan named that MergeSutra could not or did not send. */
  readonly limitations: readonly string[];
}

/** A file the run owes attention to and this patch does not carry. */
export interface ReviewScopeFile {
  readonly path: string;
  readonly origin: 'PLAN';
  /** Why this file is in scope, quoted from the plan that named it. */
  readonly reason: string;
  readonly criterionIds: readonly string[];
  readonly content: string;
  readonly linesSent: number;
  /** `null` when the read stopped early and nobody counted what was left. */
  readonly totalLines: number | null;
  readonly truncated: boolean;
}

export interface AssembleScopeInput {
  readonly record: RunRecord;
  readonly patch: PatchDescription;
}

export interface AssembleScopeDeps {
  readonly reader: ConfinedReader;
}

export interface ScopeAssembly {
  readonly files: readonly ReviewScopeFile[];
  readonly limitations: readonly string[];
}

/**
 * Read the files the plan promised and the patch left alone.
 *
 * The candidate list comes from the plan's own change entries, which are a
 * model's words — but nothing reaches a reference from those words alone. Each
 * path has to survive the confined reader, the secret rules and the binary test
 * before it is on the page, so a plan that names `/etc/passwd` or `.env` produces
 * a limitation, not a capability.
 */
export async function assembleScopeFiles(
  input: AssembleScopeInput,
  deps: AssembleScopeDeps,
): Promise<ScopeAssembly> {
  const changes = input.record.plan?.body.changes ?? [];
  const inPatch = new Set(input.patch.files.map((file) => file.path));
  const files: ReviewScopeFile[] = [];
  const limitations: string[] = [];
  let sent = 0;
  let bytes = 0;

  for (const change of changes) {
    if (inPatch.has(change.file)) continue;
    if (!isRepositoryRelativePath(change.file)) {
      limitations.push(
        `The plan named ${change.file}, which is not a repository-relative path, so nothing was read ` +
          'for it and it has no reference.',
      );
      continue;
    }
    const secret = secretReason(change.file);
    if (secret) {
      limitations.push(`The plan named ${change.file} and it was not sent because ${secret}.`);
      continue;
    }
    if (files.length >= MAX_REVIEW_SCOPE_FILES) {
      limitations.push(
        `The plan named ${change.file} but the in-scope reading budget of ` +
          `${MAX_REVIEW_SCOPE_FILES} files is spent, so it has no reference.`,
      );
      continue;
    }
    const room = MAX_REVIEW_SCOPE_TOTAL_BYTES - bytes;
    if (room <= 0) {
      limitations.push(
        `The plan named ${change.file} but the in-scope byte budget is spent, so it has no reference.`,
      );
      continue;
    }
    const read = await deps.reader
      .readText(change.file, Math.min(room, MAX_REVIEW_SCOPE_FILE_BYTES))
      .catch(() => null);
    if (!read) {
      limitations.push(
        `The plan named ${change.file}, which this workspace would not yield to a confined read, so ` +
          'the reviewer was not shown it.',
      );
      continue;
    }
    const text = read.text.replace(/\r\n/g, '\n');
    if (looksBinary(text)) {
      limitations.push(
        `The plan named ${change.file} and it is not text, so its bytes were not sent.`,
      );
      continue;
    }
    const content = defaultRedactor.text(text);
    bytes += Buffer.byteLength(content, 'utf8');
    sent += 1;
    const lines = countLines(content);
    files.push({
      path: change.file,
      origin: 'PLAN',
      reason: change.reason,
      criterionIds: [...change.criterionIds],
      content,
      linesSent: lines,
      totalLines: read.truncated ? null : lines,
      truncated: read.truncated,
    });
  }

  if (sent > 0) {
    limitations.push(
      `Read ${sent} file${sent === 1 ? '' : 's'} the plan named and the patch left untouched, within ` +
        `${MAX_REVIEW_SCOPE_FILE_BYTES} bytes each and ${MAX_REVIEW_SCOPE_TOTAL_BYTES} bytes in all.`,
    );
  }
  return { files, limitations };
}

/**
 * What the manifest builder reads out of a context — named so the manifest can
 * be authored *before* the context carries it, without a type that contains
 * itself.
 */
export interface ReviewMaterialFacts {
  readonly runId: string;
  readonly reviewedPatchIdentity: string;
  readonly files: readonly ReviewPatchFile[];
  readonly skipped: readonly ReviewSkippedFile[];
  readonly scope: readonly ReviewScopeFile[];
  readonly scopeLimitations: readonly string[];
  readonly criteria: readonly ReviewCriterionFact[];
  readonly verification: { readonly gates: readonly ReviewGateFact[] };
}

/**
 * The reference list for an assembled context.
 *
 * Every entry is derived from material that is already on the page, in the order
 * it appears there, so the ids a reviewer can quote and the sections it can quote
 * from are the same list. The numbering is assigned last and only here.
 */
export function buildReviewManifest(
  context: ReviewMaterialFacts,
  contract: RunRecord['contract'],
): ReviewContextManifest {
  const authored: Omit<ReviewReference, 'ref'>[] = [
    ...context.files.map(patchReference),
    ...context.skipped.map(notSentReference),
    ...context.scope.map(scopeReference),
    ...context.criteria.map(criterionReference),
    ...context.verification.gates.map(receiptReference),
    ...policyPaths(contract).map(policyReference),
  ];

  return {
    schemaVersion: REVIEW_MANIFEST_SCHEMA_VERSION,
    runId: context.runId,
    reviewedPatchIdentity: context.reviewedPatchIdentity,
    references: authored.map((entry, index) => ({
      ...entry,
      ref: referenceId(index),
    })),
    limitations: [...context.scopeLimitations],
  };
}

function patchReference(file: ReviewPatchFile): Omit<ReviewReference, 'ref'> {
  const lines = countLines(file.text);
  return {
    kind: 'PATCH',
    path: file.path,
    criterionId: null,
    gateId: null,
    presentation: file.presentation,
    change: file.change,
    linesSent: file.text === '' ? 0 : lines,
    totalLines: file.truncated ? null : lines,
    partial: file.truncated,
    origin: 'PATCH',
    detail: file.reason,
  };
}

function notSentReference(file: ReviewSkippedFile): Omit<ReviewReference, 'ref'> {
  return {
    kind: 'PATCH',
    path: file.path,
    criterionId: null,
    gateId: null,
    presentation: 'NOT_SENT',
    change: null,
    linesSent: 0,
    totalLines: null,
    partial: false,
    origin: 'PATCH',
    detail: `This patch changes the file and the reviewer was given nothing of it: ${file.reason}.`,
  };
}

function scopeReference(file: ReviewScopeFile): Omit<ReviewReference, 'ref'> {
  return {
    kind: 'SOURCE',
    path: file.path,
    criterionId: null,
    gateId: null,
    presentation: 'SOURCE',
    change: null,
    linesSent: file.linesSent,
    totalLines: file.totalLines,
    partial: file.truncated,
    origin: file.origin,
    detail:
      `The plan said it would change this file and the patch does not touch it, so its current ` +
      `bytes were read from the workspace for this review. Plan’s reason: ${file.reason}`,
  };
}

function criterionReference(criterion: ReviewCriterionFact): Omit<ReviewReference, 'ref'> {
  return {
    kind: 'CRITERION',
    path: null,
    criterionId: criterion.id,
    gateId: null,
    presentation: 'LISTED',
    change: null,
    linesSent: 0,
    totalLines: null,
    partial: false,
    origin: 'ACCEPTANCE_CONTRACT',
    detail: `${criterion.id} [${criterion.requirementType}] ${criterion.statement}`,
  };
}

function receiptReference(gate: ReviewGateFact): Omit<ReviewReference, 'ref'> {
  return {
    kind: 'RECEIPT',
    path: null,
    criterionId: null,
    gateId: gate.gateId,
    presentation: 'LISTED',
    change: null,
    linesSent: 0,
    totalLines: null,
    partial: false,
    origin: 'VERIFICATION',
    detail: `${gate.gateId} ran ${gate.argv.join(' ')} and returned ${gate.result} (exit ${gate.exitCode ?? 'null'}).`,
  };
}

function policyReference(relativePath: string): Omit<ReviewReference, 'ref'> {
  return {
    kind: 'POLICY',
    path: relativePath,
    criterionId: null,
    gateId: null,
    presentation: 'LISTED',
    change: null,
    linesSent: 0,
    totalLines: null,
    partial: false,
    origin: 'REPOSITORY_CONTRACT',
    detail:
      'Stage 2 read a rule of this repository from this file. Its contents were not sent to the ' +
      'reviewer, so a finding may name the rule and not the bytes.',
  };
}

/** Where the repository contract got its facts, deduplicated in first-seen order. */
function policyPaths(contract: RunRecord['contract']): string[] {
  if (!contract) return [];
  const found: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value || !isRepositoryRelativePath(value)) return;
    if (!found.includes(value)) found.push(value);
  };
  for (const gate of contract.gates) add(gate.provenance?.file);
  for (const doc of contract.contributionDocs) add(doc.path);
  for (const workflow of contract.ci.workflows) add(workflow.path);
  add(contract.protectedAreas.declaredIn);
  return found;
}

function referenceId(index: number): string {
  return `CTX-${String(index + 1).padStart(3, '0')}`;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

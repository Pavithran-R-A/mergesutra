import type { ReviewContext } from './context.js';
import type { ReviewPatchBinding } from './engine.js';
import { reviewMaterial } from './prompt.js';
import type { ReviewContextManifest, ReviewReference } from './manifest.js';
import {
  findingKey,
  type ReviewDispositionInput,
  type ReviewFindingBody,
  type ReviewSeverity,
} from './schema.js';

/**
 * What MergeSutra does with a finding — Stage 9's contested step.
 *
 * The reviewer files claims; this file decides what they are worth, and every
 * decision is a fact a reader can go and check against the manifest this stage
 * authored: was that reference id issued, does it point at the file the finding
 * names, were that file's bytes actually on the page, and how much of them? A
 * finding that fails one of those is not a gentler finding — it is a sentence with
 * nothing behind it, and routing it into a repair cycle would spend both a bounded
 * cycle and a human's attention.
 *
 * Citation is now the primary bond, and a quotation is only a secondary one. That
 * ordering matters in both directions: a truthful finding whose wording drifts
 * from the page still stands, because it cites material that exists; and a
 * perfectly quoted finding aimed at the wrong file still falls, because the
 * citation is what is checked. A quotation is text, and text survives a
 * re-rendering; a reference is an agreement between two documents.
 *
 * Two things are deliberately *not* decided by the model. It cannot dispose of its
 * own findings (the body schema has no such field), and it cannot choose which
 * files a repair may touch: naming a path buys nothing unless MergeSutra put that
 * path on the page first. The one kind of file a second reader is uniquely placed
 * to catch — the file the patch forgot — is legal ground precisely because the
 * plan named it and the context showed it, not because the reviewer thought of it.
 */

/** Where a finding may not route itself, however serious its author calls it. */
const HUMAN_ONLY_CATEGORIES: readonly ReviewFindingBody['category'][] = [
  'SECURITY',
  'REPOSITORY_POLICY',
  'SCOPE',
  'MAINTAINABILITY',
];

/** Severity gates the *route*, never the record: repair cycles are finite. */
const REPAIR_WORTHY: readonly ReviewSeverity[] = ['BLOCKER', 'HIGH'];

const MINIMUM_SPAN = 3;

/** Which cited reference speaks for a file, when more than one names it. */
const ANCHOR_STRENGTH: Record<ReviewReference['kind'], number> = {
  PATCH: 3,
  SOURCE: 2,
  POLICY: 1,
  CRITERION: 0,
  RECEIPT: 0,
};

export interface WeighFindingsInput {
  readonly context: ReviewContext;
  readonly findings: readonly ReviewFindingBody[];
  /** Whether the patch on disk is still the patch the reviewer was shown. */
  readonly binding: ReviewPatchBinding;
  readonly currentPatchIdentity: string | null;
  /**
   * The manifest the reviewer was given. It is passed in rather than rebuilt
   * because a review's findings describe the material they were weighed against,
   * and a manifest authored after the patch moved would vouch for bytes nobody
   * reviewed.
   */
  readonly manifest?: ReviewContextManifest;
}

export function weighFindings(input: WeighFindingsInput): readonly ReviewDispositionInput[] {
  const facts = collectFacts(input.context, input.manifest ?? input.context.manifest);
  const seen = new Map<string, number>();

  return input.findings.map((finding, index) => ({
    index,
    ...weigh(finding, index, input, facts, seen),
  }));
}

type Verdict = { disposition: ReviewDispositionInput['disposition']; reason: string };

function weigh(
  finding: ReviewFindingBody,
  index: number,
  input: WeighFindingsInput,
  facts: ReviewFacts,
  seen: Map<string, number>,
): Verdict {
  const stale = staleVerdict(input.binding, input.currentPatchIdentity);
  if (stale) return stale;

  if (facts.manifestMismatch) {
    return {
      disposition: 'STALE',
      reason:
        'The references this finding cites were issued for a different patch than the one this ' +
        'context describes, so they name material the reviewer of these bytes was never shown.',
    };
  }

  if (finding.contextRefs.length === 0) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        'It cites no reference from the review manifest. MergeSutra authored the material this ' +
        'review could read and gave each piece an id; a finding that names none cannot be tied ' +
        'to any of it.',
    };
  }

  const unknown = finding.contextRefs.filter((ref) => !facts.byRef.has(ref));
  if (unknown.length > 0) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        `No reference ${unknown.join(', ')} was issued for this review, so this finding cites ` +
        'material that was never on the page.',
    };
  }

  const invented = finding.criterionIds.filter((id) => !facts.criterionIds.has(id));
  if (invented.length > 0) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        `No criterion ${invented.join(', ')} was ever issued for this run, so this finding ` +
        'bears on nothing the contract asks for.',
    };
  }

  const cited = finding.contextRefs.map((ref) => facts.byRef.get(ref)!);
  const anchor = finding.file === undefined ? null : strongestForPath(cited, finding.file);
  if (finding.file !== undefined && anchor === null) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        `None of the references this finding cites points at ${finding.file}; they name ${citeTargets(
          cited,
        )}. A file MergeSutra never put in front of the reviewer cannot become a repair target by ` +
        'being typed into a finding.',
    };
  }

  if (anchor && UNSEEN_CONTENT.has(anchor.presentation)) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        `${anchor.ref} is marked ${anchor.presentation}: this patch changes the file and its ` +
        'content was withheld from the reviewer. A claim about bytes nobody sent is not a finding ' +
        'about them.',
    };
  }

  if (anchor && finding.lineRange && finding.lineRange.to > anchor.linesSent) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        `It cites lines ${finding.lineRange.from}–${finding.lineRange.to} of ${anchor.path}, and ` +
        `${anchor.ref} carried ${anchor.linesSent} line${anchor.linesSent === 1 ? '' : 's'}. What ` +
        'fell past the budget was not sent, so it cannot have been read.',
    };
  }

  const spans = quotedSpans(finding.evidence);
  if (spans.length > 0 && !spans.some((span) => facts.material.includes(span))) {
    return {
      disposition: 'UNSUPPORTED',
      reason:
        'Nothing this finding quotes appears in the material the reviewer was shown, so its ' +
        'evidence cannot have come from reading this patch.',
    };
  }

  const key = findingKey(finding);
  const earlier = seen.get(key);
  if (earlier !== undefined) {
    return {
      disposition: 'DUPLICATE',
      reason:
        `A duplicate of finding ${String(earlier + 1)} in this review: same severity, category, ` +
        'file and statement. Filing it twice does not make it two repairs.',
    };
  }
  seen.set(key, index);

  if (anchor && anchor.kind !== 'PATCH' && finding.criterionIds.length === 0) {
    return {
      disposition: 'OUT_OF_SCOPE',
      reason:
        `This patch does not touch ${anchor.path}, and the finding names no criterion this run ` +
        'owes. An observation about the rest of the repository may well be true, and is not a ' +
        'defect this contribution is answerable for.',
    };
  }

  if (anchor && anchor.kind === 'POLICY') {
    return {
      disposition: 'NEEDS_HUMAN_REVIEW',
      reason:
        `${anchor.ref} names a repository file the Stage 2 contract was read from. Its content was ` +
        'listed, not sent, so this is a question for whoever owns the policy rather than a change ' +
        'a loop could make to bytes it never saw.',
    };
  }

  if (anchor === null) {
    return {
      disposition: 'NEEDS_HUMAN_REVIEW',
      reason:
        'It bears on a criterion and names no file, so there is nothing for a repair to open. A ' +
        'person has to decide which bytes carry the obligation.',
    };
  }

  if (HUMAN_ONLY_CATEGORIES.includes(finding.category)) {
    return {
      disposition: 'NEEDS_HUMAN_REVIEW',
      reason:
        `A ${finding.category.toLowerCase()} claim is a report for a person, not a work order for ` +
        'the loop. MergeSutra has neither confirmed nor dismissed it: it is filed as a model finding ' +
        'against a reviewer’s reading of the material.',
    };
  }

  if (!REPAIR_WORTHY.includes(finding.severity)) {
    return {
      disposition: 'NEEDS_HUMAN_REVIEW',
      reason:
        `A ${finding.severity} finding stays on the record but does not spend a repair cycle; only ` +
        'BLOCKER and HIGH findings route to a repair, and the review and repair bounds are finite.',
    };
  }

  if (!namesItsTarget(finding, anchor)) {
    return {
      disposition: 'NEEDS_HUMAN_REVIEW',
      reason:
        'The proposed action names neither the file the finding cites nor a criterion it carries, ' +
        'so there is nothing to route: a repair plan has to say where the work goes.',
    };
  }

  return {
    disposition: 'VALID_REPAIR_CANDIDATE',
    reason:
      anchor.kind === 'SOURCE'
        ? `Anchored to ${anchor.ref}: the plan named ${anchor.path} and this patch does not touch ` +
          'it, so the omission is the defect. Its current bytes were in the reviewed material, and ' +
          'the criterion it cites is one this run owes.'
        : `Anchored to ${anchor.ref} (${anchor.path}, ${anchor.presentation}), which this patch ` +
          `changes, and quoted from the material the reviewer was shown: ${citeTargets(cited)}.`,
  };
}

/** Presentations whose bytes never reached the page. */
const UNSEEN_CONTENT: ReadonlySet<string> = new Set(['WITHHELD', 'NOT_SENT']);

function staleVerdict(
  binding: ReviewPatchBinding,
  current: string | null,
): { disposition: 'STALE'; reason: string } | null {
  if (binding === 'MATCHED') return null;
  if (binding === 'UNMEASURABLE') {
    return {
      disposition: 'STALE',
      reason:
        'The current patch was not measured after this request, so nothing binds this finding to ' +
        'the bytes now in the workspace. It cannot be treated as a review of them.',
    };
  }
  return {
    disposition: 'STALE',
    reason:
      `The patch on disk changed while this review was running${
        current === null ? '' : ` and is now ${current.slice(0, 12)}…`
      }, so this finding describes a different patch. Only a re-verified review of the current ` +
      'bytes may drive a repair.',
  };
}

interface ReviewFacts {
  readonly byRef: ReadonlyMap<string, ReviewReference>;
  readonly criterionIds: ReadonlySet<string>;
  readonly material: string;
  readonly manifestMismatch: boolean;
}

function collectFacts(context: ReviewContext, manifest: ReviewContextManifest): ReviewFacts {
  return {
    byRef: new Map(manifest.references.map((reference) => [reference.ref, reference])),
    criterionIds: new Set(context.criteria.map((criterion) => criterion.id)),
    material: normalise(reviewMaterial(context)),
    manifestMismatch: manifest.reviewedPatchIdentity !== context.reviewedPatchIdentity,
  };
}

function strongestForPath(cited: readonly ReviewReference[], path: string): ReviewReference | null {
  const matches = cited.filter((reference) => reference.path === path);
  if (matches.length === 0) return null;
  return matches.reduce((best, next) =>
    ANCHOR_STRENGTH[next.kind] > ANCHOR_STRENGTH[best.kind] ? next : best,
  );
}

function citeTargets(cited: readonly ReviewReference[]): string {
  return cited
    .map((reference) =>
      reference.path !== null
        ? `${reference.ref} (${reference.path})`
        : `${reference.ref} (${reference.criterionId ?? reference.gateId})`,
    )
    .join(', ');
}

/**
 * Did this text quote anything at all?
 *
 * A quotation is no longer the bond a finding rests on, so an unquoted finding is
 * not weaker for it. But every span quoted and found nowhere in the material is a
 * sign the finding was written from somewhere else, and that combination of two
 * independent checks — a real citation and a fabricated quotation — still refuses.
 */
function quotedSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]{3,})`|"([^"]{3,})"/g)]
    .map((match) => normalise(match[1] ?? match[2] ?? ''))
    .filter((span) => span.length >= MINIMUM_SPAN);
}

/** Does the action say where the work goes, in the words the manifest allows? */
function namesItsTarget(finding: ReviewFindingBody, anchor: ReviewReference): boolean {
  const action = normalise(finding.proposedAction);
  if (anchor.path !== null && action.includes(normalise(anchor.path))) return true;
  return finding.criterionIds.some((id) => action.includes(id.toLowerCase()));
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

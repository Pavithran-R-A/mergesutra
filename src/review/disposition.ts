import type { ReviewContext } from './context.js';
import type { ReviewPatchBinding } from './engine.js';
import { reviewMaterial } from './prompt.js';
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
 * decision here is a fact a reader can go and check: does this patch touch that
 * file, did this run ever issue that criterion, does that quotation appear in the
 * material the reviewer was shown. A finding that fails one of those is not a
 * gentler finding — it is a sentence with nothing behind it, and routing it into
 * a repair cycle would spend both a bounded cycle and a human's attention.
 *
 * Two things are deliberately *not* decided by the model. It cannot dispose of
 * its own findings (the body schema has no such field), and it cannot reach the
 * repair loop by asserting urgency: severity caps where a finding may go, while
 * every finding still ships in the record for a person to read. A security or
 * policy claim goes to a human whatever its author believes, because a model
 * finding about a risk is a report, not a confirmed defect — and not a refutation
 * either.
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

export interface WeighFindingsInput {
  readonly context: ReviewContext;
  readonly findings: readonly ReviewFindingBody[];
  /** Whether the patch on disk is still the patch the reviewer was shown. */
  readonly binding: ReviewPatchBinding;
  readonly currentPatchIdentity: string | null;
}

export function weighFindings(input: WeighFindingsInput): readonly ReviewDispositionInput[] {
  const facts = collectFacts(input.context);
  const seen = new Map<string, number>();

  return input.findings.map((finding, index) => ({
    index,
    ...weigh(finding, index, input, facts, seen),
  }));
}

function weigh(
  finding: ReviewFindingBody,
  index: number,
  input: WeighFindingsInput,
  facts: ReviewFacts,
  seen: Map<string, number>,
): { disposition: ReviewDispositionInput['disposition']; reason: string } {
  const stale = staleVerdict(input.binding, input.currentPatchIdentity);
  if (stale) return stale;

  if (finding.file !== undefined && !facts.patchPaths.has(finding.file)) {
    return {
      disposition: 'OUT_OF_SCOPE',
      reason:
        `This patch does not touch ${finding.file}. The change under review is the scope of a ` +
        'finding: an observation about the rest of the repository may well be true, and is not a ' +
        'defect in this diff.',
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

  const quoted = quotationOf(finding.evidence, facts);
  if (!quoted.supported) {
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

  if (!quotationOf(finding.proposedAction, facts).supported) {
    return {
      disposition: 'NEEDS_HUMAN_REVIEW',
      reason:
        'The proposed action names no file, criterion, gate or quotation from this run, so there is ' +
        'nothing to route: a repair plan has to say where the work goes.',
    };
  }

  return {
    disposition: 'VALID_REPAIR_CANDIDATE',
    reason:
      `Anchored to ${finding.file ?? 'the criteria it names'} and quoted from the material the ` +
      'reviewer was shown, so the claim can be checked against the run rather than argued about.',
  };
}

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
  readonly patchPaths: ReadonlySet<string>;
  readonly criterionIds: ReadonlySet<string>;
  readonly gateIds: ReadonlySet<string>;
  readonly material: string;
}

function collectFacts(context: ReviewContext): ReviewFacts {
  return {
    patchPaths: new Set([
      ...context.files.map((file) => file.path),
      ...context.skipped.map((file) => file.path),
    ]),
    criterionIds: new Set(context.criteria.map((criterion) => criterion.id)),
    gateIds: new Set(context.verification.gates.map((gate) => gate.gateId)),
    material: normalise(reviewMaterial(context)),
  };
}

/**
 * Did this text quote something the reviewer could have seen?
 *
 * A path, an id, or a span between backticks or double quotes that survives a
 * search of the material. Anything else is an assertion — which is still worth a
 * human reading it, and is not evidence.
 */
function quotationOf(text: string, facts: ReviewFacts): { supported: boolean; because: string } {
  const normalised = normalise(text);
  for (const path of facts.patchPaths) {
    if (normalised.includes(normalise(path))) return { supported: true, because: path };
  }
  for (const id of facts.criterionIds) {
    if (normalised.includes(id.toLowerCase())) return { supported: true, because: id };
  }
  for (const id of facts.gateIds) {
    if (normalised.includes(id.toLowerCase())) return { supported: true, because: id };
  }
  for (const match of text.matchAll(/`([^`]{3,})`|"([^"]{3,})"/g)) {
    const span = normalise(match[1] ?? match[2] ?? '');
    if (span.length >= MINIMUM_SPAN && facts.material.includes(span)) {
      return { supported: true, because: span };
    }
  }
  return { supported: false, because: '' };
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

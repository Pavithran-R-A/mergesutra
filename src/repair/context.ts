import { AppError } from '../core/errors.js';
import { markQuoted, QUOTATION_MARKER } from '../security/prompt-material.js';
import type { RunRecord } from '../state/run-record.js';
import type { GateOutcome } from '../verify/engine.js';
import type { ReviewFinding } from '../review/schema.js';
import type { RepairPlan } from './plan.js';
import { repairPlanDigest } from './digest.js';

/**
 * What a repairer is shown — Stage 9R.
 *
 * Stage 9's review context had to be wide: a reviewer judges an entire patch and
 * needs everything that could bear on it. A repair brief is the opposite
 * instrument, and the reason is safety rather than cost. Every byte handed to the
 * editing model is a byte it can act on, so this ships the frozen plan's findings
 * and nothing else — the criteria those findings name, the receipts the plan says
 * it answers to, and the file list the plan was frozen with. The reviewer's other
 * opinions, its closing summary, the implementation loop's account of its own
 * work, and the rest of the repository stay out, and each omission is written
 * into the document as a choice somebody made and wrote down.
 *
 * The second job is to refuse a pair that does not fit. A plan and a review
 * document are two objects, and a caller could hand this module a plan that was
 * not built from the review it is given — which would put words in the reviewer's
 * mouth and files in a writer's hands that nobody asked for. Every finding id,
 * criterion id and patch digest in the plan is checked against the record before
 * a single line is rendered.
 *
 * Nothing here reads a file, runs a process or reaches a network. What is *shown*
 * is bounded here; what may be *opened* is decided by the loop's confined reader
 * and the plan's file list, which live elsewhere on purpose.
 */

export const REPAIR_CONTEXT_SCHEMA_VERSION = 1;

/**
 * The budget for the quoted material — a finding's text and a gate's output tail.
 *
 * Smaller than Stage 6's context budget and much smaller than Stage 9's review
 * context. The fixed parts (the scope, the file list, the exclusions) sit outside
 * it and are always sent, because dropping one would make the brief less safe
 * rather than shorter.
 */
export const MAX_REPAIR_BRIEF_BYTES = 16 * 1024;

export interface RepairContextLimits {
  readonly maxBytes: number;
}

export const DEFAULT_REPAIR_CONTEXT_LIMITS: RepairContextLimits = {
  maxBytes: MAX_REPAIR_BRIEF_BYTES,
};

export interface RepairFindingBrief {
  readonly findingId: string;
  readonly reviewerSeverity: string;
  readonly reviewerCategory: string;
  readonly reviewerStatement: string;
  readonly reviewerImpact: string;
  readonly reviewerProposedAction: string;
  readonly intendedChange: string;
  readonly criteria: readonly string[];
  readonly files: readonly string[];
  readonly checks: readonly string[];
  /** MergeSutra's reason for keeping this finding in the cycle, not the model's. */
  readonly keptBecause: string;
}

export interface RepairCriterionBrief {
  readonly id: string;
  readonly statement: string;
  readonly requirementType: string;
  /** The status the contract carries, copied. This module changes none of them. */
  readonly contractStatus: string;
  readonly evidenceStatus: string | null;
  readonly gateIds: readonly string[];
  readonly limitations: readonly string[];
}

export interface RepairGateBrief {
  readonly gateId: string;
  readonly argv: readonly string[];
  readonly result: string;
  readonly exitCode: number | null;
  readonly termination: string;
  /** The patch this receipt was taken against — not the one a repair will leave. */
  readonly patchIdentity: string;
  readonly outputSha256: string;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
}

export interface RepairContext {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly reviewCycle: number;
  readonly repairCycle: number;
  readonly repairPlanDigest: string;
  readonly reviewedPatchIdentity: string;
  readonly findings: readonly RepairFindingBrief[];
  readonly criteria: readonly RepairCriterionBrief[];
  readonly gates: readonly RepairGateBrief[];
  /** Checks the plan named that no receipt in this run answers for. */
  readonly unreceiptedChecks: readonly string[];
  /** The only paths a repair may open, straight from the frozen plan. */
  readonly files: readonly string[];
  /** Findings this brief could not fit, named so the omission is not silent. */
  readonly omitted: readonly { findingId: string; reason: string }[];
  readonly limitations: readonly string[];
  /** The rendered brief, with every foreign line marked as quotation. */
  readonly text: string;
  readonly bytes: number;
  readonly markedLines: number;
  readonly limits: RepairContextLimits;
  readonly excluded: readonly string[];
}

export interface AssembleRepairContextInput {
  readonly record: RunRecord;
  readonly plan: RepairPlan;
  readonly limits?: Partial<RepairContextLimits>;
}

/**
 * What a repair brief leaves out, stated inside the brief.
 *
 * A model that is not told what it was not shown will guess at the missing part
 * and write the guess into the patch, so the exclusions travel with the material
 * rather than in a comment beside it.
 */
export const REPAIR_CONTEXT_EXCLUSIONS: readonly string[] = [
  'The reviewer’s summary and any finding this plan did not carry: they describe a patch as a ' +
    'whole, and a cycle has a scope rather than a verdict.',
  'Findings MergeSutra routed to a human, and the criteria they bear on. They are not in this ' +
    'brief, and not in this cycle.',
  'The Stage 6 loop transcript, its action log and its finish claim — one agent’s account of its ' +
    'own work is not evidence for the next one.',
  'Any file outside the list below, and the contents of any file that holds a credential or is ' +
    'not text. That list is a scope, and the writer enforces it.',
  'Every command to run. The gates below are named by id and quoted from a receipt; nothing on ' +
    'this page is a shell line.',
];

export function assembleRepairContext(input: AssembleRepairContextInput): RepairContext {
  const { record, plan } = input;
  const limits = { ...DEFAULT_REPAIR_CONTEXT_LIMITS, ...(input.limits ?? {}) };
  const contract = record.acceptanceContract;
  if (!contract) {
    refusal(
      'Cannot assemble a repair brief: this run has no Acceptance Contract.',
      'A repair must answer to a recorded obligation. Derive the contract first.',
      {},
    );
  }
  const review = record.review;
  if (!review) {
    refusal(
      'Cannot assemble a repair brief: this record carries no review document, so the findings ' +
        'in the plan have no source.',
      'Run `mergesutra review` first. A brief assembled from unreviewed bytes is an instruction.',
      {},
    );
  }
  if (plan.runId !== record.runId) {
    refusal(
      `This plan was frozen for run ${plan.runId}, and the record it is being paired with is ` +
        `${record.runId}. A brief describes one run’s findings, and this plan belongs to another run.`,
      'Re-freeze the plan against this record.',
      { planRunId: plan.runId, recordRunId: record.runId },
    );
  }
  if (review.reviewedPatchIdentity !== plan.reviewedPatchIdentity) {
    refusal(
      `This plan names patch ${plan.reviewedPatchIdentity.slice(0, 12)} and the review on this ` +
        `record read ${review.reviewedPatchIdentity.slice(0, 12)}. A plan and a review that name ` +
        'different bytes are two documents about two changes.',
      'Freeze the plan from the review of the patch that is on disk now.',
      { planPatch: plan.reviewedPatchIdentity, reviewPatch: review.reviewedPatchIdentity },
    );
  }

  const byId = new Map(review.findings.map((finding) => [finding.id, finding]));
  for (const item of plan.findings) {
    const finding = byId.get(item.findingId);
    if (!finding) {
      refusal(
        `Plan finding ${item.findingId} is not in this review document, so nobody filed it.`,
        'A repair may only carry out a complaint somebody actually made against these bytes.',
        { findingId: item.findingId },
      );
    }
    if (finding.disposition !== 'VALID_REPAIR_CANDIDATE') {
      refusal(
        `Plan finding ${item.findingId} carries the disposition ${finding.disposition} in this ` +
          'review, which is not a repair candidate.',
        'A finding routed to a human stays routed. Re-freeze the plan without it.',
        { findingId: item.findingId, disposition: finding.disposition },
      );
    }
  }

  const known = new Set(contract.criteria.map((criterion) => criterion.id));
  const unknown = [
    ...new Set([...plan.criteria, ...plan.findings.flatMap((item) => [...item.criterionIds])]),
  ].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    refusal(
      `This plan answers to ${unknown.join(', ')}, and this run’s Acceptance Contract has no ` +
        'such criterion.',
      'A repair cannot be justified by an obligation the contract never recorded.',
      { unknownCriteria: unknown },
    );
  }

  return render({ record, plan, contract, limits, byId });
}

interface RenderInput {
  readonly record: RunRecord;
  readonly plan: RepairPlan;
  readonly contract: NonNullable<RunRecord['acceptanceContract']>;
  readonly limits: RepairContextLimits;
  readonly byId: Map<string, ReviewFinding>;
}

function render(input: RenderInput): RepairContext {
  const { record, plan, contract, limits, byId } = input;
  const digest = repairPlanDigest(plan);
  const receipts = new Map(
    (record.verification?.gates ?? []).map((outcome) => [outcome.receipt.gateId, outcome]),
  );
  const limitations: string[] = [];
  const omitted: { findingId: string; reason: string }[] = [];
  const findings: RepairFindingBrief[] = [];
  let used = 0;

  for (const item of plan.findings) {
    const finding = byId.get(item.findingId);
    if (!finding) continue;
    const brief: RepairFindingBrief = {
      findingId: item.findingId,
      reviewerSeverity: finding.severity,
      reviewerCategory: finding.category,
      reviewerStatement: finding.statement,
      reviewerImpact: finding.impact,
      reviewerProposedAction: finding.proposedAction,
      intendedChange: item.intendedChange,
      criteria: [...item.criterionIds],
      files: [...item.expectedFiles],
      checks: [...item.expectedChecks],
      keptBecause: finding.dispositionReason,
    };
    const block = Buffer.byteLength(findingBlock(brief), 'utf8');
    if (used + block > limits.maxBytes) {
      omitted.push({
        findingId: item.findingId,
        reason: `the brief budget of ${String(limits.maxBytes)} bytes of quoted material is spent`,
      });
      continue;
    }
    used += block;
    findings.push(brief);
  }

  const named = [...new Set(findings.flatMap((finding) => [...finding.checks]))].sort();
  const gates: RepairGateBrief[] = [];
  const withoutTails: string[] = [];
  const unreceiptedChecks: string[] = [];
  for (const check of named) {
    const outcome = receipts.get(check);
    if (!outcome) {
      unreceiptedChecks.push(check);
      continue;
    }
    gates.push(gateBrief(check, outcome));
    const tails =
      Buffer.byteLength(outcome.receipt.stdoutSummary, 'utf8') +
      Buffer.byteLength(outcome.receipt.stderrSummary, 'utf8');
    if (used + tails > limits.maxBytes) {
      withoutTails.push(check);
      continue;
    }
    used += tails;
  }

  if (omitted.length > 0) {
    limitations.push(
      `This brief sent ${String(findings.length)} of ${String(plan.findings.length)} planned ` +
        `finding(s) and left out ${omitted.map((entry) => entry.findingId).join(', ')} because ` +
        'the brief budget was spent. A finding that was not shown cannot be answered by this ' +
        'cycle, and it is still owed.',
    );
  }
  if (withoutTails.length > 0) {
    limitations.push(
      `The output tails of ${withoutTails.join(', ')} were not sent: the brief budget was spent. ` +
        'The gate rows above still name them, and their recorded result is unchanged.',
    );
  }
  if (unreceiptedChecks.length > 0) {
    limitations.push(
      `The plan answers to ${unreceiptedChecks.join(', ')}, and no receipt in this run carries ` +
        'those ids — nothing ran under them, so nothing here can say what they found.',
    );
  }
  limitations.push(
    `Every receipt on this page was taken against ${
      record.verification?.patchIdentity.slice(0, 12) ?? 'a patch this run never recorded'
    }, which is the patch this cycle exists to change. They are the previous verification’s ` +
      'facts, and an edit here makes them false until Stage 7 runs again.',
  );

  const criteria = criteriaOf(plan, contract, record);
  const text = page({
    plan,
    digest,
    findings,
    criteria,
    gates,
    withoutTails,
    unreceiptedChecks,
    limitations,
  });

  return {
    schemaVersion: REPAIR_CONTEXT_SCHEMA_VERSION,
    runId: record.runId,
    reviewCycle: plan.reviewCycle,
    repairCycle: plan.repairCycle,
    repairPlanDigest: digest,
    reviewedPatchIdentity: plan.reviewedPatchIdentity,
    findings,
    criteria,
    gates,
    unreceiptedChecks,
    files: [...new Set(plan.expectedFiles)],
    omitted,
    limitations,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    markedLines: markedLinesOf(text),
    limits,
    excluded: REPAIR_CONTEXT_EXCLUSIONS,
  };
}

function criteriaOf(
  plan: RepairPlan,
  contract: NonNullable<RunRecord['acceptanceContract']>,
  record: RunRecord,
): RepairCriterionBrief[] {
  const wanted = new Set(plan.criteria);
  return contract.criteria
    .filter((criterion) => wanted.has(criterion.id))
    .map((criterion) => {
      const entry = record.evidence?.criteria.find((item) => item.criterionId === criterion.id);
      return {
        id: criterion.id,
        statement: criterion.statement,
        requirementType: criterion.requirementType,
        contractStatus: criterion.status,
        evidenceStatus: entry ? entry.status : null,
        gateIds: entry ? [...entry.gateIds] : [],
        limitations: [...criterion.limitations, ...(entry ? entry.limitations : [])],
      };
    });
}

function gateBrief(gateId: string, outcome: GateOutcome): RepairGateBrief {
  const receipt = outcome.receipt;
  return {
    gateId,
    argv: [...receipt.argv],
    result: receipt.result,
    exitCode: receipt.exitCode,
    termination: receipt.termination,
    patchIdentity: receipt.patchIdentity,
    outputSha256: receipt.outputSha256,
    stdoutSummary: receipt.stdoutSummary,
    stderrSummary: receipt.stderrSummary,
  };
}

const FINDING_LAYOUT: readonly [label: string, pick: (brief: RepairFindingBrief) => string][] = [
  ['the reviewer says:', (brief) => brief.reviewerStatement],
  ['and why it matters:', (brief) => brief.reviewerImpact],
  ['the reviewer asked for:', (brief) => brief.reviewerProposedAction],
  ['this cycle intends:', (brief) => brief.intendedChange],
  ['MergeSutra kept it because:', (brief) => brief.keptBecause],
];

function findingBlock(brief: RepairFindingBrief): string {
  const lines: string[] = [
    `${brief.findingId} — ${brief.reviewerSeverity} · ${brief.reviewerCategory} ` +
      '(the reviewer’s words; MergeSutra’s routing)',
  ];
  for (const [label, pick] of FINDING_LAYOUT) {
    lines.push(`  ${label}`, quoted(pick(brief), '    '));
  }
  lines.push(
    `  criteria: ${brief.criteria.join(', ')} · files: ${brief.files.join(', ')} · checks: ${
      brief.checks.length > 0 ? brief.checks.join(', ') : 'none named'
    }`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * How many lines of this page are quotation.
 *
 * The shared guard counts markers at column zero; a brief indents its quoted
 * material, because a finding's words sit under the label that introduces them.
 * So the count ignores the indent — an indented quotation is still a quotation,
 * and this number is what a reader checks the page against.
 */
function markedLinesOf(text: string): number {
  return text.split('\n').filter((line) => line.trimStart().startsWith(QUOTATION_MARKER)).length;
}

/**
 * Mark a piece of foreign text so it cannot open a section of its own.
 *
 * The marker only lands on a whole-line rule, which is what makes it a fact about
 * the page rather than decoration: the bytes stay, in order, with the marker in
 * front of the line that would otherwise read as structure.
 */
function quoted(text: string, indent: string): string {
  return markQuoted(text)
    .text.split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

interface PageParts {
  readonly plan: RepairPlan;
  readonly digest: string;
  readonly findings: readonly RepairFindingBrief[];
  readonly criteria: readonly RepairCriterionBrief[];
  readonly gates: readonly RepairGateBrief[];
  readonly withoutTails: readonly string[];
  readonly unreceiptedChecks: readonly string[];
  readonly limitations: readonly string[];
}

function page(parts: PageParts): string {
  const lines: string[] = [];
  lines.push('=== REPAIR SCOPE — frozen before any edit ===');
  lines.push(
    `Plan digest ${parts.digest}. Cycles: review ${String(parts.plan.reviewCycle)}, repair ${String(parts.plan.repairCycle)}.`,
  );
  lines.push(`Measured against patch ${parts.plan.reviewedPatchIdentity}.`);
  lines.push(
    'This is a scope, not a result. Nothing in it says a criterion is met, and the only thing ' +
      'that may answer that is a fresh verification of the bytes this cycle leaves.',
  );
  lines.push('', '=== FINDINGS THIS CYCLE MUST ANSWER ===');
  if (parts.findings.length === 0) lines.push('The budget left no room for any finding.');
  for (const finding of parts.findings) lines.push(findingBlock(finding).trimEnd());
  lines.push('', '=== ACCEPTANCE CRITERIA IN SCOPE ===');
  for (const criterion of parts.criteria) {
    lines.push(
      `- ${criterion.id} (${criterion.requirementType}, contract status ${criterion.contractStatus})`,
    );
    lines.push(quoted(criterion.statement, '    '));
    lines.push(
      `  previous evidence: ${
        criterion.evidenceStatus ?? 'no verification has filed a row for this criterion'
      } · gates credited: ${criterion.gateIds.join(', ') || 'none'}`,
    );
    for (const limitation of criterion.limitations) {
      lines.push(`  limit:`, quoted(limitation, '    '));
    }
  }
  if (parts.criteria.length === 0) lines.push('The plan named no criterion.');
  lines.push('', '=== GATES THIS REPAIR ANSWERS TO (receipts, taken before any edit) ===');
  if (parts.gates.length === 0) lines.push('No receipt was shown for this cycle.');
  for (const gate of parts.gates) {
    lines.push(
      `- ${gate.gateId} \`${gate.argv.join(' ')}\` — recorded ${gate.result}, exit ${String(
        gate.exitCode,
      )}, ${gate.termination}, patch ${gate.patchIdentity.slice(0, 12)}, output ${gate.outputSha256}`,
    );
    if (!parts.withoutTails.includes(gate.gateId)) {
      lines.push('  stdout:', quoted(gate.stdoutSummary, '    '));
      lines.push('  stderr:', quoted(gate.stderrSummary, '    '));
    }
  }
  for (const check of parts.unreceiptedChecks) {
    lines.push(`- ${check} — named by the plan, and no receipt in this run carries that id.`);
  }
  lines.push('', '=== FILES THIS CYCLE MAY CHANGE ===');
  for (const file of parts.plan.expectedFiles) lines.push(`- ${file}`);
  lines.push('No other file is in scope, and the writer refuses one that is not.');
  lines.push('', '=== WHAT THIS BRIEF DOES NOT CLAIM ===');
  for (const exclusion of REPAIR_CONTEXT_EXCLUSIONS) lines.push(`- ${exclusion}`);
  lines.push('', '=== WHAT THIS BRIEF COULD NOT FIT ===');
  for (const limitation of parts.limitations) lines.push(`- ${limitation}`);
  return `${lines.join('\n')}\n`;
}

function refusal(message: string, remediation: string, details: Record<string, unknown>): never {
  throw new AppError({ kind: 'validation', message, remediation, details });
}

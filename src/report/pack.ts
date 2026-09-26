import type { RunRecord } from '../state/run-record.js';

/**
 * The evidence pack: what a reviewer reads without running anything.
 *
 * This module is a renderer, and the distinction is the point. Every status,
 * sufficiency and exit code it prints was written into the run record by the
 * stage that earned it, and the only judgement here is where to put it on the
 * page. A run that has not verified anything therefore cannot acquire a passing
 * row from this file, because there is no row to copy.
 */

export const PACK_FILE_NAMES = ['report.md', 'report.json', 'commands.jsonl'] as const;
export type PackFileName = (typeof PACK_FILE_NAMES)[number];

export interface EvidencePack {
  readonly runId: string;
  readonly files: Readonly<Record<PackFileName, string>>;
}

/** One row per criterion, taken from whichever document actually holds it. */
interface CriterionRow {
  readonly id: string;
  readonly statement: string;
  readonly status: string;
  readonly sufficiency: string;
  readonly gateIds: readonly string[];
  readonly limitations: readonly string[];
}

export function buildEvidencePack(record: RunRecord): EvidencePack {
  const rows = rowsOf(record);
  return {
    runId: record.runId,
    files: {
      'report.md': markdown(record, rows),
      'report.json': `${JSON.stringify(document(record, rows), null, 2)}\n`,
      'commands.jsonl': commandsLog(record),
    },
  };
}

/**
 * Every command the run really started, as its own receipt, one per line.
 *
 * The receipt is written verbatim rather than summarised: it is already the
 * bounded, centrally redacted account of the process, with a digest over the
 * unredacted bytes. Re-encoding it here would put a second version of the same
 * fact on disk and invite the two to disagree.
 */
function commandsLog(record: RunRecord): string {
  return (record.verification?.gates ?? [])
    .map((outcome) => `${JSON.stringify(outcome.receipt)}\n`)
    .join('');
}

function rowsOf(record: RunRecord): CriterionRow[] {
  const evidence = record.evidence;
  if (evidence) {
    return evidence.criteria.map((entry) => ({
      id: entry.criterionId,
      statement: entry.statement,
      status: entry.status,
      sufficiency: entry.sufficiency,
      gateIds: entry.gateIds,
      limitations: entry.limitations,
    }));
  }
  // Before `verify`, the contract's own statuses are the whole truth: they are
  // PENDING because nothing has attached a receipt to them.
  return (record.acceptanceContract?.criteria ?? []).map((criterion) => ({
    id: criterion.id,
    statement: criterion.statement,
    status: criterion.status,
    sufficiency: 'no verification has run',
    gateIds: [],
    limitations: criterion.limitations,
  }));
}

function markdown(record: RunRecord, rows: readonly CriterionRow[]): string {
  const lines: string[] = [];
  lines.push(`# MergeSutra evidence pack — ${record.runId}`);
  lines.push('');
  lines.push(`- Issue: ${record.issueRef?.canonical ?? '(no issue recorded)'}`);
  lines.push(`- Stage: ${record.stage} · Outcome: ${record.outcome}`);
  lines.push(`- Verification: ${record.verification?.result ?? 'none — no gate has run'}`);
  lines.push(
    `- Consent: ${
      record.executionConsent
        ? `operator named ${record.executionConsent.gateIds.join(', ') || 'no gate'}`
        : 'none given — repository commands were not run'
    }`,
  );
  lines.push(
    `- Review: ${
      record.review
        ? `${record.review.findings.length} finding(s) recorded against ${record.review.reviewedPatchIdentity.slice(0, 12)}`
        : 'none recorded — nothing has read these bytes a second time'
    }`,
  );
  lines.push(...patchLines(record));
  lines.push('');
  lines.push(...gatesSection(record));
  lines.push('## Criteria');
  lines.push('');
  if (rows.length === 0) {
    lines.push('This run recorded no acceptance criteria.');
  } else {
    lines.push('| Criterion | Status | Evidence | Gates |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| ${row.id} ${row.statement} | ${row.status} | ${row.sufficiency} | ${
          row.gateIds.length > 0 ? row.gateIds.join(', ') : '—'
        } |`,
      );
    }
  }
  lines.push('');
  lines.push(
    'Every row above is copied from the run record this pack was built from; nothing here adds a verdict. Readiness to contribute is decided by a human at a later stage, and no row in this table means it.',
  );
  lines.push('');
  lines.push(...claimsSection(record));
  lines.push(...reviewSection(record));
  lines.push(...repairSection(record));
  lines.push(...repairCyclesSection(record));
  lines.push(...notesSection(record, rows));
  return lines.join('\n');
}

/**
 * The model's own account, kept in its own box.
 *
 * A reviewer who cannot see what BharatCode claimed cannot check whether the
 * claim was overruled, so the pack prints it — under a heading that says the
 * statuses above it came from exit codes instead.
 */
function claimsSection(record: RunRecord): string[] {
  const claims = record.evidence?.claims ?? [];
  if (claims.length === 0) return [];
  const lines: string[] = [
    '## What the model said about its own work (a claim; decided nothing)',
    '',
  ];
  for (const claim of claims) lines.push(`- ${claim.source}: ${claim.text}`);
  lines.push('');
  return lines;
}

/**
 * The qualifier a green row cannot carry by itself.
 *
 * Staleness, a gate that never ran, and a criterion that only partly reached its
 * plan all live in `notes` and per-criterion `limitations` — documents the
 * mapper writes and nothing else reads. Dropping them here would leave a pack
 * that reports a stale receipt as though it still described the workspace.
 *
 * What they may not do is arrive as one undifferentiated list. A run's
 * `limitations` field is append-only: each stage carries the previous record's
 * lines and adds its own, so by the verify stage the list contains sentences
 * that were true of a stage that had no receipts yet. The pack cannot delete
 * those — deciding which caveat a later stage answered is not a renderer's
 * call — so it prints each group under the name of the document that wrote it.
 */
function caveatGroups(
  record: RunRecord,
  rows: readonly CriterionRow[],
): readonly { heading: string; notes: string[] }[] {
  const seen = new Set<string>();
  // A criterion's own limitations belong to whoever wrote its row: the mapper,
  // once `verify` has filed evidence, and the contract before that.
  const groups = [
    {
      heading: 'From the evidence mapper, about the rows above:',
      notes: record.evidence
        ? [...record.evidence.notes, ...rows.flatMap((row) => row.limitations)]
        : [],
    },
    {
      heading: 'Recorded by the stages of this run, oldest first:',
      notes: [...record.limitations],
    },
    {
      heading: 'Recorded with the Acceptance Contract:',
      notes: record.evidence
        ? [...(record.acceptanceContract?.limitations ?? [])]
        : [
            ...rows.flatMap((row) => row.limitations),
            ...(record.acceptanceContract?.limitations ?? []),
          ],
    },
  ];

  return groups
    .map((group) => ({
      ...group,
      notes: group.notes.filter((note) => {
        if (seen.has(note)) return false;
        seen.add(note);
        return true;
      }),
    }))
    .filter((group) => group.notes.length > 0);
}

function notesSection(record: RunRecord, rows: readonly CriterionRow[]): string[] {
  const groups = caveatGroups(record, rows);
  if (groups.length === 0) return [];
  const lines: string[] = ['## What these rows do not claim', ''];
  for (const group of groups) {
    lines.push(group.heading, '');
    for (const note of group.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines;
}

/**
 * Which bytes the evidence describes, in a form a reader can check with git.
 *
 * A pack that reports `exit 0` without naming the patch it was measured on is
 * unfalsifiable: after a repair the old rows are false, and nothing on the page
 * says so. So the digest Stage 7 planned against and the digest the engine
 * actually observed are printed side by side, with the engine's own precondition
 * word between them. This adds no judgement — `STALE` is written by
 * `runVerification`, and a run with no plan has no digest to name.
 */
function patchLines(record: RunRecord): string[] {
  const planned = record.verificationPlan?.patchIdentity ?? null;
  if (planned === null) {
    return [
      '- Patch: no patch identity — this run planned no gate, so its rows are pinned to no measured bytes',
    ];
  }
  const precondition = record.verification?.patchPrecondition ?? null;
  return [
    `- Patch: ${planned} (base ${record.verificationPlan?.baseSha})${
      precondition
        ? ` · observed ${precondition.observedIdentity ?? 'not re-measured'} · ${precondition.status}`
        : ' · no verification has run against it'
    }`,
  ];
}

/**
 * The second pass over these bytes, printed as a reading rather than a ruling.
 *
 * Stage 9 exists because a green gate table cannot say whether the change is the
 * one the contract asked for. That makes the review the most abusable paragraph in
 * the pack — the one a reader is most tempted to treat as a sign-off — so the
 * heading says what it is, each finding is printed with the disposition MergeSutra
 * assigned rather than the severity the model chose, and a patch with no review
 * says so plainly instead of leaving the section out and letting silence look
 * like approval.
 */
function reviewSection(record: RunRecord): string[] {
  const review = record.review;
  if (!review) return [];
  const lines: string[] = [
    "## Review — a second reading of these bytes (a model's account; it decided nothing)",
    '',
    `- Reviewed patch: ${review.reviewedPatchIdentity} · current ${review.currentPatchIdentity} · ${review.patchPrecondition.status}`,
    `- Asked of \`${review.modelId}\` on ${review.reviewedAt} (attempt ${review.attempts})`,
    '',
    review.summary,
    '',
  ];
  if (review.findings.length === 0) {
    lines.push(
      'The reviewer filed no findings. That is not the same claim as "there are none".',
      '',
    );
    return lines;
  }
  lines.push("| Finding | Severity | Category | MergeSutra's disposition | Why |");
  lines.push('| --- | --- | --- | --- | --- |');
  for (const finding of review.findings) {
    lines.push(
      `| ${finding.id} ${finding.statement} | ${finding.severity} | ${finding.category} | ${
        finding.disposition
      } | ${finding.dispositionReason} |`,
    );
  }
  lines.push('');
  lines.push('What the reviewer proposed (its words; a repair plan is a separate document):');
  lines.push('');
  for (const finding of review.findings) {
    lines.push(`- ${finding.id}: ${finding.proposedAction}`);
  }
  lines.push('');
  return lines;
}
/**
 * The work order, and what it was frozen against.
 *
 * A repair plan names files and gate ids, never commands, so printing it cannot
 * hand a reader a shell string to run. What this section is for is the comparison
 * a reviewer needs: the plan says which files were meant to change, and Stage 7's
 * receipts say what the patch actually is now.
 */
function repairSection(record: RunRecord): string[] {
  const plan = record.repairPlan;
  if (!plan) return [];
  const lines: string[] = [
    '## Repair plan (frozen before any edit; a scope, not a result)',
    '',
    `- Cycle ${plan.reviewCycle} review / ${plan.repairCycle} repair, against patch ${plan.reviewedPatchIdentity}.`,
    `- Files it may change: ${plan.expectedFiles.join(', ')}`,
    `- Gates it answers to: ${plan.expectedChecks.length > 0 ? plan.expectedChecks.join(', ') : 'none named'}`,
    '',
  ];
  for (const item of plan.findings) {
    lines.push(`- ${item.findingId}: ${item.intendedChange}`);
  }
  lines.push('');
  lines.push(
    'What this cycle achieved is not decided here. It is decided by verifying the bytes that are on disk now.',
  );
  lines.push('');
  return lines;
}

/**
 * The cycles that have already moved these bytes, and what each one did to the rows above.
 *
 * A pack becomes misleading the moment a repair runs on the run it describes: the
 * criteria table is then a report about patch A, the workspace is on B, and every
 * statement in the file reads in the present tense. So each cycle is printed with
 * both digests, the plan it answered to, and — in the same line as the digest it
 * replaced — whether the earlier receipts still describe anything. That clause is
 * `patchChanged` from Stage 9's scope guard, not this renderer's opinion, and a
 * cycle that moved no bytes does not get one: an edit that left no trace has not
 * invalidated any evidence, and saying it had would be a different lie in the
 * opposite direction.
 *
 * What the section is not for is a result. It records that files were edited under
 * a human-approved scope; whether the edit satisfied a criterion is answered only
 * by a verification measured after it, which is the table at the top of this page.
 */
function repairCyclesSection(record: RunRecord): string[] {
  const executions = record.repairExecutions;
  if (executions.length === 0) return [];
  const lines: string[] = [
    '## Repair cycles (edits that happened, not outcomes that were reached)',
    '',
  ];
  // The rows above this section describe one patch, and the evidence document is
  // the only thing in the record that says which.
  const measuredIdentity = record.evidence?.patchIdentity ?? null;
  for (const execution of executions) {
    lines.push(
      `- Repair cycle ${execution.repairCycle} of review ${execution.reviewCycle} · plan ${execution.planDigest} · patch ${execution.patchBeforeIdentity} → ${execution.patchAfterIdentity} · ${execution.scope.outcome} · ${consequenceOf(execution, measuredIdentity)}`,
    );
  }
  lines.push('');
  lines.push(
    'A cycle is a record of what was changed under an approved scope. The only answer to whether a change worked is a verification measured on the bytes it left, and the rows at the top of this pack say which bytes those are.',
  );
  lines.push('');
  return lines;
}

/**
 * Whether a cycle left the evidence above describing the workspace.
 *
 * Three clauses, and the middle one is why this function takes a second argument
 * at all: a pack regenerated after a re-verification has receipts measured on the
 * repaired bytes, so calling them stale would retire the exact distinction §19
 * exists to expose — green and stale are different claims, and a renderer that
 * used `stale` loosely would say a re-verification never happened.
 *
 * Which bytes the rows describe is not this renderer's guess. It is the identity
 * the evidence document carries, and an absent document means absent rows, so the
 * only sentence left is that the cycle moved bytes nothing above has measured.
 */
function consequenceOf(
  execution: RunRecord['repairExecutions'][number],
  measuredIdentity: string | null,
): string {
  if (!execution.patchChanged) {
    return 'the cycle left the patch unchanged, so nothing above changed status because of it';
  }
  if (measuredIdentity === execution.patchAfterIdentity) {
    return 'the rows above were measured again on these bytes after this cycle moved them';
  }
  return `the rows above were measured on ${measuredIdentity ?? 'no patch this pack carries receipts for'} and are stale for these bytes; only a re-verification can make them current`;
}

function gatesSection(record: RunRecord): string[] {
  const outcomes = record.verification?.gates ?? [];
  const lines: string[] = ['## Gates', ''];
  if (outcomes.length === 0) {
    lines.push('No gate has run for this run, so no command below has an exit code.');
    lines.push('');
    return lines;
  }
  lines.push('| Gate | Command | Exit | Result |');
  lines.push('| --- | --- | --- | --- |');
  for (const outcome of outcomes) {
    const receipt = outcome.receipt;
    lines.push(
      `| ${receipt.gateId} | ${receipt.argv.join(' ')} | ${
        receipt.exitCode === null ? 'did not run' : `exit ${receipt.exitCode}`
      } | ${receipt.result} |`,
    );
  }
  lines.push('');
  return lines;
}

function document(record: RunRecord, rows: readonly CriterionRow[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: record.runId,
    createdAt: record.createdAt,
    stage: record.stage,
    outcome: record.outcome,
    nextStage: record.nextStage,
    issue: record.issueRef?.canonical ?? null,
    patch: {
      plannedIdentity: record.verificationPlan?.patchIdentity ?? null,
      observedIdentity: record.verification?.patchPrecondition.observedIdentity ?? null,
      precondition: record.verification?.patchPrecondition.status ?? null,
      baseSha: record.verificationPlan?.baseSha ?? null,
    },
    verification: record.verification?.result ?? null,
    contributionReady: false,
    criteria: rows.map((row) => ({ ...row })),
    verificationPlan: record.verificationPlan,
    executionConsent: record.executionConsent,
    evidence: record.evidence,
    // Copied whole, and kept apart from the rows above: these two are a model's
    // reading and a scope frozen before an edit, and neither is evidence of
    // anything. Flattening them into the criteria table would make a finding read
    // as a verdict.
    review: record.review,
    repairPlan: record.repairPlan,
    // In order, and as written by the cycles themselves: which patch each one
    // started from and which it left, so a reader can tell whether the rows above
    // describe the bytes still on disk. Nothing here is derived from them — a
    // verdict would have to come from a verification, and this array is a record
    // of edits.
    repairExecutions: [...record.repairExecutions],
    // Kept apart because they mean different things: the first is what the
    // stages of this run accumulated, carrying earlier lines forward as it
    // grew; the second is what the contract itself could not see. Merged,
    // neither can be checked against the document that wrote it.
    stageLimitations: [...record.limitations],
    contractLimitations: [...(record.acceptanceContract?.limitations ?? [])],
  };
}

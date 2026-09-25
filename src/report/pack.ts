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
    verification: record.verification?.result ?? null,
    contributionReady: false,
    criteria: rows.map((row) => ({ ...row })),
    verificationPlan: record.verificationPlan,
    executionConsent: record.executionConsent,
    evidence: record.evidence,
    // Kept apart because they mean different things: the first is what the
    // stages of this run accumulated, carrying earlier lines forward as it
    // grew; the second is what the contract itself could not see. Merged,
    // neither can be checked against the document that wrote it.
    stageLimitations: [...record.limitations],
    contractLimitations: [...(record.acceptanceContract?.limitations ?? [])],
  };
}
